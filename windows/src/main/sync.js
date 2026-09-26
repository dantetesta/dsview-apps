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
let activeSync = null;
const DOWNLOAD_WORKERS = 3;

const HEARTBEAT_MS = 60000;
const HEARTBEAT_JITTER_MS = 15000;

/** Espalha aparelhos que ligaram juntos para não criar um pico de requisições a cada minuto. */
function heartbeatDelay(random = Math.random()) {
  return HEARTBEAT_MS + Math.floor(Math.max(0, Math.min(1, random)) * HEARTBEAT_JITTER_MS);
}

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
        out.push({ url, video: key === 'src' && (it.kind === 'video' || /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url)) });
      }
    }
  }
  return out.sort((a, b) => Number(a.video) - Number(b.video)).map((entry) => entry.url);
}

function fetchJson(url) {
  return requestJson(url);
}

function postJson(url, obj) {
  return requestJson(url, obj);
}

function requestJson(url, obj) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: obj === undefined ? 'GET' : 'POST', url, redirect: 'follow' });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) { reject(error); try { req.abort(); } catch (_) {} }
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('Consulta sem resposta')), 30000);
    if (obj !== undefined) req.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('response', (res) => {
      res.on('error', (e) => finish(e));
      res.on('aborted', () => finish(new Error('Consulta interrompida')));
      if (res.statusCode !== 200) return finish(new Error('HTTP ' + res.statusCode));
      res.on('end', () => {
        try { finish(null, JSON.parse(body)); } catch (e) { finish(new Error('resposta inválida')); }
      });
      res.on('data', (c) => {
        body += c;
        if (body.length > 10 * 1024 * 1024) finish(new Error('Resposta excede limite'));
      });
    });
    req.on('error', (e) => finish(e));
    if (obj !== undefined) req.write(JSON.stringify(obj || {}));
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
  const epoch = cache.generation();
  const current = () => epoch === cache.generation() && config.realApi(config.read()) === api;
  if (!api) return { status: 'not-configured' };
  let res;
  try {
    res = await postJson(api + '/auth', { password: password || '', ...telemetry(cfg) });
  } catch (e) {
    const lg = state.get();
    return (current() && cfg.device && lg) ? { status: 'ok' } : { status: 'offline' };
  }
  if (res && res.status === 'ok') {
    if (!current()) return { status: 'offline' };
    if (res.device) config.write({ device: res.device });
    const result = await syncOnce();
    if (!current()) return { status: 'offline' };
    if (!result.ok && cfg.offline !== false && !state.get()) return { status: 'download-failed' };
    return { status: 'ok' };
  }
  return res || { status: 'offline' }; // password | expired | notfound...
}

/** Uma passada de sincronização. Não lança: devolve um resumo (para o preloader/log). */
function syncOnce() {
  const cfg = config.read();
  const epoch = cache.generation();
  const key = JSON.stringify([config.realApi(cfg), cfg.device, cfg.offline, epoch]);
  if (activeSync && activeSync.key === key) return activeSync.promise;
  const previous = activeSync && activeSync.promise;
  const promise = (async () => {
    if (previous) await previous.catch(() => {});
    if (epoch !== cache.generation() || config.realApi(config.read()) !== config.realApi(cfg)) return { ok: false, reason: 'cancelled' };
    return syncPass(cfg, epoch);
  })().catch(() => ({ ok: false, reason: 'sync-failed' })).finally(() => {
    if (activeSync && activeSync.promise === promise) activeSync = null;
  });
  activeSync = { key, promise };
  return promise;
}

async function syncPass(cfg, epoch) {
  if (cfg.offline === false) return { ok: false, reason: 'online-only' }; // modo só-online: nada de cache.
  const api = config.realApi(cfg);
  if (!api) return { ok: false, reason: 'not-configured' };
  const current = () => epoch === cache.generation() && config.realApi(config.read()) === api && config.read().offline !== false;

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
  if (!current()) return { ok: false, reason: 'cancelled' };
  const prev = state.get();

  // Baixa o que falta (só o novo/alterado — o resto já está no disco).
  const urls = cacheableUrls(payload);
  let downloaded = 0;
  const missing = urls.filter((url) => !cache.isVerified(url));
  if (!missing.length && prev && prev.version && prev.version === payload.version) {
    lastSyncAt = new Date().toISOString();
    return { ok: true, changed: false };
  }
  let cursor = 0, completed = urls.length - missing.length, failed = 0;
  onStatus({ phase: 'downloading', current: completed, total: urls.length });
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_WORKERS, missing.length) }, async () => {
    while (cursor < missing.length && current()) {
      const url = missing[cursor++];
      try { await cache.download(url); downloaded++; } catch (_) { failed++; }
      completed++;
      if (current()) onStatus({ phase: 'downloading', current: completed, total: urls.length });
    }
  }));
  if (!current()) return { ok: false, reason: 'cancelled' };
  if (failed || !urls.every((url) => cache.isVerified(url))) {
    onStatus({ phase: 'offline' });
    return { ok: false, reason: 'download-failed', downloaded, failed };
  }

  // Troca atômica: só depois de tudo no disco, aponta a "última versão boa" para o novo payload.
  if (!state.set(payload)) return { ok: false, reason: 'storage-failed' };
  const removed = cache.prune(urls);
  lastSyncAt = new Date().toISOString();
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

function scheduleHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  const beat = () => {
    heartbeatTimer = setTimeout(async () => {
      await heartbeatOnce().catch(() => {});
      if (heartbeatTimer !== null) beat();
    }, heartbeatDelay());
  };
  beat();
}

function start(statusCb) {
  onStatus = statusCb || (() => {});
  schedule();
  tick(); // primeira passada imediata (respeita offline/not-configured lá dentro).
  heartbeatOnce().catch(() => {});
  scheduleHeartbeat();
}

/** Reaplica o intervalo depois que o usuário o altera no setup. */
function restart() { schedule(); }

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
}

module.exports = { start, stop, restart, syncOnce, authenticate, heartbeatOnce, telemetry, setHealth, cacheableUrls, heartbeatDelay, HEARTBEAT_MS, HEARTBEAT_JITTER_MS };
