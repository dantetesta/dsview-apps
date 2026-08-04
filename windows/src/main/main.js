/**
 * DS View — processo principal.
 * Casca kiosk fullscreen + servidor local (cache offline) + loop de sync. Sem barra de URL:
 * botão direito, ESC ou o "x" discreto do canto abrem o menu/as configurações (Configurações /
 * Recarregar / Sair). Auto-start no boot opcional — mas só entra sozinho no boot: se o usuário
 * fechar de propósito, fica fechado até o Windows reiniciar de novo (ver `quitForGood()`).
 */
'use strict';
const path = require('path');
const os = require('os');
const { execFile } = require('child_process'); // usado só para ler o registro do Windows (login automático)
const {
  app, BrowserWindow, Menu, ipcMain, powerSaveBlocker, globalShortcut,
} = require('electron');

const config = require('./config');
const resolve = require('./resolve');
const server = require('./server');
const sync = require('./sync');
const cache = require('./cache');
const state = require('./state');

// TV/kiosk: libera autoplay COM som sem exigir gesto do usuário (respeitando o flag `audio` de cada item).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let port = 0;

// Fingerprint estável do boot atual do Windows (epoch do momento em que ligou). `os.uptime()` anda
// junto com `Date.now()`, então `agora - uptime` dá sempre o mesmo instante, boot afora — sem
// precisar ler nada do Windows. É o que decide "abrir sozinho só depois de reiniciar":
// ver `quitForGood()`/o guard em `whenReady()`.
function bootId() {
  return Math.round(Date.now() / 1000 - os.uptime());
}

/** Fecho pedido pelo usuário (menu, atalho, botão "Encerrar" do setup): marca o boot atual como
 * "fechado de propósito" antes de sair. Enquanto for o mesmo boot, o app não volta sozinho — nem
 * se algo de fora (agendador, acesso atribuído) tentar reabrir. Só um novo boot libera de novo. */
function quitForGood() {
  config.write({ quitUntilBoot: bootId() });
  app.quit();
}

/** ESC ou o "x" do canto: sai do kiosk (recupera decoração/taskbar) e vai pras configurações —
 * sem fechar o app. Quem quer encerrar de verdade usa o botão "Encerrar" de lá. */
function exitKioskToSetup() {
  if (!win || win.isDestroyed()) return;
  win.setKiosk(false);
  win.setFullScreen(false);
  loadSetup();
}

// ---------------------------------------------------------------- janela
function createWindow() {
  win = new BrowserWindow({
    show: false,
    fullscreen: true,
    frame: false,
    kiosk: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // TV desatendida não pode "dormir" a renderização.
    },
  });
  win.once('ready-to-show', () => win.show());

  // Bloqueia navegação para fora e novas janelas (kiosk fechado).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    const origin = config.read().origin; // no modo só-online carregamos a página real /play/{token}.
    const allowRemote = origin && url.startsWith(origin);
    if (!url.startsWith('file:') && !url.startsWith('http://127.0.0.1:' + port) && !allowRemote) e.preventDefault();
  });

  // Menu de contexto (botão direito) — sempre disponível pra chegar nas configurações.
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: 'Configurações', click: exitKioskToSetup },
      { label: 'Recarregar (buscar mudanças)', click: reloadFresh },
      { type: 'separator' },
      { label: 'Sair (Ctrl+Shift+Q)', click: quitForGood },
    ]).popup({ window: win });
  });

  // ESC: mesmo atalho do "x" discreto do canto do player.html — sai do kiosk pras configurações.
  // Só intercepta em modo kiosk (não mexe no ESC dentro do próprio formulário de configurações).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && win.isKiosk()) {
      event.preventDefault();
      exitKioskToSetup();
    }
  });

  routeStartup();
}

function loadSetup() {
  win.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
}

function loadPlayer() {
  const cfg = config.read();
  if (cfg.offline === false) {
    // Modo só-online: carrega a página real do player (sem cache, sem servidor local; senha nativa lá).
    win.loadURL(cfg.origin.replace(/\/$/, '') + '/play/' + encodeURIComponent(cfg.token));
    return;
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'), {
    query: { port: String(port), token: cfg.token, device: cfg.device || '' }, // device p/ o player pular a senha.
  });
}

/** "Recarregar" do menu: força uma consulta à API (pega mudança da playlist) e só então recarrega. */
async function reloadFresh() {
  if (!win || win.isDestroyed()) return;
  await sync.syncOnce().catch(() => {}); // no modo só-online é no-op; o reload já busca do servidor real.
  win.reload();
}

/** Decide a tela inicial: player se já configurado (e, no modo offline, autenticado), senão setup. */
function routeStartup() {
  const cfg = config.read();
  if (!config.realApi(cfg)) return loadSetup();
  // Offline sem device = não autenticado ainda → volta pro setup pra pegar a senha/sessão.
  // (Sem isso, o player.js cairia no formulário de senha dele e o conteúdo tocaria atrás.)
  if (cfg.offline !== false && !cfg.device) return loadSetup();
  loadPlayer();
}

