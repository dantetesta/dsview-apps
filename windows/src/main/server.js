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
const { net } = require('electron');
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
    if (it.src && cache.has(it.src)) {
      it.src = 'http://127.0.0.1:' + port + '/media/' + cache.fileName(it.src);
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

function serveMedia(req, res, name) {
  if (!MEDIA_NAME_RE.test(name)) { res.writeHead(400); return res.end(); }
  const file = path.join(cache.dir(), name);
  let stat;
  try { stat = fs.statSync(file); } catch (e) { res.writeHead(404); return res.end(); }

  const type = MIME[path.extname(name)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
    });
    pipeAndClean(fs.createReadStream(file, { start, end }), res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    pipeAndClean(fs.createReadStream(file), res);
  }
}

// .pipe() sozinho não fecha a origem se o destino (res) morre antes do 'end' — TV fazendo
// seek/scrub o dia todo gera um Range request abortado atrás do outro; sem isto cada um deixa
// um file handle aberto (vaza descriptor até o processo travar depois de dias no ar).
function pipeAndClean(readStream, res) {
  const cleanup = () => readStream.destroy();
  res.on('close', cleanup);
  readStream.on('error', cleanup);
  readStream.pipe(res);
}

async function proxyAuth(req, res) {
  const cfg = config.read();
  const api = config.realApi(cfg);
  if (!api) return sendJson(res, { status: 'offline' });

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const upstream = net.request({ method: 'POST', url: api + '/auth', redirect: 'follow' });
    upstream.setHeader('Content-Type', 'application/json');
    let out = '';
    upstream.on('response', (r) => {
      r.on('data', (c) => (out += c));
      r.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(out); } catch (e) { return sendJson(res, { status: 'offline' }); }
        if (parsed && parsed.status === 'ok') {
          if (parsed.device) config.write({ device: parsed.device });
          if (parsed.payload) { state.set(parsed.payload); sync.syncOnce().catch(() => {}); parsed.payload = rewrite(parsed.payload); }
        }
        sendJson(res, parsed);
      });
      r.on('error', () => sendJson(res, { status: 'offline' }));
    });
    upstream.on('error', () => {
      // Sem internet: se já autenticou antes e tem cache, deixa o player seguir pelo /state.
      const lg = state.get();
      sendJson(res, lg ? { status: 'ok', device: config.read().device, payload: rewrite(lg) } : { status: 'offline' });
    });
    upstream.write(body || '{}');
    upstream.end();
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
    if (req.method === 'GET' && url.startsWith('/media/')) return serveMedia(req, res, decodeURIComponent(url.slice('/media/'.length)));
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

module.exports = { start, getPort: () => port, rewrite, MEDIA_NAME_RE };
