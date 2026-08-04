/**
 * "Última versão boa" do payload (o ORIGINAL, sem reescrita de URL). Persistido em disco para
 * o app abrir offline após um reboot. A reescrita para 127.0.0.1 é feita na hora de servir
 * (server.js), então a porta local nunca fica gravada.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let mem = null;
function file() { return path.join(app.getPath('userData'), 'last-good.json'); }

function get() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e) { mem = null; }
  return mem;
}

function set(payload) {
  mem = payload || null;
  try { fs.writeFileSync(file(), JSON.stringify(mem)); } catch (e) { /* tolera disco cheio */ }
}

function clear() {
  mem = null;
  try { fs.unlinkSync(file()); } catch (e) { /* já não existe */ }
}

module.exports = { get, set, clear };
