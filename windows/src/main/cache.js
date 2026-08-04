/**
 * Cache de mídia local (espelho do conteúdo online no disco).
 * Nome do arquivo = sha1(url) + extensão → determinístico (sem manifesto).
 * Download é ATÔMICO: baixa para .part e só renomeia no fim; queda no meio nunca deixa arquivo truncado.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, net } = require('electron');

function dir() {
  const d = path.join(app.getPath('userData'), 'media');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-zA-Z0-9]{1,5})$/);
    return m ? '.' + m[1].toLowerCase() : '.bin';
  } catch (e) {
    return '.bin';
  }
}

/** Nome de arquivo local determinístico para uma URL de mídia. */
function fileName(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex') + extOf(url);
}

function filePath(url) {
  return path.join(dir(), fileName(url));
}

function has(url) {
  try {
    return fs.statSync(filePath(url)).size > 0;
  } catch (e) {
    return false;
  }
}

/** Baixa a URL para o disco (atômico). Resolve com o caminho local; rejeita em erro/HTTP != 200. */
function download(url) {
  return new Promise((resolve, reject) => {
    const dst = filePath(url);
    const part = dst + '.part';
    const out = fs.createWriteStream(part);
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      try { out.destroy(); } catch (_) {}
      fs.unlink(part, () => {});
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    req.on('response', (res) => {
      if (res.statusCode !== 200) return fail(new Error('HTTP ' + res.statusCode + ' ao baixar ' + url));
      res.pipe(out);
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (failed) return;
        fs.rename(part, dst, (err) => (err ? fail(err) : resolve(dst)));
      });
    });
    req.on('error', fail);
    req.end();
  });
}

/** Remove do disco os arquivos que não estão mais no conjunto de URLs em uso. */
function prune(keepUrls) {
  const keep = new Set((keepUrls || []).map(fileName));
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir())) {
      if (f.endsWith('.part')) { fs.unlink(path.join(dir(), f), () => {}); continue; }
      if (!keep.has(f)) { fs.unlink(path.join(dir(), f), () => {}); removed++; }
    }
  } catch (e) { /* pasta pode não existir ainda */ }
  return removed;
}

/** Apaga toda a mídia local (reset do cache offline). Devolve quantos arquivos removeu. */
function clear() {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir())) {
      try { fs.unlinkSync(path.join(dir(), f)); removed++; } catch (e) { /* ignora arquivo travado */ }
    }
  } catch (e) { /* pasta pode não existir */ }
  return removed;
}

module.exports = { dir, fileName, filePath, has, download, prune, clear, extOf };
