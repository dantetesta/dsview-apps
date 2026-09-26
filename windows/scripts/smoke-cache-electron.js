'use strict';
// Run with: node_modules/.bin/electron scripts/smoke-cache-electron.js
// Uses Electron's actual Chromium network stack and an isolated temporary cache.
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'dsview-electron-cache-'));
app.setPath('userData', isolated);
app.whenReady().then(async () => {
  const cache = require('../src/main/cache');
  const body = crypto.randomBytes(25 * 1024 * 1024);
  let broken = false, attempts = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['accept-encoding'], 'identity');
    attempts++;
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'video/mp4' });
    if (broken) { res.write(body.subarray(0, 1024)); setTimeout(() => res.destroy(), 10); }
    else res.end(body);
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/media.mp4';
    await cache.download(url);
    const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
    assert.equal(digest(fs.readFileSync(cache.filePath(url))), digest(body));
    broken = true;
    await assert.rejects(cache.download(url));
    assert.equal(attempts, 4);
    assert.equal(cache.isVerified(url), true);
    assert.equal(digest(fs.readFileSync(cache.filePath(url))), digest(body));
    assert.equal(fs.readdirSync(cache.dir()).some((name) => name.endsWith('.part')), false);
    console.log('PASS: native Electron net, 25 MiB identical, interrupted transfers retry 3x, last-good file retained.');
    cache.clear();
    await new Promise((resolve) => server.close(resolve));
    app.exit(0);
  } catch (error) {
    console.error(error);
    cache.clear(); server.close(); app.exit(1);
  }
});
