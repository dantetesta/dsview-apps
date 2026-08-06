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
  // Mesmo motivo do config.js: rename é atômico, escrever direto no arquivo final não é — queda
  // de energia no meio do write corrompe o "última versão boa" e a TV não reabre offline no boot.
  try {
    const f = file();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem));
    fs.renameSync(tmp, f);
  } catch (e) { /* tolera disco cheio */ }
}

function clear() {
  mem = null;
  try { fs.unlinkSync(file()); } catch (e) { /* já não existe */ }
}

module.exports = { get, set, clear };