// ---------------------------------------------------------------- IPC (setup ↔ main)
function wireIpc() {
  ipcMain.handle('cfg:get', () => config.read());

  ipcMain.handle('cfg:resolve-save', async (_e, input) => {
    try {
      const { origin, token } = await resolve.resolve(input, config.read().origin);
      config.write({ origin, token, device: '', lastUrl: String(input || '') }); // troca de playlist zera o device.
      return { ok: true, origin, token };
    } catch (err) {
      return { ok: false, error: err.message || 'Falha ao resolver a URL.' };
    }
  });

  ipcMain.handle('sync:now', async () => {
    return sync.syncOnce();
  });

  // Autentica no servidor real (senha, se houver) → guarda o device de sessão eterna + baixa a mídia.
  ipcMain.handle('cfg:authenticate', async (_e, password) => {
    return sync.authenticate(password);
  });

  ipcMain.handle('app:play', () => { loadPlayer(); return true; });
  ipcMain.handle('app:setup', () => { exitKioskToSetup(); return true; }); // "x" do canto do player.
  ipcMain.handle('app:quit', () => { quitForGood(); return true; }); // botão "Encerrar" do setup.

  // Favoritos
  ipcMain.handle('fav:list', () => config.read().favorites || []);
  ipcMain.handle('fav:add', (_e, fav) => {
    const favs = (config.read().favorites || []).filter((f) => f.url !== fav.url);
    favs.unshift({ name: String(fav.name || fav.url), url: String(fav.url) });
    config.write({ favorites: favs.slice(0, 30) });
    return favs;
  });
  ipcMain.handle('fav:remove', (_e, url) => {
    const favs = (config.read().favorites || []).filter((f) => f.url !== url);
    config.write({ favorites: favs });
    return favs;
  });

  // Auto-start no boot.
  // ⚠️ No Windows isto grava na chave "Run" do usuário, então o app só abre DEPOIS que alguém entra
  // na conta. Numa TV que precisa voltar sozinha após queda de energia, isso não basta: o Windows
  // também tem que entrar na conta automaticamente. Por isso devolvemos o estado REAL + o resultado
  // da checagem de login automático, e o setup avisa o que falta.
  ipcMain.handle('autostart:set', (_e, on) => {
    on = !!on;
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath });
    config.write({ autostart: on });
    // Lê de volta: se o Windows recusou (política, antivírus), a tela não pode mentir dizendo "ok".
    return !!app.getLoginItemSettings().openAtLogin;
  });

  /** Estado real do auto-start + se o Windows entra na conta sozinho ao ligar. */
  ipcMain.handle('autostart:status', async () => {
    const item = app.getLoginItemSettings();
    let autoLogin = null; // null = não deu para saber
    if (process.platform === 'win32') {
      autoLogin = await new Promise((resolve) => {
        execFile(
          'reg',
          ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', '/v', 'AutoAdminLogon'],
          { windowsHide: true, timeout: 4000 },
          (err, stdout) => resolve(err ? null : /AutoAdminLogon\s+REG_SZ\s+1/i.test(String(stdout))),
        );
      });
    }
    return {
      autostart: !!config.read().autostart,
      registrado: !!item.openAtLogin, // o Windows aceitou de fato?
      autoLogin, // true = entra na conta sozinho; false = vai parar na tela de login; null = desconhecido
      plataforma: process.platform,
    };
  });

  // Modo offline (cache local) ligado/desligado
  ipcMain.handle('offline:set', (_e, on) => {
    on = on !== false;
    config.write({ offline: on });
    return on;
  });

  // Intervalo de consulta da playlist (minutos, 5..1440)
  ipcMain.handle('interval:set', (_e, minutes) => {
    const m = config.setSyncInterval(minutes);
    sync.restart();
    return m;
  });

  // Limpar dados offline: apaga mídia + última versão boa → próxima sync rebaixa tudo.
  ipcMain.handle('cache:clear', async () => {
    const removed = cache.clear();
    state.clear();
    const res = await sync.syncOnce().catch(() => ({ ok: false })); // rebaixa já, se online + configurado.
    return { removed, resync: res };
  });
}

// ---------------------------------------------------------------- ciclo de vida
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    // Usuário fechou de propósito neste mesmo boot (menu/atalho/botão "Encerrar")? Respeita e não
    // reabre sozinho — mesmo se algo de fora (agendador, acesso atribuído) tentar relançar. Só
    // reinicia o Windows pra liberar de novo. Sai antes de tocar em servidor/sync/janela.
    if (config.read().quitUntilBoot === bootId()) { app.quit(); return; }

    powerSaveBlocker.start('prevent-display-sleep'); // TV não apaga.
    wireIpc();

    // Repassa o progresso do sync para a tela (preloader).
    sync.start((status) => { if (win && !win.isDestroyed()) win.webContents.send('sync:status', status); });

    port = await server.start();

    // Aplica a preferência de auto-start salva (idempotente).
    const cfg = config.read();
    app.setLoginItemSettings({ openAtLogin: !!cfg.autostart, path: process.execPath });

    globalShortcut.register('CommandOrControl+Shift+Q', quitForGood); // saída de manutenção.
    createWindow();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
