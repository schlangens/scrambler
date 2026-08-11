/**
 * PDF Redactor Service
 *
 * This module redacts PDFs without ever writing them to disk.  It spawns a
 * Python process and streams the PDF on the child's stdin, then reads the
 * redacted PDF back from stdout using an 8-byte, big-endian, length-prefixed
 * framing protocol.
 *
 * Public interface (must stay byte-identical for callers):
 *   processPdf(pdfBuffer, style)
 *   getStatus()
 *   canAcceptSession()
 *   MAX_CONCURRENT
 *   MAX_FILE_SIZE
 */

const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const REDACT_SCRIPT = path.join(__dirname, "redact.py");

// Active sessions tracker (max 5 concurrent)
const activeSessions = new Map();
const MAX_CONCURRENT = 5;
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PROCESS_TIMEOUT = parseInt(
  process.env.SCRAMBLER_REDACT_TIMEOUT_MS,
  10
) || 60000; // 60 seconds

const ALLOWED_STYLES = new Set(["text", "blackout"]);

/**
 * Clean up expired sessions.
 */
function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of activeSessions) {
    if (now - session.startTime > SESSION_TIMEOUT) {
      activeSessions.delete(id);
    }
  }
}

/**
 * Check if we can accept a new session.
 */
function canAcceptSession() {
  cleanupSessions();
  return activeSessions.size < MAX_CONCURRENT;
}

/**
 * Create a processing session.  Returns a session id or null if at capacity.
 */
function createSession() {
  cleanupSessions();
  if (activeSessions.size >= MAX_CONCURRENT) {
    return null;
  }
  const sessionId = `pdf-${Date.now()}-${crypto
    .randomBytes(8)
    .toString("hex")}`;
  activeSessions.set(sessionId, { startTime: Date.now() });
  return sessionId;
}

/**
 * End a processing session.
 */
function endSession(sessionId) {
  if (sessionId) {
    activeSessions.delete(sessionId);
  }
}

/**
 * Verify that the buffer begins with the PDF magic bytes.
 */
function isValidPdf(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer.slice(0, 4).toString("latin1") === "%PDF"
  );
}

/**
 * Parse the 8-byte length-prefixed response from the Python redactor:
 *
 *   [ 8 bytes: redacted PDF length M ] [ M bytes: redacted PDF ]
 *   [ 8 bytes: JSON metadata length K ] [ K bytes: JSON metadata ]
 */
function parseFramedResponse(buffer) {
  if (buffer.length < 8) {
    throw new Error("Redactor response too short");
  }

  let offset = 0;

  const pdfLen = Number(buffer.readBigUInt64BE(offset));
  offset += 8;
  if (offset + pdfLen > buffer.length) {
    throw new Error("Truncated PDF in redactor response");
  }
  const pdfBuffer = buffer.slice(offset, offset + pdfLen);
  offset += pdfLen;

  if (buffer.length < offset + 8) {
    throw new Error("Missing metadata length in redactor response");
  }
  const metaLen = Number(buffer.readBigUInt64BE(offset));
  offset += 8;
  if (offset + metaLen > buffer.length) {
    throw new Error("Truncated metadata in redactor response");
  }
  const metaBuffer = buffer.slice(offset, offset + metaLen);

  return { pdfBuffer, meta: JSON.parse(metaBuffer.toString("utf-8")) };
}

/**
 * Run the Python redactor in a child process, streaming the PDF in and the
 * redacted PDF + metadata out.  No shell is used, no files are written,
 * and the child is killed on timeout.
 */
function runPythonRedactor(pdfBuffer, style) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [REDACT_SCRIPT, style], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    // Swallow stdin errors (e.g. EPIPE) - the close handler will surface the
    // real failure or timeout and avoid an unhandled exception.
    child.stdin.on("error", () => {});

    // Stderr is ignored to avoid accidentally logging PII.  Python writes
    // all structured output (including errors) to stdout using the framing
    // protocol.  Unexpected stderr content is not surfaced to the user.

    const inputHeader = Buffer.alloc(8);
    inputHeader.writeBigUInt64BE(BigInt(pdfBuffer.length));
    child.stdin.end(Buffer.concat([inputHeader, pdfBuffer]));

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROCESS_TIMEOUT);

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to start redactor: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);

      if (timedOut) {
        const seconds = Math.ceil(PROCESS_TIMEOUT / 1000);
        reject(new Error(`PDF processing timed out after ${seconds} seconds`));
        return;
      }
      if (signal) {
        reject(new Error(`PDF redactor terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`PDF redactor failed with exit code ${code}`));
        return;
      }

      try {
        const response = parseFramedResponse(Buffer.concat(stdoutChunks));

        if (response.meta && response.meta.error) {
          reject(new Error(response.meta.error));
          return;
        }
        if (!response.pdfBuffer || response.pdfBuffer.length === 0) {
          reject(new Error("Redacted PDF was not produced"));
          return;
        }

        resolve(response);
      } catch (parseErr) {
        reject(new Error(`Invalid redactor response: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Process PDF: apply true redactions using PyMuPDF.
 *
 * The PDF is never written to disk.  Input is validated by magic bytes and
 * the redactor process runs with a strict timeout and concurrency cap.
 */
async function processPdf(pdfBuffer, style = "text") {
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error("Invalid PDF buffer");
  }
  if (pdfBuffer.length > MAX_FILE_SIZE) {
    throw new Error(
      `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }
  if (!isValidPdf(pdfBuffer)) {
    throw new Error("File does not appear to be a valid PDF");
  }

  const cleanStyle = ALLOWED_STYLES.has(style) ? style : "text";

  const sessionId = createSession();
  if (!sessionId) {
    throw new Error(
      "Server busy - maximum 5 concurrent sessions. Please try again in a moment."
    );
  }

  try {
    const response = await runPythonRedactor(pdfBuffer, cleanStyle);

    return {
      pdfBuffer: response.pdfBuffer,
      originalPageCount: response.meta.originalPageCount,
      newPageCount: response.meta.newPageCount,
      detections: response.meta.detections || [],
      charCount: response.meta.charCount,
      redactedCharCount: response.meta.redactedCharCount,
      style: cleanStyle,
      sessionId,
    };
  } finally {
    endSession(sessionId);
  }
}

/**
 * Get current session status.
 */
function getStatus() {
  cleanupSessions();
  return {
    activeSessions: activeSessions.size,
    maxSessions: MAX_CONCURRENT,
    available: MAX_CONCURRENT - activeSessions.size,
    maxFileSizeMB: MAX_FILE_SIZE / 1024 / 1024,
  };
}

module.exports = {
  processPdf,
  getStatus,
  canAcceptSession,
  MAX_CONCURRENT,
  MAX_FILE_SIZE,
};
