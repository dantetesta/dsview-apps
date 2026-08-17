'use strict';
require('./_stub-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const cache = require('../src/main/cache');
const config = require('../src/main/config');
const { cacheableUrls, telemetry, setHealth, HEARTBEAT_MS } = require('../src/main/sync');

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

test('fileName: determinístico — mesma URL sempre dá o mesmo nome', () => {
  const url = 'https://site.com/media/foto.jpg';
  assert.equal(cache.fileName(url), cache.fileName(url));
});

test('fileName: sha1(url) + extensão da URL, em minúsculo', () => {
  const url = 'https://site.com/media/FOTO.JPG';
  assert.equal(cache.fileName(url), sha1(url) + '.jpg');
});

test('fileName: URLs diferentes nunca colidem no nome (no universo de teste)', () => {
  const a = cache.fileName('https://site.com/a.mp4');
  const b = cache.fileName('https://site.com/b.mp4');
  assert.notEqual(a, b);
});

test('extOf: sem extensão reconhecível cai em .bin', () => {
  assert.equal(cache.extOf('https://site.com/media/semextensao'), '.bin');
});

test('extOf: URL inválida (não-URL) cai em .bin sem lançar', () => {
  assert.equal(cache.extOf('isso não é uma url'), '.bin');
});

test('extOf: extensão longa demais (mais de 5 chars) não é reconhecida', () => {
  assert.equal(cache.extOf('https://site.com/a.jpegzzzzz'), '.bin');
});

test('fileName: resultado sempre bate com o formato que o servidor local aceita (sha1 + ext curta)', () => {
  const name = cache.fileName('https://site.com/video.mp4');
  assert.match(name, /^[a-f0-9]{40}\.[a-z0-9]{1,5}$/);
});

test('has: arquivo inexistente devolve false sem lançar', () => {
  assert.equal(cache.has('https://site.com/nunca-baixado.mp4'), false);
});

test('cacheableUrls: inclui foto e logo do RSS uma vez para funcionar offline', () => {
  const photo = 'https://site.com/noticia.webp';
  const logo = 'https://site.com/logo.webp';
  const urls = cacheableUrls({ queue: [
    { kind: 'rss', provider: 'self', src: photo, fallback_src: logo, source_logo: logo },
    { kind: 'rss', provider: 'self', src: photo, source_logo: logo },
  ] });
  assert.deepEqual(urls, [photo, logo]);
});

test('telemetry: identifica Windows, versão e modo sem vazar dados da playlist', () => {
  const online = telemetry({ offline: false, origin: 'https://segredo.test', token: 'nao-vazar' });
  assert.equal(online.platform, 'windows');
  assert.equal(online.app_version, require('../package.json').version);
  assert.equal(online.mode, 'online');
  assert.equal(online.health, 'healthy');
  assert.equal(online.origin, undefined);
  assert.equal(online.token, undefined);

  setHealth('degraded', 'Renderizador travou');
  const degraded = telemetry({ offline: true });
  assert.equal(degraded.mode, 'offline_cache');
  assert.equal(degraded.health, 'degraded');
  assert.equal(degraded.last_error, 'Renderizador travou');
  setHealth('healthy');
  assert.equal(HEARTBEAT_MS, 60000);
});
