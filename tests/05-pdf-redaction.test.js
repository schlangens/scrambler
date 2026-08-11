const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, stopServer, request, buildMultipart } = require('./helpers/server');
const { createPiiPdf, extractText, countPages, createImageOnlyPdf } = require('./helpers/pdf');
const { pdfDetectableValues } = require('./fixtures');

describe('PDF redaction end to end', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await stopServer(server);
  });

  it('removes all synthetic PII from the returned PDF text layer', async () => {
    const pdf = await createPiiPdf();
    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });

    assert.ok(res.raw.length > 0, 'Redacted PDF should not be empty');
    assert.strictEqual(res.raw.toString('latin1', 0, 4), '%PDF', 'Returned file should begin with PDF magic bytes');

    const text = await extractText(res.raw);
    for (const value of pdfDetectableValues()) {
      assert.ok(!text.includes(value), `Redacted PDF text layer still contains PII: ${value}`);
    }
    // Non-sensitive labels and framing text should remain.
    assert.ok(text.includes('Confidential') || text.includes('report') || text.includes('SSN:'), 'Expected non-sensitive text to remain in the PDF');
  });

  it('preserves page count and document structure', async () => {
    const pdf = await createPiiPdf();
    const originalPages = await countPages(pdf);
    assert.strictEqual(originalPages, 2, 'Synthetic PDF should have 2 pages');

    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    assert.strictEqual(res.status, 200, `Redaction failed: ${res.text}`);

    const newPages = await countPages(res.raw);
    assert.strictEqual(newPages, originalPages, 'Page count should be preserved');
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
  });

  it('analyze endpoint returns JSON with expected metadata and a base64 PDF', async () => {
    const pdf = await createPiiPdf();
    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);
    const res = await request({ method: 'POST', path: '/api/pdf/analyze', port: server.port, body: payload.buffer, headers: payload.headers });

    assert.strictEqual(res.status, 200, `Analyze failed: ${res.text}`);
    const data = JSON.parse(res.text);
    assert.strictEqual(data.success, true);
    assert.ok(typeof data.originalPageCount === 'number' && data.originalPageCount >= 1);
    assert.ok(typeof data.newPageCount === 'number' && data.newPageCount === data.originalPageCount);
    assert.ok(Array.isArray(data.detections));
    assert.ok(data.pdfBase64 && data.pdfBase64.length > 0);

    const redactedPdf = Buffer.from(data.pdfBase64, 'base64');
    const text = await extractText(redactedPdf);
    for (const value of pdfDetectableValues()) {
      assert.ok(!text.includes(value), `Analyze PDF base64 text layer still contains PII: ${value}`);
    }
  });

  it('flags image-only pages as unchecked in the analyze response', async () => {
    const pdf = await createImageOnlyPdf();
    const payload = buildMultipart({}, 'pdf', 'image-only.pdf', pdf);
    const res = await request({ method: 'POST', path: '/api/pdf/analyze', port: server.port, body: payload.buffer, headers: payload.headers });

    assert.strictEqual(res.status, 200, `Image-only PDF should not be rejected: ${res.text}`);
    const data = JSON.parse(res.text);
    assert.strictEqual(data.success, true);
    const uncheckedPages = data.uncheckedPages || data.pagesWithoutText;
    assert.ok(Array.isArray(uncheckedPages), 'Response should include an uncheckedPages / pagesWithoutText array');
    assert.ok(uncheckedPages.includes(1), 'Page 1 should be flagged as unchecked (no readable text)');
  });
});
