/**
 * Loop de sincronização: o coração do modo offline.
 * A cada ~30s busca o payload REAL do servidor; se mudou, baixa a mídia nova, remove a que saiu
 * e grava como "última versão boa". O player nunca fala com o servidor remoto — só com o servidor
 * local (server.js), que responde na hora do cache. Assim, se a internet cair, o player segue tocando.
 */
'use strict';
const { net } = require('electron');
const config = require('./config');
const cache = require('./cache');
const state = require('./state');
const appVersion = require('../../package.json').version;

let timer = null;
let heartbeatTimer = null;
let running = false;
let onStatus = () => {};
let lastSyncAt = '';
let healthOverride = '';
let healthError = '';

const HEARTBEAT_MS = 60000;

/** URLs de mídia cacheáveis do payload (imagem e vídeo próprio; YouTube/Vimeo não). */
function cacheableUrls(payload) {
  const out = [];
  const seen = new Set();
  for (const it of (payload && payload.queue) || []) {
    if (it.provider === 'youtube' || it.provider === 'vimeo') continue;
    for (const key of ['src', 'fallback_src', 'source_logo']) {
      const url = it[key];
      if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('resposta inválida')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'POST', url, redirect: 'follow' });
    req.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('response', (res) => {
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('resposta inválida')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(JSON.stringify(obj || {}));
    req.end();
  });
}

/**
 * Autentica no servidor real (`/auth`) com a senha (se houver). Em `ok`, guarda o device de sessão
 * eterna e baixa a mídia. Devolve `{status}` para o setup reagir (`ok`/`password`/`expired`/`offline`).
 */
async function authenticate(password) {
  const cfg = config.read();
  const api = config.realApi(cfg);
  if (!api) return { status: 'not-configured' };
  let res;
  try {
    res = await postJson(api + '/auth', { password: password || '', ...telemetry(cfg) });
  } catch (e) {
    const lg = state.get();
    return (cfg.device && lg) ? { status: 'ok' } : { status: 'offline' }; // sem rede: vale o device+cache já salvos.
  }
  if (res && res.status === 'ok') {
    if (res.device) config.write({ device: res.device });
    await syncOnce().catch(() => {}); // baixa a mídia já com o device novo (preloader escuta o progresso).
    return { status: 'ok' };
  }
  return res || { status: 'offline' }; // password | expired | notfound...
}

/** Uma passada de sincronização. Não lança: devolve um resumo (para o preloader/log). */
async function syncOnce() {
  const cfg = config.read();
  if (cfg.offline === false) return { ok: false, reason: 'online-only' }; // modo só-online: nada de cache.
  const api = config.realApi(cfg);
  if (!api) return { ok: false, reason: 'not-configured' };

  const url = api + '?t=' + Date.now() + (cfg.device ? '&device=' + encodeURIComponent(cfg.device) : '');
  let res;
  try {
    res = await fetchJson(url);
  } catch (e) {
    onStatus({ phase: 'offline' }); // sem rede: mantém o cache como está.
    return { ok: false, reason: 'offline' };
  }

  if (!res || res.status !== 'ok' || !res.payload) {
    return { ok: false, reason: res && res.status ? res.status : 'no-payload' };
  }

  const payload = res.payload;
  lastSyncAt = new Date().toISOString();
  const prev = state.get();
  if (prev && prev.version && prev.version === payload.version) {
    return { ok: true, changed: false }; // nada mudou.
  }

  // Baixa o que falta (só o novo/alterado — o resto já está no disco).
  const urls = cacheableUrls(payload);
  let downloaded = 0;
  let idx = 0;
  for (const u of urls) {
    idx++;
    onStatus({ phase: 'downloading', current: idx, total: urls.length });
    if (cache.has(u)) continue;
    try { await cache.download(u); downloaded++; } catch (e) { /* item falho: online ainda toca da origem */ }
  }

  // Troca atômica: só depois de tudo no disco, aponta a "última versão boa" para o novo payload.
  state.set(payload);
  const removed = cache.prune(urls);
  onStatus({ phase: 'ready' });
  return { ok: true, changed: true, downloaded, removed, total: urls.length };
}

/** Fotografia pequena enviada ao monitoramento; nunca inclui URL, senha ou conteúdo da playlist. */
function telemetry(cfg) {
  cfg = cfg || config.read();
  const health = healthOverride || 'healthy';
  return {
    platform: 'windows',
    app_version: appVersion,
    mode: cfg.offline === false ? 'online' : 'offline_cache',
    health,
    last_error: health === 'degraded' ? healthError : '',
    last_sync_at: lastSyncAt,
  };
}

/** Heartbeat independente do download de mídia. Falha de rede é esperada e nunca derruba o kiosk. */
async function heartbeatOnce() {
  const cfg = config.read();
  const api = config.realApi(cfg);
  if (!api || !cfg.device) return { ok: false, reason: 'not-authenticated' };
  try {
    const res = await postJson(api + '/heartbeat', { device: cfg.device, ...telemetry(cfg) });
    return { ok: !!(res && res.status === 'ok') };
  } catch (e) {
    return { ok: false, reason: 'offline' };
  }
}

/** Main process informa travamento/recuperação do renderizador. */
function setHealth(health, error) {
  healthOverride = health === 'degraded' ? 'degraded' : '';
  healthError = healthOverride ? String(error || 'Player com problema').slice(0, 255) : '';
}

async function tick() {
  if (running) return;
  running = true;
  try { await syncOnce(); } catch (e) { /* nunca deixa o loop morrer */ }
  running = false;
}

/** (Re)agenda o timer com o intervalo salvo em config. */
function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, config.syncIntervalMin() * 60000);
}

function start(statusCb) {
  onStatus = statusCb || (() => {});
  schedule();
  tick(); // primeira passada imediata (respeita offline/not-configured lá dentro).
  heartbeatOnce().catch(() => {});
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => heartbeatOnce().catch(() => {}), HEARTBEAT_MS);
}

/** Reaplica o intervalo depois que o usuário o altera no setup. */
function restart() { schedule(); }

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

module.exports = { start, stop, restart, syncOnce, authenticate, heartbeatOnce, telemetry, setHealth, cacheableUrls, HEARTBEAT_MS };
