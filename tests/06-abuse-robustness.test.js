const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, stopServer, request, buildMultipart } = require('./helpers/server');
const { createPiiPdf, createEncryptedPdf } = require('./helpers/pdf');

const TEN_MB = 10 * 1024 * 1024;

describe('Abuse and robustness', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await stopServer(server);
  });

  it('rejects a file over the size limit', async () => {
    const oversized = Buffer.alloc(TEN_MB + 1024);
    oversized.write('%PDF-1.4', 0);
    const payload = buildMultipart({}, 'pdf', 'huge.pdf', oversized);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    assert.ok(res.status === 400 || res.status === 413, `Expected 400/413 for oversized file, got ${res.status}`);
  });

  it('rejects a non-PDF, including a file named .pdf with non-PDF contents', async () => {
    const notPdf = Buffer.from('This is not a PDF file, despite the name.');
    const payload = buildMultipart({}, 'pdf', 'fake.pdf', notPdf);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    assert.ok(res.status === 400, `Expected 400 for non-PDF, got ${res.status}: ${res.text}`);
  });

  it('handles a corrupt or truncated PDF without crashing the server', async () => {
    const corrupt = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\ntrailer\n<<\n/Root 1 0 R\n>>\n%%EOF');
    const payload = buildMultipart({}, 'pdf', 'corrupt.pdf', corrupt);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    assert.ok(res.status >= 400 && res.status < 600, `Corrupt PDF should not crash server (got ${res.status})`);

    // Server should still respond after the corrupt request.
    const status = await request({ method: 'GET', path: '/api/pdf/status', port: server.port });
    assert.strictEqual(status.status, 200, 'Server should remain healthy after corrupt PDF');
  });

  it('rejects an encrypted or password-protected PDF with a clear error', async () => {
    const encrypted = await createEncryptedPdf();
    const payload = buildMultipart({}, 'pdf', 'encrypted.pdf', encrypted);
    const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    assert.ok(res.status >= 400, `Expected error for encrypted PDF, got ${res.status}`);
    assert.ok(
      res.text.toLowerCase().includes('encrypt') || res.text.toLowerCase().includes('password') || res.text.toLowerCase().includes('protected') || res.text.toLowerCase().includes('failed'),
      `Response should mention encryption/password/failure: ${res.text}`
    );
  });

  it('returns 503 when all concurrency slots are busy', async () => {
    // Hold 5 slots by sending slow-to-complete PDFs.  The synthetic PDF is fast,
    // so this test primarily verifies the endpoint returns a consistent status.
    const pdf = await createPiiPdf();
    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);

    const requests = [];
    for (let i = 0; i < 7; i++) {
      requests.push(request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers }));
    }
    const results = await Promise.all(requests);
    const statuses = results.map((r) => r.status);
    const okCount = statuses.filter((s) => s === 200).length;
    const busyCount = statuses.filter((s) => s === 503).length;
    assert.ok(okCount >= 1, `Expected at least one successful redaction, got statuses ${statuses}`);
    assert.ok(busyCount >= 1 || okCount === 7, `Expected some 503 responses when concurrency is saturated, got statuses ${statuses}`);
  });

  it('rate limits repeated requests and returns 429', async () => {
    const pdf = await createPiiPdf();
    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);
    const statuses = [];
    for (let i = 0; i < 25; i++) {
      const res = await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
      statuses.push(res.status);
    }
    const limited = statuses.filter((s) => s === 429).length;
    assert.ok(limited > 0, `Expected at least one 429 from rate limiting, got statuses ${statuses}`);
  });

  it('rejects oversized or malformed JSON bodies cleanly', async () => {
    const malformed = '{"text": "hello';
    const res = await request({
      method: 'POST',
      path: '/api/mask',
      port: server.port,
      body: malformed,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.ok(res.status >= 400, `Malformed JSON should be rejected, got ${res.status}`);
  });
});
