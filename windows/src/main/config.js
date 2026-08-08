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

// Janela em que uma reabertura é tratada como "auto-relançador externo" (acesso atribuído, agendador)
// tentando religar na hora, contra a vontade de quem acabou de fechar. Windows não expõe um jeito
// confiável de saber SE um lançamento veio do Run-key (wasOpenedAtLogin só existe no macOS — checado
// nas definições do Electron antes de assumir), então o sinal disponível é o tempo: um relançador
// automático dispara em segundos; um humano reabrindo de propósito normalmente demora mais que isso.
// Curta o bastante pra não incomodar quem clica duas vezes no ícone minutos depois.
const AUTO_RELAUNCH_SUPPRESS_MS = 8000;

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
  quitAt: null, // timestamp (ms) desse fechamento — usado por shouldSuppressStartup() pra não
  // suprimir reaberturas manuais, só a rajada instantânea de auto-relançador externo.
  baseDomain: '', // domínio do sistema (ex.: https://suaempresa.com.br), configurado 1x no setup.
  // Com ele definido, o setup aceita só o código da playlist em vez do link completo. Independente
  // do `origin` (que é o domínio da playlist ATIVA) — trocar de playlist não perde o domínio.
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
    // Escreve num arquivo temporário e troca de nome (rename é atômico no mesmo volume) — grava
    // direto no arquivo final deixava uma janela onde uma queda de energia no meio do write (TV
    // sem nobreak, é o cenário normal) corrompe o JSON e apaga origin/token/device/favoritos.
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    /* melhor tolerar falha de disco do que crashar o kiosk */
  }
  return next;
}

/** Marca que o usuário fechou de propósito neste boot (menu "Sair", Ctrl+Shift+Q, "Encerrar",
 * ou desligar/recusar o auto-start). Grava o instante junto — é o que permite reabertura manual
 * funcionar minutos depois, mesmo dentro do mesmo boot (ver shouldSuppressStartup). */
function suppressAutoRelaunch(bootId) {
  write({ quitUntilBoot: bootId, quitAt: Date.now() });
}

/** Este lançamento deveria ser recusado (auto-relançador batendo na hora)? Só suprime dentro da
 * janela curta pós-fechamento — depois disso, qualquer lançamento (inclusive manual) é normal. */
function shouldSuppressStartup(bootId, now) {
  const cfg = read();
  if (cfg.quitUntilBoot !== bootId) return false;
  // Sem timestamp (config de uma versão anterior a este fix, atualizada sem reiniciar o Windows no
  // meio): não suprime — o modo seguro aqui é o app ABRIR, nunca ficar preso "morto" até o reboot.
  if (typeof cfg.quitAt !== 'number') return false;
  return (typeof now === 'number' ? now : Date.now()) - cfg.quitAt < AUTO_RELAUNCH_SUPPRESS_MS;
}

/** REST base da API do player para a playlist ativa (null se não configurada). */
function realApi(cfg) {
  cfg = cfg || read();
  if (!cfg.origin || !cfg.token) return null;
  return cfg.origin.replace(/\/$/, '') + '/wp-json/ds-facil/v1/player/' + encodeURIComponent(cfg.token);
}

/**
 * Normaliza o que o usuário digitar em "Domínio do sistema" ("suaempresa.com.br",
 * "https://suaempresa.com.br/", "site.com:8080"...) para um origin limpo
 * ("https://suaempresa.com.br"), ou '' se não der pra interpretar como domínio/URL.
 */
function normalizeDomain(input) {
  const t = String(input || '').trim();
  if (!t) return '';
  const withScheme = /^https?:\/\//i.test(t) ? t : 'https://' + t;
  try {
    const u = new URL(withScheme);
    return u.host ? u.origin : '';
  } catch (e) {
    return '';
  }
}

module.exports = {
  read, write, realApi, normalizeDomain, syncIntervalMin, setSyncInterval, FILE, SYNC_MIN, SYNC_MAX, SYNC_DEFAULT,
  suppressAutoRelaunch, shouldSuppressStartup, AUTO_RELAUNCH_SUPPRESS_MS,
};
