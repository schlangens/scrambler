const { spawn } = require('child_process');
const { pdfParagraph } = require('../fixtures');

// Create a minimal PDF containing synthetic PII text using PyMuPDF (fitz).
function createPiiPdf() {
  const pythonCode = `
import fitz, sys, json
text = json.loads(sys.argv[1])
doc = fitz.open()
page = doc.new_page(width=612, height=792)
page.insert_text((72, 72), text, fontsize=12)
# Add a second page to verify page count preservation.
page2 = doc.new_page(width=612, height=792)
page2.insert_text((72, 72), "Confidential report - page 2.", fontsize=12)
sys.stdout.buffer.write(doc.tobytes())
`;
  return runPython(pythonCode, [JSON.stringify(pdfParagraph())]);
}

// Extract plain text from a PDF buffer using PyMuPDF (fitz).
function extractText(pdfBuffer) {
  const pythonCode = `
import fitz, sys
doc = fitz.open(stream=sys.stdin.buffer.read(), filetype="pdf")
text = "\\n".join(page.get_text() for page in doc)
sys.stdout.write(text)
`;
  return runPythonWithInput(pythonCode, pdfBuffer);
}

// Count pages in a PDF buffer.
function countPages(pdfBuffer) {
  const pythonCode = `
import fitz, sys
doc = fitz.open(stream=sys.stdin.buffer.read(), filetype="pdf")
print(len(doc))
`;
  return runPythonWithInput(pythonCode, pdfBuffer).then((s) => parseInt(s.trim(), 10));
}

// Create an encrypted/password-protected PDF.
function createEncryptedPdf() {
  const pythonCode = `
import fitz, sys, io
doc = fitz.open()
page = doc.new_page(width=612, height=792)
page.insert_text((72, 72), "Secret.", fontsize=12)
buf = io.BytesIO()
doc.save(buf, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
sys.stdout.buffer.write(buf.getvalue())
`;
  return runPython(pythonCode, []);
}

function runPython(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code, ...args], { env: { ...process.env, PYMUPDF_MESSAGE: 'fd:2' } });
    const chunks = [];
    const err = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Python exited ${code}: ${Buffer.concat(err).toString()}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

function runPythonWithInput(code, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code], { env: { ...process.env, PYMUPDF_MESSAGE: 'fd:2' } });
    const chunks = [];
    const err = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Python exited ${code}: ${Buffer.concat(err).toString()}`));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

module.exports = {
  createPiiPdf,
  extractText,
  countPages,
  createEncryptedPdf,
};
