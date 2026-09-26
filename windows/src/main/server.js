/**
 * Servidor HTTP local (só 127.0.0.1, porta alta aleatória). Imita a forma da API do player,
 * então o player.js roda IDÊNTICO — sem saber que está falando com o cache local:
 *   GET  /state[?t=&device=]  → última versão boa (reescrita p/ /media/{hash} quando cacheada)
 *   POST /state/auth          → repassa pro servidor real; guarda device; cacheia; devolve ao player
 *   GET  /media/:name         → arquivo do disco (com suporte a Range → 206, essencial p/ vídeo)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const cache = require('./cache');
const state = require('./state');
const sync = require('./sync');

let port = 0;

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
};

/** Reescreve os src das mídias cacheadas para o servidor local (deixa YouTube/Vimeo/não-cacheado como está). */
function rewrite(payload) {
  if (!payload) return payload;
  const copy = JSON.parse(JSON.stringify(payload));
  for (const it of copy.queue || []) {
    if (it.provider === 'youtube' || it.provider === 'vimeo') continue;
    for (const key of ['src', 'fallback_src', 'source_logo']) {
      if (it[key] && cache.has(it[key])) {
        it[key] = 'http://127.0.0.1:' + port + '/media/' + cache.fileName(it[key]);
      }
    }
  }
  return copy;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS));
  res.end(body);
}

// Basename controlado (sha1 + extensão curta) — barra path traversal (`../`, `/`, caminho absoluto)
// por construção: nada que não bata com este formato exato passa. Exportado pro teste unitário
// não precisar reimplementar o regex (e divergir dele com o tempo).
const MEDIA_NAME_RE = /^[a-f0-9]{40}\.[a-z0-9]{1,5}$/;

function parseRange(range, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
  if (!m || (!m[1] && !m[2]) || size <= 0) return null;
  let start, end;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function serveMedia(req, res, name) {
  if (!MEDIA_NAME_RE.test(name)) { res.writeHead(400); return res.end(); }
  const file = path.join(cache.dir(), name);
  let stat;
  try { stat = fs.statSync(file); } catch (e) { res.writeHead(404); return res.end(); }

  const type = MIME[path.extname(name)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const parsed = parseRange(range, stat.size);
    if (!parsed) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); return res.end(); }
    const { start, end } = parsed;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    pipeAndClean(fs.createReadStream(file, { start, end }), res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    pipeAndClean(fs.createReadStream(file), res);
  }
}

// .pipe() sozinho não fecha a origem se o destino (res) morre antes do 'end' — TV fazendo
// seek/scrub o dia todo gera um Range request abortado atrás do outro; sem isto cada um deixa
// um file handle aberto (vaza descriptor até o processo travar depois de dias no ar).
function pipeAndClean(readStream, res) {
  const cleanup = () => readStream.destroy();
  res.on('close', cleanup);
  readStream.on('error', () => { cleanup(); res.destroy(); });
  readStream.pipe(res);
}

async function proxyAuth(req, res) {
  const cfg = config.read();
  const api = config.realApi(cfg);
  const epoch = cache.generation();
  if (!api) return sendJson(res, { status: 'offline' });

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 16384) req.destroy();
  });
  req.on('error', () => { if (!res.destroyed) res.destroy(); });
  req.on('end', async () => {
    try {
      const input = JSON.parse(body || '{}');
      if (epoch !== cache.generation() || config.realApi(config.read()) !== api) return sendJson(res, { status: 'offline' });
      const result = await sync.authenticate(typeof input.password === 'string' ? input.password : '');
      if (res.destroyed) return;
      if (epoch !== cache.generation() || config.realApi(config.read()) !== api) return sendJson(res, { status: 'offline' });
      if (result.status !== 'ok') return sendJson(res, result);
      const good = state.get();
      return sendJson(res, good ? { status: 'ok', device: config.read().device, payload: rewrite(good) } : { status: 'offline' });
    } catch (_) {
      if (!res.destroyed && !res.writableEnded) sendJson(res, { status: 'offline' });
    }
  });
}

function handler(req, res) {
  // Um handler HTTP do Node não tem try/catch implícito: uma exceção síncrona aqui dentro
  // (ex.: decodeURIComponent com % inválido) sobe até derrubar o processo INTEIRO do Electron,
  // não só essa requisição — e este servidor está em 127.0.0.1, alcançável por qualquer processo
  // local (sessão de suporte remoto, outro software na máquina), não só o player.
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); } // preflight do fetch.
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/state') {
      const lg = state.get();
      return sendJson(res, lg ? { status: 'ok', payload: rewrite(lg) } : { status: 'offline' });
    }
    if (req.method === 'POST' && url === '/state/auth') return proxyAuth(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/media/')) return serveMedia(req, res, decodeURIComponent(url.slice('/media/'.length)));
    res.writeHead(404); res.end();
  } catch (e) {
    try { res.writeHead(400); res.end(); } catch (e2) { /* resposta já em andamento, nada a fazer */ }
  }
}

/** Sobe o servidor em 127.0.0.1:porta-aleatória. Resolve com a porta, rejeita se não conseguir subir
 *  (ex.: antivírus/firewall bloqueando o loopback) — sem isto o 'error' do socket ficava sem
 *  listener, o que o Node trata como exceção não capturada e derruba o app antes da janela abrir. */
function start() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { port = srv.address().port; resolve(port); });
  });
}

module.exports = { start, getPort: () => port, rewrite, MEDIA_NAME_RE, handler, parseRange };
