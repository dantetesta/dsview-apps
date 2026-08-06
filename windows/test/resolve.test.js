'use strict';
require('./_stub-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlayUrl } = require('../src/main/resolve');

test('parsePlayUrl: link canônico /play/{token}', () => {
  const r = parsePlayUrl('https://dsfacil.com.br/play/8f2a91');
  assert.deepEqual(r, { origin: 'https://dsfacil.com.br', token: '8f2a91' });
});

test('parsePlayUrl: aceita barra final', () => {
  const r = parsePlayUrl('https://dsfacil.com.br/play/8f2a91/');
  assert.deepEqual(r, { origin: 'https://dsfacil.com.br', token: '8f2a91' });
});

test('parsePlayUrl: preserva a porta no origin', () => {
  const r = parsePlayUrl('https://site.com:8443/play/xyz');
  assert.equal(r.origin, 'https://site.com:8443');
});

test('parsePlayUrl: null quando não é o caminho /play/', () => {
  assert.equal(parsePlayUrl('https://dsfacil.com.br/outra-coisa/8f2a91'), null);
});

test('parsePlayUrl: null pra código curto puro (sem URL)', () => {
  assert.equal(parsePlayUrl('12345'), null);
});

test('parsePlayUrl: null pra string que não é URL válida', () => {
  assert.equal(parsePlayUrl('não é url nenhuma'), null);
});

test('parsePlayUrl: token só aceita alfanumérico — corta na primeira barra/símbolo estranho', () => {
  const r = parsePlayUrl('https://site.com/play/abc123');
  assert.equal(r.token, 'abc123');
});
