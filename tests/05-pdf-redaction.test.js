const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, stopServer, request, buildMultipart } = require('./helpers/server');
const { createPiiPdf, createTextPdf, extractText, countPages, createImageOnlyPdf } = require('./helpers/pdf');
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

  it('redacts parenthesised, dashed and dotted phone numbers without leaving stray brackets', async () => {
    const phoneText = [
      'Parenthesised: (317) 555-8421',
      'Dashes: 317-555-8421',
      'Dots: 317.555.8421',
    ].join('\n');
    const pdf = await createTextPdf(phoneText);
    const payload = buildMultipart({}, 'pdf', 'phones.pdf', pdf);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });

    assert.strictEqual(res.status, 200, `Phone redaction failed: ${res.text}`);
    const text = await extractText(res.raw);

    assert.ok(!text.includes('('), 'Redacted PDF text layer still contains a stray open parenthesis');
    assert.ok(!text.includes('317'), 'Redacted PDF text layer still contains the area code 317');
    assert.ok(!text.includes('555-8421'), 'Redacted PDF text layer still contains the phone number');
    assert.ok(!text.includes('555.8421'), 'Redacted PDF text layer still contains the phone number');
    const redactions = text.split('[REDACTED]').length - 1;
    assert.strictEqual(redactions, 3, `Expected 3 phone redactions, found ${redactions}`);
  });

  it('absorbs a glued parenthesis and declines phones glued to letters', async () => {
    const phoneText = [
      'Call: call(415) 555-0199 now',
      'Not a phone: x415-555-0199',
    ].join('\n');
    const pdf = await createTextPdf(phoneText);
    const payload = buildMultipart({}, 'pdf', 'glued-phones.pdf', pdf);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });

    assert.strictEqual(res.status, 200, `Glued phone redaction failed: ${res.text}`);
    const text = await extractText(res.raw);

    assert.ok(!text.includes('('), 'Redacted PDF text layer still contains a stray open parenthesis');
    assert.ok(!text.includes('415) 555-0199'), 'Redacted PDF text layer still contains the glued phone');
    assert.ok(text.includes('x415-555-0199'), 'Identifier-style number should not have been redacted');
    const redactions = text.split('[REDACTED]').length - 1;
    assert.strictEqual(redactions, 1, `Expected 1 phone redaction, found ${redactions}`);
  });

  it('redacts email addresses that start with ., +, % or -', async () => {
    const emailText = [
      'Lead: .dot@acme.com',
      'Lead: +plus@acme.com',
      'Lead: %pct@acme.com',
      'Lead: -dash@acme.com',
    ].join('\n');
    const pdf = await createTextPdf(emailText);
    const payload = buildMultipart({}, 'pdf', 'emails.pdf', pdf);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });

    assert.strictEqual(res.status, 200, `Email redaction failed: ${res.text}`);
    const text = await extractText(res.raw);

    for (const lead of ['.', '+', '%', '-']) {
      assert.ok(!text.includes(lead + '[REDACTED]'), `Redacted PDF text layer still contains a stray '${lead}' before a redaction marker`);
      assert.ok(!text.includes('Lead: ' + lead), `Redacted PDF text layer still contains a leading '${lead}' on an email line`);
    }
    assert.ok(!text.includes('@acme.com'), 'Redacted PDF text layer still contains an email domain');
    const redactions = text.split('[REDACTED]').length - 1;
    assert.strictEqual(redactions, 4, `Expected 4 email redactions, found ${redactions}`);
  });
});
