const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadApp } = require('./helpers/app-loader');
const { SYNTHETIC_PII, sampleParagraph } = require('./fixtures');

const OFFLINE_FILE = path.join(__dirname, '..', 'public', 'scrambler-offline.html');
const INDEX_FILE = path.join(__dirname, '..', 'public', 'index.html');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-offline.js');

const NETWORK_KEYWORDS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'ws://', 'wss://', 'http://', 'https://', '<script src=', '<link ', 'href="//', '@import url', 'src="//'];
const PDF_ENDPOINTS = ['/api/pdf/', '/api/pdf/analyze', '/api/pdf/redact', '/api/pdf/status'];

describe('Offline file', () => {
  it('exists', () => {
    assert.ok(fs.existsSync(OFFLINE_FILE), `Expected ${OFFLINE_FILE} to exist`);
  });

  it('is reproducible byte-for-byte by the build script', () => {
    assert.ok(fs.existsSync(OFFLINE_FILE), 'Offline file missing');
    if (!fs.existsSync(BUILD_SCRIPT)) {
      // Build script is created by session 6; if not present the test cannot run.
      return;
    }
    const before = fs.readFileSync(OFFLINE_FILE);
    // The build script is expected to write the offline file deterministically.
    require(BUILD_SCRIPT);
    const after = fs.readFileSync(OFFLINE_FILE);
    assert.ok(before.equals(after), 'Regenerating offline file changed its bytes');
  });

  it('contains no network references', () => {
    assert.ok(fs.existsSync(OFFLINE_FILE), 'Offline file missing');
    const html = fs.readFileSync(OFFLINE_FILE, 'utf8').toLowerCase();
    for (const kw of NETWORK_KEYWORDS) {
      assert.ok(!html.includes(kw.toLowerCase()), `Offline file contains network reference: ${kw}`);
    }
  });

  it('contains no PDF endpoint references', () => {
    assert.ok(fs.existsSync(OFFLINE_FILE), 'Offline file missing');
    const html = fs.readFileSync(OFFLINE_FILE, 'utf8');
    for (const endpoint of PDF_ENDPOINTS) {
      assert.ok(!html.includes(endpoint), `Offline file references PDF endpoint ${endpoint}`);
    }
  });

  function parseSizeFromText(text) {
    const match = text.match(/about\s+(\d+(?:\.\d+)?)\s*KB/i);
    assert.ok(match, `Could not parse a KB size from "${text}"`);
    return parseFloat(match[1]);
  }

  it('advertises an offline file size that matches reality', () => {
    assert.ok(fs.existsSync(OFFLINE_FILE), 'Offline file missing');
    assert.ok(fs.existsSync(INDEX_FILE), 'Landing page missing');

    const realBytes = fs.statSync(OFFLINE_FILE).size;
    const realKb = Math.round(realBytes / 1024);
    const html = fs.readFileSync(INDEX_FILE, 'utf8');

    const spanMatch = html.match(/<span[^>]*id=["']offline-size["'][^>]*>([^<]+)<\/span>/i);
    const linkMatch = html.match(/<a[^>]*id=["']offline-link["'][^>]*aria-label=["']([^"']+)["']/i);

    assert.ok(spanMatch, 'Size span with id="offline-size" not found in public/index.html');
    assert.ok(linkMatch, 'Download link with id="offline-link" and aria-label not found in public/index.html');

    const spanText = spanMatch[1].trim();
    const ariaText = linkMatch[1].trim();
    const spanKb = parseSizeFromText(spanText);
    const ariaKb = parseSizeFromText(ariaText);

    assert.strictEqual(spanKb, ariaKb, `Visible size "${spanText}" must match aria-label "${ariaText}"`);

    // Tolerance: ±2 KiB. Rounding to the same whole KB already covers routine copy edits;
    // a ±2 KiB window still catches a materially misleading claim without flagging every tiny change.
    const diff = Math.abs(spanKb - realKb);
    assert.ok(
      diff <= 2,
      `Offline file size claim is stale. real=${realBytes} bytes (~${realKb} KiB), advertised=${spanKb} KiB. Update <span id="offline-size">about ${realKb} KB</span> and aria-label="Download offline version, about ${realKb} KB" in public/index.html`
    );
  });

  it('masks and unmasks in isolation without network access', () => {
    assert.ok(fs.existsSync(OFFLINE_FILE), 'Offline file missing');
    const app = loadApp({ preferred: 'offline' });
    assert.ok(app.exists, 'No masking logic found in offline file');
    const input = sampleParagraph();
    const { text: masked, mappings } = app.mask(input);
    assert.strictEqual(app.networkCalls.length, 0, 'Offline masking must not use the network');
    assert.ok(!masked.includes(SYNTHETIC_PII.email), 'Email should be masked');
    const restored = app.unmask(masked, mappings);
    assert.strictEqual(restored, input);
  });
});
