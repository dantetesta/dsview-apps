'use strict';
const { userDataDir } = require('./_stub-electron');
const { net } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../src/main/cache');
const state = require('../src/main/state');
const config = require('../src/main/config');
const sync = require('../src/main/sync');
const local = require('../src/main/server');

// Electron's net interface uses real HTTP streams here: interrupted responses and
// disk writes exercise production code, without needing an interactive desktop.
net.request = ({ url, method }) => http.request(url, { method });
let server, origin, route;
before(async () => {
  server = http.createServer((req, res) => route(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  cache.clear(); state.clear(); sync.stop();
  await new Promise((resolve) => server.close(resolve));
});

function media(res, body = Buffer.from('complete media')) {
  res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
  res.end(body);
}
function setup(payload, mediaRoute) {
  config.write({ origin, token: 'fixture', device: 'test-device', offline: true });
  route = (req, res) => {
    if (req.url.startsWith('/wp-json/')) return res.end(JSON.stringify({ status: 'ok', payload }));
    mediaRoute(req, res);
  };
}

test('real HTTP: complete 99 MB body is preserved byte-for-byte and coalesced', async () => {
  const body = crypto.randomBytes(99 * 1024 * 1024);
  let requests = 0;
  route = (_req, res) => { requests++; media(res, body); };
  const url = origin + '/large.mp4';
  const a = cache.download(url), b = cache.download(url);
  assert.equal(a, b);
  await a;
  assert.equal(requests, 1);
  assert.equal(cache.isVerified(url), true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(cache.filePath(url))).digest('hex'), crypto.createHash('sha256').update(body).digest('hex'));
});

test('real HTTP: connection interrupted at half body retries without replacing old good file', async () => {
  const url = origin + '/truncated.mp4';
  route = (_req, res) => media(res, Buffer.from('previous-good'));
  await cache.download(url);
  let attempts = 0;
  route = (_req, res) => {
    attempts++;
    res.writeHead(200, { 'Content-Length': 100000 });
    res.write(Buffer.alloc(50000));
    setTimeout(() => res.destroy(), 5);
  };
  await assert.rejects(cache.download(url));
  assert.equal(attempts, 3);
  assert.equal(fs.readFileSync(cache.filePath(url), 'utf8'), 'previous-good');
  assert.equal(cache.isVerified(url), true);
  assert.equal(fs.readdirSync(cache.dir()).some((name) => name.endsWith('.part')), false);
});

test('real HTTP: a failed transfer recovers on retry', async () => {
  let attempts = 0;
  route = (_req, res) => {
    attempts++;
    if (attempts === 1) { res.writeHead(503); res.end(); }
    else media(res);
  };
  await cache.download(origin + '/retry.jpg');
  assert.equal(attempts, 2);
});

test('real HTTP: rejects partial responses, HTML and empty files; accepts complete chunked media', async () => {
  for (const [name, status, headers, body] of [
    ['partial', 206, { 'Content-Range': 'bytes 0-2/20' }, 'abc'],
    ['html', 200, { 'Content-Type': 'text/html' }, '<html>Access denied</html>'],
    ['empty', 200, {}, ''],
  ]) {
    route = (_req, res) => { res.writeHead(status, headers); res.end(body); };
    const url = origin + '/' + name + '.mp4';
    await assert.rejects(cache.download(url));
    assert.equal(cache.has(url), false);
  }
  route = (_req, res) => { res.writeHead(200, { 'Transfer-Encoding': 'chunked' }); res.write('first'); res.end('last'); };
  const url = origin + '/chunked.mp4';
  await cache.download(url);
  assert.equal(fs.readFileSync(cache.filePath(url), 'utf8'), 'firstlast');
});

test('real HTTP: idle timeout terminates and retries stalled transfer', async () => {
  let attempts = 0;
  route = (_req, res) => { attempts++; res.writeHead(200); res.flushHeaders(); };
  await assert.rejects(cache.download(origin + '/stalled.mp4', { idleMs: 40 }));
  assert.equal(attempts, 3);
});

test('sync: unchanged version repairs unverified legacy file, and later detects truncation', async () => {
  const url = origin + '/legacy.mp4';
  fs.writeFileSync(cache.filePath(url), 'truncated');
  assert.equal(cache.has(url), true); // existing installations still play offline
  assert.equal(cache.isVerified(url), false);
  const payload = { version: 'legacy', queue: [{ kind: 'video', src: url }] };
  state.set(payload);
  let downloads = 0;
  setup(payload, (_req, res) => { downloads++; media(res, Buffer.from('repaired-content')); });
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(downloads, 1);
  fs.truncateSync(cache.filePath(url), 3);
  assert.equal(cache.has(url), false);
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(downloads, 2);
});

test('sync: failed new media preserves last-good payload and old media', async () => {
  const oldUrl = origin + '/old.jpg';
  route = (_req, res) => media(res);
  await cache.download(oldUrl);
  const old = { version: 'old', queue: [{ src: oldUrl }] };
  state.set(old);
  setup({ version: 'new-failure', queue: [{ src: origin + '/unavailable.mp4', kind: 'video' }] }, (_req, res) => { res.writeHead(503); res.end(); });
  assert.equal((await sync.syncOnce()).reason, 'download-failed');
  assert.deepEqual(state.get(), old);
  assert.equal(cache.isVerified(oldUrl), true);
});

test('sync: maximum 3 concurrent downloads, images first, concurrent sync calls coalesce', async () => {
  const queue = [
    ...Array.from({ length: 2 }, (_, i) => ({ src: origin + '/parallel-video-' + i + '.mp4', kind: 'video' })),
    ...Array.from({ length: 5 }, (_, i) => ({ src: origin + '/parallel-image-' + i + '.jpg', kind: 'image' })),
  ];
  let inFlight = 0, maximum = 0;
  const order = [];
  setup({ version: 'parallel', queue }, (req, res) => {
    order.push(req.url); inFlight++; maximum = Math.max(maximum, inFlight);
    setTimeout(() => { inFlight--; media(res); }, req.url.includes('video') ? 100 : 25);
  });
  const a = sync.syncOnce(), b = sync.syncOnce();
  assert.equal(a, b);
  assert.equal((await a).downloaded, 7);
  assert.equal(maximum, 3);
  assert.equal(order.length, 7);
  assert.ok(order.slice(0, 5).every((url) => url.includes('image')));
});

test('sync: clear during transfer cancels commit and does not resurrect deleted media', async () => {
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  const url = origin + '/clear-during.mp4';
  setup({ version: 'cancelled', queue: [{ src: url }] }, (_req, res) => {
    res.writeHead(200, { 'Content-Length': 100 }); res.write('start'); arrived();
  });
  const pending = sync.syncOnce();
  await arrival;
  cache.clear(); state.clear();
  assert.equal((await pending).reason, 'cancelled');
  assert.equal(state.get(), null);
  assert.equal(cache.has(url), false);
});

test('sync: changing playlist during media download discards the old result', async () => {
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  setup({ version: 'previous-playlist', queue: [{ src: origin + '/switch.mp4' }] }, (_req, res) => {
    arrived(); setTimeout(() => media(res), 25);
  });
  state.clear();
  const pending = sync.syncOnce();
  await arrival;
  config.write({ token: 'another-playlist' });
  assert.equal((await pending).reason, 'cancelled');
  assert.equal(state.get(), null);
});

test('authentication does not report ready or publish payload when initial media fails', async () => {
  state.clear();
  setup({ version: 'auth-failure', queue: [{ src: origin + '/auth-failure.mp4' }] }, (_req, res) => { res.writeHead(503); res.end(); });
  assert.equal((await sync.authenticate('')).status, 'download-failed');
  assert.equal(state.get(), null);
});

test('sync: disk failure persisting last-good preserves previous payload and its media', async () => {
  const oldUrl = origin + '/disk-old.jpg';
  route = (_req, res) => media(res);
  await cache.download(oldUrl);
  const previous = { version: 'disk-old', queue: [{ src: oldUrl }] };
  state.set(previous);
  setup({ version: 'disk-new', queue: [{ src: origin + '/disk-new.jpg' }] }, (_req, res) => media(res));
  const blocker = path.join(userDataDir, 'last-good.json.tmp');
  fs.mkdirSync(blocker);
  try {
    assert.equal((await sync.syncOnce()).reason, 'storage-failed');
    assert.deepEqual(state.get(), previous);
    assert.equal(cache.isVerified(oldUrl), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'last-good.json'), 'utf8')), previous);
  } finally { fs.rmdirSync(blocker); }
});

test('local HTTP server: byte ranges return exact bytes, including suffix, and HEAD', async () => {
  const url = origin + '/range.mp4';
  route = (_req, res) => media(res, Buffer.from('0123456789'));
  await cache.download(url);
  const localServer = http.createServer(local.handler);
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const localUrl = 'http://127.0.0.1:' + localServer.address().port + '/media/' + cache.fileName(url);
  try {
    for (const [range, expected, contentRange] of [['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=7-99', '789', 'bytes 7-9/10']]) {
      const response = await fetch(localUrl, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(await response.text(), expected);
    }
    for (const range of ['bytes=10-', 'bytes=3-2', 'bytes=-0', 'garbage', 'bytes=0-1,4-5']) {
      const response = await fetch(localUrl, { headers: { Range: range } });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), 'bytes */10');
    }
    const head = await fetch(localUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
  } finally { await new Promise((resolve) => localServer.close(resolve)); }
});
