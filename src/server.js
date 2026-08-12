const express = require('express');
const helmet = require('helmet');
const path = require('path');
const multer = require('multer');
const pdfRedactor = require('./services/pdf-redactor');

const app = express();
const PORT = process.env.PORT || 3057;

// The app is deployed behind a single reverse proxy. With trust proxy = 1,
// Express derives req.ip from the address supplied by that proxy (the hop
// closest to the application), so a forged left-most X-Forwarded-For value
// cannot affect the rate-limit key.
app.set('trust proxy', 1);

// The redaction engine accepts 'text', 'blackout' and 'blackbox'
// ('blackbox' is an alias for 'blackout' used by the UI radio button).
const ALLOWED_STYLES = new Set(['text', 'blackout', 'blackbox']);
const PDF_MAGIC = Buffer.from('%PDF-');

// Verify the uploaded bytes actually start with the PDF file signature,
// not just the client-supplied Content-Type or filename.
function isPdfBuffer(buffer) {
  return buffer && buffer.length >= PDF_MAGIC.length && buffer.slice(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

function createRateLimiter({ windowMs, maxRequests, maxTracked }) {
  const hits = new Map();

  // Periodically drop stale entries to keep memory bounded.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits) {
      while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length === 0) hits.delete(ip);
    }
  }, windowMs).unref();

  return function rateLimiter(req, res, next) {
    try {
      const ip = req.ip;
      if (!ip) {
        // Fail-closed: if we cannot determine the client address, the limiter
        // cannot evaluate the request. 503 is the honest status for that state.
        return res.status(503).json({ error: 'Rate limiter unavailable' });
      }

      const now = Date.now();
      const cutoff = now - windowMs;
      let timestamps = hits.get(ip);
      if (timestamps) {
        while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
        if (timestamps.length === 0) {
          hits.delete(ip);
          timestamps = undefined;
        }
      }

      // Fail-closed on address-capacity exhaustion: a rotating-IP attacker
      // (trivial with IPv6) could otherwise grow this map faster than the
      // cleanup prunes it. Existing tracked addresses keep working; new
      // addresses are denied once the cap is hit.
      if (!timestamps && hits.size >= maxTracked) {
        return res.status(429).json({ error: 'Rate limiter at capacity' });
      }

      if (!timestamps) timestamps = [];

      if (timestamps.length >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }

      timestamps.push(now);
      hits.set(ip, timestamps);
      next();
    } catch (err) {
      // Fail-closed: log only the internal limiter error (no request content),
      // then deny the request. 503 accurately reports that evaluation failed.
      console.error('Rate limiter error:', err.message || err);
      return res.status(503).json({ error: 'Rate limiter unavailable' });
    }
  };
}

// PDF analysis/redaction spawn Python processes and are unauthenticated.
// Cap each IP at 20 requests per 15 minutes across both endpoints, and cap
// the total number of tracked addresses to limit memory use under a
// rotating-IP attack. This complements the 5-concurrent-session and 10MB
// upload limits.
const pdfRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 20, maxTracked: 10000 });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: pdfRedactor.MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' && file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid PDF upload'));
    }
  }
});

// Security headers. default-src 'self' covers the end state where session 4
// has moved all JS/CSS into separate files and removed the Google Fonts link,
// so the page makes no third-party requests. No 'unsafe-inline' is allowed.
// upgrade-insecure-requests is only applied in production; it would break the
// README's plain-HTTP local development flow by trying to load same-origin
// resources over HTTPS.
const isProduction = process.env.NODE_ENV === 'production';
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'"],
  fontSrc: ["'self'"],
  imgSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"]
};
if (isProduction) cspDirectives.upgradeInsecureRequests = [];

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: cspDirectives
  },
  hsts: {
    maxAge: 15552000,
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false
}));

// Liveness probe with no sensitive detail.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Public PDF status endpoint.
app.get('/api/pdf/status', (req, res) => {
  res.json(pdfRedactor.getStatus());
});

// Process and redact PDF - public endpoint.
app.post('/api/pdf/redact', pdfRateLimiter, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file || !isPdfBuffer(req.file.buffer)) {
      return res.status(400).json({ error: 'Invalid PDF file' });
    }

    if (!pdfRedactor.canAcceptSession()) {
      return res.status(503).json({
        error: 'Server busy - maximum concurrent sessions reached',
        status: pdfRedactor.getStatus()
      });
    }

    if (req.body.style && !ALLOWED_STYLES.has(req.body.style)) {
      return res.status(400).json({ error: 'Invalid redaction style' });
    }
    const style = ALLOWED_STYLES.has(req.body.style) ? req.body.style : 'text';

    const result = await pdfRedactor.processPdf(req.file.buffer, style);
    req.file.buffer = null;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="redacted.pdf"');
    res.setHeader('X-Detections-Count', result.detections.length);
    res.setHeader('X-Original-Pages', result.originalPageCount);
    res.setHeader('X-Has-Unchecked-Pages', result.hasUncheckedPages ? 'true' : 'false');
    res.setHeader('X-Pages-Without-Text', JSON.stringify(result.pagesWithoutText || []));
    res.send(result.pdfBuffer);

    result.pdfBuffer = null;
  } catch (error) {
    // Server-side only: log the error for debugging. Never expose internal
    // detail to the client and never log file contents or detected values.
    console.error('PDF redaction error:', error.message || error);
    res.status(500).json({ error: 'PDF processing failed' });
  }
});

// Process PDF and return JSON analysis (with base64 download) - public endpoint.
app.post('/api/pdf/analyze', pdfRateLimiter, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file || !isPdfBuffer(req.file.buffer)) {
      return res.status(400).json({ error: 'Invalid PDF file' });
    }

    if (!pdfRedactor.canAcceptSession()) {
      return res.status(503).json({
        error: 'Server busy - maximum concurrent sessions reached',
        status: pdfRedactor.getStatus()
      });
    }

    if (req.body.style && !ALLOWED_STYLES.has(req.body.style)) {
      return res.status(400).json({ error: 'Invalid redaction style' });
    }
    const style = ALLOWED_STYLES.has(req.body.style) ? req.body.style : 'text';

    const result = await pdfRedactor.processPdf(req.file.buffer, style);
    req.file.buffer = null;

    const pdfBase64 = result.pdfBuffer.toString('base64');
    result.pdfBuffer = null;

    res.json({
      success: true,
      originalPageCount: result.originalPageCount,
      newPageCount: result.newPageCount,
      detections: result.detections,
      pagesWithoutText: result.pagesWithoutText || [],
      uncheckedPages: result.pagesWithoutText || [],
      hasUncheckedPages: Boolean(result.hasUncheckedPages),
      charCount: result.charCount,
      redactedCharCount: result.redactedCharCount,
      pdfBase64: pdfBase64
    });
  } catch (error) {
    console.error('PDF analysis error:', error.message || error);
    res.status(500).json({ error: 'PDF processing failed' });
  }
});

// Error handler for multer and other unexpected errors.
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ error: 'File upload error' });
  }
  if (error.message === 'Invalid PDF upload') {
    return res.status(400).json({ error: 'Only PDF files are allowed' });
  }
  console.error('Unhandled error:', error.message || error);
  res.status(500).json({ error: 'Internal server error' });
});

app.use(express.static(path.join(__dirname, '../public')));

// Anything not matched (including removed legacy routes) returns 404.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const server = app.listen(PORT, () => {
  // OK: only the listening port is logged; no request data or PII.
  console.log(`Scrambler server listening on port ${PORT}`);
});

module.exports = { app, server };
