/**
 * Config persistente do app (JSON em userData). Guarda a URL/token da playlist ativa,
 * o device_token retornado pelo /auth, os favoritos e as preferências (auto-start).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'dsview-config.json');

const SYNC_MIN = 5;
const SYNC_MAX = 1440; // 24h
const SYNC_DEFAULT = 60;

const DEFAULTS = {
  origin: '', // ex.: https://seusite.com.br
  token: '', // token público da playlist ativa
  device: '', // device_token guardado após o 1º /auth (permite offline sem re-senha)
  favorites: [], // [{ name, url }]
  autostart: false,
  offline: true, // modo offline-first (cache local). false = consome só o servidor online.
  syncInterval: SYNC_DEFAULT, // minutos entre consultas à playlist (5..1440)
  lastUrl: '', // última URL colada no setup (para reexibir)
  quitUntilBoot: null, // boot-id em que o usuário fechou de propósito (ver bootId() no main.js)
};

/** Intervalo de sync em minutos, sempre dentro dos limites (5..1440). */
function syncIntervalMin(cfg) {
  cfg = cfg || read();
  const m = parseInt(cfg.syncInterval, 10);
  if (!isFinite(m)) return SYNC_DEFAULT;
  return Math.min(SYNC_MAX, Math.max(SYNC_MIN, m));
}

/** Grava o intervalo (clampeado) e devolve o valor efetivo. */
function setSyncInterval(minutes) {
  const m = syncIntervalMin({ syncInterval: minutes });
  write({ syncInterval: m });
  return m;
}

function read() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function write(patch) {
  const next = Object.assign(read(), patch || {});
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    /* melhor tolerar falha de disco do que crashar o kiosk */
  }
  return next;
}

/** REST base da API do player para a playlist ativa (null se não configurada). */
function realApi(cfg) {
  cfg = cfg || read();
  if (!cfg.origin || !cfg.token) return null;
  return cfg.origin.replace(/\/$/, '') + '/wp-json/ds-facil/v1/player/' + encodeURIComponent(cfg.token);
}

module.exports = { read, write, realApi, syncIntervalMin, setSyncInterval, FILE, SYNC_MIN, SYNC_MAX, SYNC_DEFAULT };
