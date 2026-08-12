const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, stopServer, request, buildMultipart } = require('./helpers/server');
const { createPiiPdf } = require('./helpers/pdf');
const { SYNTHETIC_PII, allDetectableValues } = require('./fixtures');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const TEMP_DIR = os.tmpdir();

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'coverage']);

function findDbFiles(dir) {
  const found = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (/\.(db|sqlite|sqlite3)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  }
  walk(dir);
  return found;
}

function snapshotFiles() {
  return {
    temp: listFiles(TEMP_DIR),
    repo: listFiles(REPO_ROOT),
    data: listFiles(DATA_DIR),
    dbFiles: findDbFiles(REPO_ROOT).concat(findDbFiles(TEMP_DIR)),
  };
}

describe('Nothing is stored on the server', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await stopServer(server);
  });

  it('removed endpoints all return 404', async () => {
    const endpoints = [
      { method: 'POST', path: '/api/mask' },
      { method: 'POST', path: '/api/unmask' },
      { method: 'POST', path: '/api/mappings' },
      { method: 'POST', path: '/api/mappings/add' },
      { method: 'DELETE', path: '/api/session/anything' },
      { method: 'GET', path: '/auth/google' },
      { method: 'POST', path: '/auth/login' },
    ];

    for (const { method, path } of endpoints) {
      const res = await request({ method, path, port: server.port, body: { text: 'test' } });
      assert.strictEqual(res.status, 404, `${method} ${path} should return 404, got ${res.status}`);
    }
  });

  it('no SQLite or database files are created at runtime', async () => {
    const before = findDbFiles(REPO_ROOT).concat(findDbFiles(TEMP_DIR));
    const pdf = await createPiiPdf();
    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);
    await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    const after = findDbFiles(REPO_ROOT).concat(findDbFiles(TEMP_DIR));
    const newDbFiles = after.filter((f) => !before.includes(f));
    const scramblerDbFiles = newDbFiles.filter((f) => /scrambler/i.test(f));
    assert.strictEqual(scramblerDbFiles.length, 0, `Scrambler database files appeared during PDF processing: ${scramblerDbFiles.join(', ')}`);
  });

  it('PDF redaction leaves no new files in temp, repo, or data directories', async () => {
    const before = snapshotFiles();
    const pdf = await createPiiPdf();
    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);
    await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    const after = snapshotFiles();

    assert.deepStrictEqual(after.data, before.data, 'Data directory changed during PDF processing');
    assert.deepStrictEqual(after.repo, before.repo, 'Repository directory changed during PDF processing');
    // Temp directory may have unrelated OS churn; assert the specific scrambler temp files are absent.
    const newTemp = after.temp.filter((f) => !before.temp.includes(f));
    const scramblerTemp = newTemp.filter((f) => /scrambler/i.test(f));
    assert.strictEqual(scramblerTemp.length, 0, `Scrambler temp files were left behind: ${scramblerTemp.join(', ')}`);
  });

  it('logs never contain synthetic PII values', async () => {
    server.clearLog();
    const pdf = await createPiiPdf();
    const payload = buildMultipart({}, 'pdf', 'synthetic.pdf', pdf);
    await request({ method: 'POST', path: '/api/pdf/redact', port: server.port, body: payload.buffer, headers: payload.headers });
    const log = server.getLog();
    const combined = log.stdout + log.stderr;
    for (const value of allDetectableValues()) {
      assert.ok(!combined.includes(value), `Server log leaked PII value: ${value}`);
    }
  });
});
