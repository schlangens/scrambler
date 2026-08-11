const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const SERVER_PATH = path.join(__dirname, '..', '..', 'src', 'server.js');

function startServer({ port = 34567 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), DB_PATH: ':memory:', GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret', PYMUPDF_MESSAGE: 'fd:2' };
    const child = spawn('node', [SERVER_PATH], { env });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error('Server failed to start within 5 seconds'));
      }
    }, 5000);

    child.on('error', reject);

    function tryConnect(attempt = 0) {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: '/api/pdf/status', timeout: 500 },
        (res) => {
          if (res.statusCode === 200) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve({
                child,
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                getLog: () => ({
                  stdout: Buffer.concat(stdout).toString('utf8'),
                  stderr: Buffer.concat(stderr).toString('utf8'),
                }),
                clearLog: () => { stdout.length = 0; stderr.length = 0; },
              });
            }
          } else {
            retry(attempt);
          }
        }
      );
      req.on('error', () => retry(attempt));
      req.on('timeout', () => { req.destroy(); retry(attempt); });
      req.end();
    }

    function retry(attempt) {
      if (attempt > 30) {
        child.kill();
        return reject(new Error('Server did not become ready'));
      }
      setTimeout(() => tryConnect(attempt + 1), 100);
    }

    // Listen for the port log line as a fallback.
    const logHandler = (data) => {
      const line = data.toString();
      const m = line.match(/(?:running on port|port)\s+(\d+)/i);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timer);
        child.stdout.off('data', logHandler);
        child.stderr.off('data', logHandler);
        resolve({
          child,
          port: parseInt(m[1], 10),
          baseUrl: `http://127.0.0.1:${m[1]}`,
          getLog: () => ({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          }),
          clearLog: () => { stdout.length = 0; stderr.length = 0; },
        });
      }
    };
    child.stdout.on('data', logHandler);
    child.stderr.on('data', logHandler);

    tryConnect();
  });
}

function request({ method = 'GET', path, port, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const isFormData = body && typeof body === 'object' && Buffer.isBuffer(body) === false && body.headers;
    let data = null;
    let contentType = headers['Content-Type'];
    if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !body.headers) {
      data = JSON.stringify(body);
      contentType = contentType || 'application/json';
    } else if (Buffer.isBuffer(body)) {
      data = body;
    } else if (body && typeof body === 'string') {
      data = Buffer.from(body);
    }

    const reqHeaders = { ...headers };
    if (contentType) reqHeaders['Content-Type'] = contentType;
    if (data && !reqHeaders['Content-Length']) reqHeaders['Content-Length'] = Buffer.byteLength(data || '');

    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: reqHeaders, timeout: 15000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            text: raw.toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => reject(new Error(`Request timeout: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

function buildMultipart(fields, fileField, filename, fileBuffer) {
  const boundary = `----scrambler-test-${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`);
  const end = `\r\n--${boundary}--\r\n`;
  return {
    buffer: Buffer.concat([
      Buffer.from(parts.join('')),
      fileBuffer,
      Buffer.from(end),
    ]),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.child) return resolve();
    server.child.on('close', resolve);
    server.child.kill('SIGTERM');
    setTimeout(() => {
      try { server.child.kill('SIGKILL'); } catch {}
      resolve();
    }, 1000);
  });
}

module.exports = {
  startServer,
  request,
  buildMultipart,
  stopServer,
};
