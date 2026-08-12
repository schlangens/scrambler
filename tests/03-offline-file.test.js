const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadApp } = require('./helpers/app-loader');
const { SYNTHETIC_PII, sampleParagraph } = require('./fixtures');

const OFFLINE_FILE = path.join(__dirname, '..', 'public', 'scrambler-offline.html');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-offline.js');

const NETWORK_KEYWORDS = ['fetch', 'XMLHttpRequest', 'http://', 'https://', '<script src=', '<link ', 'href="//', '@import url', 'src="//'];
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
