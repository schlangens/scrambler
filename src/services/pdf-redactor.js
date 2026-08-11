/**
 * PDF Redactor Service
 * Uses PyMuPDF for true redaction that preserves original layout
 * NO permanent storage - completely ephemeral
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Active sessions tracker (max 5 concurrent)
const activeSessions = new Map();
const MAX_CONCURRENT = 5;
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Path to Python redaction script
const REDACT_SCRIPT = path.join(__dirname, 'redact.py');

/**
 * Clean up expired sessions
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
 * Check if we can accept a new session
 */
function canAcceptSession() {
  cleanupSessions();
  return activeSessions.size < MAX_CONCURRENT;
}

/**
 * Create a processing session
 */
function createSession() {
  if (!canAcceptSession()) {
    return null;
  }
  const sessionId = `pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  activeSessions.set(sessionId, { startTime: Date.now() });
  return sessionId;
}

/**
 * End a processing session
 */
function endSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Process PDF: apply true redactions using PyMuPDF
 */
async function processPdf(pdfBuffer, style = 'text') {
  // Validate file size
  if (pdfBuffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }
  
  const sessionId = createSession();
  if (!sessionId) {
    throw new Error('Server busy - maximum 5 concurrent sessions. Please try again in a moment.');
  }
  
  // Create temp files
  const tmpId = crypto.randomBytes(8).toString('hex');
  const tmpInput = path.join(os.tmpdir(), `scrambler-in-${tmpId}.pdf`);
  const tmpOutput = path.join(os.tmpdir(), `scrambler-out-${tmpId}.pdf`);
  
  try {
    // Write input PDF to temp file
    fs.writeFileSync(tmpInput, pdfBuffer);
    
    // Get original page count
    let originalPageCount = 1;
    try {
      const info = execSync(`pdfinfo "${tmpInput}" 2>/dev/null`, { encoding: 'utf-8' });
      const match = info.match(/Pages:\s*(\d+)/);
      if (match) originalPageCount = parseInt(match[1], 10);
    } catch (e) {
      // Ignore pdfinfo errors
    }
    
    // Run Python redaction script
    const result = execSync(`python3 "${REDACT_SCRIPT}" "${tmpInput}" "${tmpOutput}"`, {
      timeout: 60000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });
    
    // Parse result
    let redactResult;
    try {
      redactResult = JSON.parse(result.trim());
    } catch (e) {
      throw new Error('Failed to parse redaction result');
    }
    
    if (redactResult.error) {
      throw new Error(redactResult.error);
    }
    
    // Read the redacted PDF
    if (!fs.existsSync(tmpOutput)) {
      throw new Error('Redacted PDF was not created');
    }
    
    const redactedPdfBuffer = fs.readFileSync(tmpOutput);
    
    // Get new page count
    let newPageCount = originalPageCount;
    try {
      const info = execSync(`pdfinfo "${tmpOutput}" 2>/dev/null`, { encoding: 'utf-8' });
      const match = info.match(/Pages:\s*(\d+)/);
      if (match) newPageCount = parseInt(match[1], 10);
    } catch (e) {
      // Ignore
    }
    
    return {
      pdfBuffer: redactedPdfBuffer,
      originalPageCount,
      newPageCount,
      detections: redactResult.detections || [],
      style,
      sessionId
    };
    
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(tmpInput); } catch (e) {}
    try { fs.unlinkSync(tmpOutput); } catch (e) {}
    endSession(sessionId);
  }
}

/**
 * Get current session status
 */
function getStatus() {
  cleanupSessions();
  return {
    activeSessions: activeSessions.size,
    maxSessions: MAX_CONCURRENT,
    available: MAX_CONCURRENT - activeSessions.size,
    maxFileSizeMB: MAX_FILE_SIZE / 1024 / 1024
  };
}

module.exports = {
  processPdf,
  getStatus,
  canAcceptSession,
  MAX_CONCURRENT,
  MAX_FILE_SIZE
};
