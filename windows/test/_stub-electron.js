/**
 * `require('electron')` só existe rodando dentro do Electron de verdade — fora dele (Node puro,
 * é como `node --test` roda) o require falha. Este arquivo registra um `electron` falso no cache
 * de módulos do Node ANTES de qualquer teste importar config.js/cache.js/resolve.js/server.js,
 * pra exercitar a lógica real desses arquivos (não uma cópia reimplementada — cópia diverge do
 * código de verdade com o tempo) sem precisar do binário do Electron rodando.
 *
 * `app.getPath('userData')` aponta pra uma pasta temporária isolada por processo de teste, então
 * rodar os testes não mexe no config/cache real do app instalado.
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsview-test-'));

const stub = {
  app: {
    getPath: (name) => (name === 'userData' ? userDataDir : os.tmpdir()),
  },
  net: {
    // Nenhum teste unitário aqui faz requisição de rede de verdade — chamar isto é bug do teste.
    request: () => { throw new Error('net.request() não disponível no stub de teste'); },
  },
};

const VIRTUAL_ID = '\0electron-stub';
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return VIRTUAL_ID;
  return originalResolve.call(this, request, ...rest);
};
require.cache[VIRTUAL_ID] = {
  id: VIRTUAL_ID,
  filename: VIRTUAL_ID,
  loaded: true,
  exports: stub,
};

module.exports = { userDataDir };
