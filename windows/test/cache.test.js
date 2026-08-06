'use strict';
require('./_stub-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const cache = require('../src/main/cache');

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
