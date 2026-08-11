require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const path = require('path');
const multer = require('multer');
const db = require('./services/database');
const pdfRedactor = require('./services/pdf-redactor');

const app = express();
const PORT = process.env.PORT || 3057;

app.set('trust proxy', 1);

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL || 'scott@scottschlangen.com';
const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
const BASE_URL = process.env.BASE_URL || 'https://scramble.scottslab.io';

// Multer config - memory storage only (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: pdfRedactor.MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], fontSrc: ["'self'", "https://fonts.gstatic.com"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"], imgSrc: ["'self'", "data:"] }}}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: `${BASE_URL}/auth/google/callback` },
  (a, r, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (email?.toLowerCase() !== ALLOWED_EMAIL.toLowerCase()) return done(null, false);
    return done(null, { id: profile.id, email, name: profile.displayName });
  }
));

if (process.env.BREAKGLASS_USER && process.env.BREAKGLASS_HASH) {
  passport.use(new LocalStrategy(async (username, password, done) => {
    if (username !== process.env.BREAKGLASS_USER) return done(null, false);
    if (!(await bcrypt.compare(password, process.env.BREAKGLASS_HASH))) return done(null, false);
    return done(null, { id: 'breakglass', email: 'admin@local', name: 'Admin' });
  }));
}

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  // Return JSON for API calls (XHR, JSON accept, or multipart uploads)
  if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
};

// Auth routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login?error=1' }), (req, res) => res.redirect('/'));
app.post('/auth/login', passport.authenticate('local', { failureRedirect: '/login?error=1' }), (req, res) => res.redirect('/'));
app.post('/auth/logout', (req, res) => { req.logout(() => res.json({ success: true })); });
app.get('/login', (req, res) => { if (req.isAuthenticated()) return res.redirect('/'); res.sendFile(path.join(__dirname, '../public/login.html')); });

// Text API routes
app.post('/api/mask', requireAuth, (req, res) => {
  const { text, sessionId } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const result = db.autoMask(req.user.id, sessionId || 'default', text);
  res.json(result);
});

app.post('/api/unmask', requireAuth, (req, res) => {
  const { text, sessionId } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const result = db.unmask(req.user.id, sessionId || 'default', text);
  res.json(result);
});

app.post('/api/mappings/add', requireAuth, (req, res) => {
  const { original, type, sessionId } = req.body;
  if (!original) return res.status(400).json({ error: 'Original value required' });
  const mapping = db.addManualMapping(req.user.id, sessionId || 'default', original, type || 'text');
  res.json(mapping);
});

app.get('/api/mappings', requireAuth, (req, res) => {
  const { sessionId } = req.query;
  res.json(db.getMappings(req.user.id, sessionId));
});

app.delete('/api/mappings/:id', requireAuth, (req, res) => {
  const deleted = db.deleteMapping(req.user.id, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.delete('/api/session/:sessionId', requireAuth, (req, res) => {
  const count = db.clearSession(req.user.id, req.params.sessionId);
  res.json({ success: true, deleted: count });
});

// ============ PDF REDACTION ROUTES ============

// Get PDF redaction status (available slots) - public endpoint
app.get('/api/pdf/status', (req, res) => {
  res.json(pdfRedactor.getStatus());
});

// Process and redact PDF - public endpoint
app.post('/api/pdf/redact', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }
    
    // Check if slots available
    if (!pdfRedactor.canAcceptSession()) {
      return res.status(503).json({ 
        error: 'Server busy - maximum concurrent sessions reached',
        status: pdfRedactor.getStatus()
      });
    }
    
    // Get style from form data (default: text)
    const style = req.body.style || 'text';
    
    // Process the PDF
    const result = await pdfRedactor.processPdf(req.file.buffer, style);
    
    // Clear the buffer immediately
    req.file.buffer = null;
    
    // Send redacted PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="redacted-${Date.now()}.pdf"`);
    res.setHeader('X-Detections-Count', result.detections.length);
    res.setHeader('X-Original-Pages', result.originalPageCount);
    res.send(result.pdfBuffer);
    
    // Clear result buffer
    result.pdfBuffer = null;
    
  } catch (error) {
    console.error('PDF processing error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Process PDF and return JSON with preview (for UI) - public endpoint
app.post('/api/pdf/analyze', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }
    
    if (!pdfRedactor.canAcceptSession()) {
      return res.status(503).json({ 
        error: 'Server busy - maximum concurrent sessions reached',
        status: pdfRedactor.getStatus()
      });
    }
    
    // Get style from form data (default: text)
    const style = req.body.style || 'text';
    
    const result = await pdfRedactor.processPdf(req.file.buffer, style);
    
    // Clear buffers
    req.file.buffer = null;
    
    // Return analysis without the full PDF (just base64 for download)
    const pdfBase64 = result.pdfBuffer.toString('base64');
    result.pdfBuffer = null;
    
    res.json({
      success: true,
      originalPageCount: result.originalPageCount,
      newPageCount: result.newPageCount,
      detections: result.detections,
      charCount: result.charCount,
      redactedCharCount: result.redactedCharCount,
      pdfBase64: pdfBase64
    });
    
  } catch (error) {
    console.error('PDF analysis error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Error handler for multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ error: error.message });
  }
  if (error.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: error.message });
  }
  next(error);
});

app.use(express.static(path.join(__dirname, '../public')));

app.listen(PORT, () => console.log(`Scrambler running on port ${PORT}`));
