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
const active = new Map();
const cancelers = new Set();
let generation = 0;

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
    const file = filePath(url);
    const size = fs.statSync(file).size;
    if (size <= 0) return false;
    // Legacy files remain playable offline, but sync will re-download them once.
    if (!fs.existsSync(file + '.verified')) return true;
    return Number(fs.readFileSync(file + '.verified', 'utf8')) === size;
  } catch (e) {
    return false;
  }
}

function isVerified(url) {
  return fs.existsSync(filePath(url) + '.verified') && has(url);
}

/** Baixa a URL para o disco (atômico). Resolve com o caminho local; rejeita em erro/HTTP != 200. */
function downloadAttempt(url, epoch, idleMs) {
  return new Promise((resolve, reject) => {
    const dst = filePath(url);
    const part = dst + '.' + crypto.randomUUID() + '.part';
    const out = fs.createWriteStream(part);
    let req;
    let failed = false, ended = false, bytes = 0, expected = null, timer;
    const removePart = () => { try { fs.unlinkSync(part); } catch (_) {} };
    const cleanup = () => { clearTimeout(timer); cancelers.delete(cancel); };
    const fail = (e) => {
      if (failed) return;
      failed = true;
      cleanup();
      try { if (req) req.abort(); } catch (_) {}
      const finish = () => { removePart(); reject(e instanceof Error ? e : new Error(String(e))); };
      if (out.closed) finish();
      else { out.once('close', finish); out.destroy(); }
    };
    const cancel = () => fail(new Error('Download cancelado'));
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('Download sem progresso')), idleMs); };
    cancelers.add(cancel);
    out.on('error', fail);
    out.on('finish', () => {
      if (!ended || bytes <= 0 || (expected !== null && bytes !== expected)) fail(new Error('Download incompleto'));
    });
    out.on('close', () => {
      if (failed) return;
      if (!ended || !out.writableFinished || epoch !== generation) return fail(new Error('Download cancelado ou incompleto'));
      try {
        // Close the descriptor before rename: required on Windows.
        fs.writeFileSync(part + '.verified', String(bytes));
        fs.renameSync(part, dst);
        fs.renameSync(part + '.verified', dst + '.verified');
        cleanup();
        resolve(dst);
      } catch (e) {
        try { fs.unlinkSync(part + '.verified'); } catch (_) {}
        fail(e);
      }
    });
    try { req = net.request({ method: 'GET', url, redirect: 'follow' }); }
    catch (e) { fail(e); return; }
    req.setHeader('Accept-Encoding', 'identity');
    req.setHeader('Cache-Control', 'no-cache');
    req.on('response', (res) => {
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('Download interrompido')));
      if (res.statusCode !== 200 || res.headers['content-range']) return fail(new Error('Resposta parcial ou HTTP ' + res.statusCode));
      const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
      if (encoding !== 'identity') return fail(new Error('Codificação inesperada na mídia'));
      const length = res.headers['content-length'];
      if (length !== undefined) {
        expected = Number(length);
        if (!Number.isSafeInteger(expected) || expected <= 0) return fail(new Error('Tamanho de mídia inválido'));
      }
      if (/^(text\/html|application\/json)/i.test(String(res.headers['content-type'] || ''))) return fail(new Error('Resposta não é mídia'));
      res.on('end', () => { ended = true; });
      res.on('data', (chunk) => { bytes += chunk.length; touch(); });
      res.pipe(out);
    });
    req.on('error', fail);
    req.on('abort', () => fail(new Error('Download cancelado')));
    touch();
    req.end();
  });
}

function download(url, options = {}) {
  if (active.has(url)) return active.get(url);
  const epoch = generation;
  const promise = (async () => {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (epoch !== generation) throw new Error('Download cancelado');
      try { return await downloadAttempt(url, epoch, options.idleMs || 60000); }
      catch (e) { error = e; }
    }
    throw error;
  })().finally(() => { if (active.get(url) === promise) active.delete(url); });
  active.set(url, promise);
  return promise;
}

function cancelDownloads() {
  generation++;
  for (const cancel of [...cancelers]) cancel();
  active.clear();
}

/** Remove do disco os arquivos que não estão mais no conjunto de URLs em uso. */
function prune(keepUrls) {
  const keep = new Set((keepUrls || []).map(fileName));
  for (const name of [...keep]) keep.add(name + '.verified');
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir())) {
      if (f.endsWith('.part') && active.size) continue;
      if (!keep.has(f)) { try { fs.unlinkSync(path.join(dir(), f)); removed++; } catch (_) {} }
    }
  } catch (e) { /* pasta pode não existir ainda */ }
  return removed;
}

/** Apaga toda a mídia local (reset do cache offline). Devolve quantos arquivos removeu. */
function clear() {
  cancelDownloads();
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir())) {
      try { fs.unlinkSync(path.join(dir(), f)); removed++; } catch (e) { /* ignora arquivo travado */ }
    }
  } catch (e) { /* pasta pode não existir */ }
  return removed;
}

module.exports = { dir, fileName, filePath, has, isVerified, download, prune, clear, cancelDownloads, extOf, generation: () => generation };
