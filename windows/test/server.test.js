'use strict';
require('./_stub-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const { MEDIA_NAME_RE } = require('../src/main/server');

test('MEDIA_NAME_RE: aceita um nome de cache válido de verdade', () => {
  assert.match('da39a3ee5e6b4b0d3255bfef95601890afd80709.mp4', MEDIA_NAME_RE);
});

// Path traversal é a categoria de bug mais séria que esse regex existe pra impedir — cada um
// destes, se passasse, deixaria /media/:name ler qualquer arquivo do disco do PC do cliente.
test('MEDIA_NAME_RE: barra ../ (path traversal)', () => {
  assert.equal(MEDIA_NAME_RE.test('../../../../Windows/System32/config/SAM'), false);
});

test('MEDIA_NAME_RE: barra caminho absoluto', () => {
  assert.equal(MEDIA_NAME_RE.test('/etc/passwd'), false);
  assert.equal(MEDIA_NAME_RE.test('C:\\Windows\\System32\\config\\SAM'), false);
});

test('MEDIA_NAME_RE: barra barra no meio do nome', () => {
  assert.equal(MEDIA_NAME_RE.test('da39a3ee5e6b4b0d3255bfef95601890afd8070/9.mp4'), false);
});

test('MEDIA_NAME_RE: barra hash maiúsculo (só aceita minúsculo, hex real é minúsculo)', () => {
  assert.equal(MEDIA_NAME_RE.test('DA39A3EE5E6B4B0D3255BFEF95601890AFD80709.mp4'), false);
});

test('MEDIA_NAME_RE: barra hash curto ou longo demais', () => {
  assert.equal(MEDIA_NAME_RE.test('da39a3.mp4'), false);
  assert.equal(MEDIA_NAME_RE.test('da39a3ee5e6b4b0d3255bfef95601890afd807091234.mp4'), false);
});

test('MEDIA_NAME_RE: barra nome sem extensão', () => {
  assert.equal(MEDIA_NAME_RE.test('da39a3ee5e6b4b0d3255bfef95601890afd80709'), false);
});

test('MEDIA_NAME_RE: barra null byte / caracteres de controle', () => {
  assert.equal(MEDIA_NAME_RE.test('da39a3ee5e6b4b0d3255bfef95601890afd80709.mp4\0.txt'), false);
});
