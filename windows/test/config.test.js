'use strict';
require('./_stub-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../src/main/config');

test('syncIntervalMin: clampa abaixo do mínimo (5)', () => {
  assert.equal(config.syncIntervalMin({ syncInterval: 1 }), 5);
});

test('syncIntervalMin: clampa acima do máximo (1440)', () => {
  assert.equal(config.syncIntervalMin({ syncInterval: 999999 }), 1440);
});

test('syncIntervalMin: valor dentro da faixa passa direto', () => {
  assert.equal(config.syncIntervalMin({ syncInterval: 120 }), 120);
});

test('syncIntervalMin: não-numérico cai no padrão (60), não no mínimo', () => {
  assert.equal(config.syncIntervalMin({ syncInterval: 'abacate' }), config.SYNC_DEFAULT);
  assert.equal(config.syncIntervalMin({ syncInterval: undefined }), config.SYNC_DEFAULT);
});

test('realApi: null sem origin ou sem token', () => {
  assert.equal(config.realApi({ origin: '', token: 'abc' }), null);
  assert.equal(config.realApi({ origin: 'https://site.com', token: '' }), null);
});

test('realApi: monta a rota REST certa e tira a barra final do origin', () => {
  assert.equal(
    config.realApi({ origin: 'https://site.com.br/', token: 'xyz' }),
    'https://site.com.br/wp-json/ds-facil/v1/player/xyz',
  );
});

test('realApi: URL-encoda o token', () => {
  assert.equal(
    config.realApi({ origin: 'https://site.com', token: 'a b/c' }),
    'https://site.com/wp-json/ds-facil/v1/player/a%20b%2Fc',
  );
});

test('write/read: grava e lê de volta (round-trip via arquivo real)', () => {
  const written = config.write({ origin: 'https://x.com', token: 't1', favorites: [{ name: 'A', url: 'u' }] });
  assert.equal(written.origin, 'https://x.com');
  const read = config.read();
  assert.equal(read.origin, 'https://x.com');
  assert.equal(read.token, 't1');
  assert.deepEqual(read.favorites, [{ name: 'A', url: 'u' }]);
});

test('write: escreve atômico — não sobra .tmp depois de gravar', () => {
  config.write({ origin: 'https://atomic-test.com' });
  assert.equal(fs.existsSync(config.FILE + '.tmp'), false);
  assert.equal(fs.existsSync(config.FILE), true);
});

test('write: patch parcial preserva os outros campos', () => {
  config.write({ origin: 'https://preserva.com', token: 'tk', autostart: true });
  config.write({ autostart: false });
  const read = config.read();
  assert.equal(read.origin, 'https://preserva.com');
  assert.equal(read.token, 'tk');
  assert.equal(read.autostart, false);
});

test('read: JSON corrompido no disco cai nos DEFAULTS em vez de lançar', () => {
  fs.mkdirSync(path.dirname(config.FILE), { recursive: true });
  fs.writeFileSync(config.FILE, '{ isso não é json válido');
  const read = config.read();
  assert.equal(read.origin, '');
  assert.equal(read.offline, true);
});

test('normalizeDomain: vazio devolve vazio', () => {
  assert.equal(config.normalizeDomain(''), '');
  assert.equal(config.normalizeDomain('   '), '');
});

test('normalizeDomain: aceita domínio nu e assume https', () => {
  assert.equal(config.normalizeDomain('suaempresa.com.br'), 'https://suaempresa.com.br');
});

test('normalizeDomain: preserva scheme e porta já informados', () => {
  assert.equal(config.normalizeDomain('http://site.com:8080'), 'http://site.com:8080');
});

test('normalizeDomain: tira caminho e barra final', () => {
  assert.equal(config.normalizeDomain('https://site.com/play/xxxx'), 'https://site.com');
  assert.equal(config.normalizeDomain('site.com/'), 'https://site.com');
});

test('normalizeDomain: string inválida devolve vazio', () => {
  assert.equal(config.normalizeDomain('não é um domínio'), '');
});
