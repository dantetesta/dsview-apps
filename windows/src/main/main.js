/**
 * DS View — processo principal.
 * Casca kiosk fullscreen + servidor local (cache offline) + loop de sync. Sem barra de URL:
 * botão direito, ESC ou o "x" discreto do canto abrem o menu/as configurações (Configurações /
 * Recarregar / Sair). Auto-start no boot opcional — mas só entra sozinho no boot: se o usuário
 * fechar de propósito, um auto-relançador externo (agendador, acesso atribuído) não traz de volta
 * na hora (ver `quitForGood()`). Isso NÃO impede o usuário de reabrir manualmente depois — só
 * suprime a rajada instantânea (janela curta, `config.AUTO_RELAUNCH_SUPPRESS_MS`).
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

// Rede de segurança do processo principal: numa TV desatendida, um erro não tratado em QUALQUER
// lugar (um bug futuro, uma Promise sem .catch) mata o app inteiro sem aviso — melhor logar e
// seguir vivo do que a tela apagar de vez sem ninguém saber por quê.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

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
 * "fechado de propósito" antes de sair, com o instante do fechamento. Por uma janela curta (ver
 * config.AUTO_RELAUNCH_SUPPRESS_MS), algo de fora (agendador, acesso atribuído) tentando reabrir na
 * hora é recusado — passada essa janela, até um lançamento automático é tratado normal, e uma
 * reabertura manual do usuário NUNCA é bloqueada por isto (bug real: já aconteceu de "Sair" deixar o
 * app impossível de reabrir manualmente até reiniciar o Windows). */
function quitForGood() {
  config.suppressAutoRelaunch(bootId());
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

  // Sem isto, um crash do processo de renderização (driver de GPU tocando vídeo, memória em PC
  // fraco) deixava a TV parada numa tela preta pra sempre — app "vivo" no Gerenciador de Tarefas,
  // mas sem imagem nenhuma, e ninguém percebe até reclamarem. Recarrega o que já estava carregado.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    reviveAfterCrash();
  });
  win.webContents.on('unresponsive', () => {
    // Dá um tempo pra travamento passageiro (ex.: decode pesado) antes de forçar a recriação.
    setTimeout(() => { if (win && !win.isDestroyed() && win.webContents.isWaitingForResponse()) reviveAfterCrash(); }, 15000);
  });

  // Bloqueia navegação para fora e novas janelas (kiosk fechado).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    const origin = config.read().origin; // no modo só-online carregamos a página real /play/{token}.
    // Comparar ORIGEM DE VERDADE (protocolo+host+porta), não prefixo de string: `url.startsWith(origin)`
    // deixava passar `origin + ".attacker.com"` — um domínio parecido que literalmente começa com o
    // texto do origin configurado — como se fosse o site real. Kiosk público, isso é phishing/pichação
    // em tela cheia sem ninguém perceber.
    let allowRemote = false;
    if (origin) {
      try { allowRemote = new URL(url).origin === new URL(origin).origin; } catch (e2) { allowRemote = false; }
    }
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
  // Volta ao kiosk sempre que o player carrega — sem isto, sair pras configurações (que tira kiosk/
  // fullscreen) e depois clicar "Salvar e iniciar" (app:play) deixava a janela numa decoração/tamanho
  // errado, meio kiosk meio janela normal ("bugado"), obrigando o usuário a fechar e reabrir na mão.
  if (win && !win.isDestroyed()) {
    win.setFullScreen(true);
    win.setKiosk(true);
  }
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

// Reagir a CADA crash na hora, sem limite, vira loop de recriar-carregar-crashar (driver de vídeo
// que trava sempre naquele mesmo ponto) — consome CPU/memória sem parar em vez de recuperar uma
// vez e ficar quieto. Backoff crescente: rápido no primeiro crash, cada vez mais devagar depois.
let crashCount = 0;
let crashResetTimer = null;
function reviveAfterCrash() {
  if (!win || win.isDestroyed()) return;
  crashCount += 1;
  clearTimeout(crashResetTimer);
  crashResetTimer = setTimeout(() => { crashCount = 0; }, 10 * 60 * 1000); // 10 min sem crash = zera a contagem.
  const delay = Math.min(crashCount * 5000, 60000); // 5s, 10s, 15s ... até 60s no máximo.
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    routeStartup();
  }, delay);
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
      const cfg = config.read();
      // Domínio configurado em Configurações vence — permite digitar só o código da playlist.
      // Sem ele, cai no origin da última playlist resolvida (compatibilidade).
      const knownOrigin = cfg.baseDomain || cfg.origin;
      const { origin, token } = await resolve.resolve(input, knownOrigin);
      config.write({ origin, token, device: '', lastUrl: String(input || '') }); // troca de playlist zera o device.
      return { ok: true, origin, token };
    } catch (err) {
      return { ok: false, error: err.message || 'Falha ao resolver a URL.' };
    }
  });

  ipcMain.handle('domain:set', (_e, value) => {
    const baseDomain = config.normalizeDomain(value);
    config.write({ baseDomain });
    return baseDomain;
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
    // Lê de volta: se o Windows recusou (política, antivírus), a tela não pode mentir dizendo "ok".
    const registrado = !!app.getLoginItemSettings().openAtLogin;
    // Desligar (ou o Windows recusar ligar) é pra valer: arma a mesma supressão do "Sair" — nem algo
    // de fora relançando (agendador, acesso atribuído) reabre antes do próximo boot de verdade.
    // Registrar com sucesso limpa a supressão.
    config.write({ autostart: on });
    if (registrado) config.write({ quitUntilBoot: null, quitAt: null });
    else config.suppressAutoRelaunch(bootId());
    return registrado;
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
    // Usuário fechou de propósito (menu/atalho/"Encerrar"/recusou auto-start) HÁ POUCO TEMPO neste
    // boot? Suprime — é a janela em que um auto-relançador externo (agendador, acesso atribuído)
    // tentaria religar na hora, contra a vontade de quem acabou de fechar. Passada essa janela curta,
    // qualquer lançamento novo (inclusive o usuário reabrindo manualmente) é tratado normal — Windows
    // não expõe um jeito confiável de saber SE este lançamento veio do Run-key (ver config.js).
    if (config.shouldSuppressStartup(bootId())) { app.quit(); return; }

    powerSaveBlocker.start('prevent-display-sleep'); // TV não apaga.
    wireIpc();

    // Repassa o progresso do sync para a tela (preloader).
    sync.start((status) => { if (win && !win.isDestroyed()) win.webContents.send('sync:status', status); });

    // O servidor local pode falhar ao subir (antivírus/firewall bloqueando o loopback, porta
    // negada por política do Windows) — sem isto a Promise rejeitada derrubava o app inteiro antes
    // da janela abrir. Tenta mais duas vezes (mesma ideia do retry do app Android) e, se mesmo
    // assim não conseguir, segue sem servidor local: modo só-online continua funcionando.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { port = await server.start(); break; }
      catch (err) {
        if (attempt === 3) { console.error('Servidor local não subiu depois de 3 tentativas:', err); port = 0; }
        else await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Aplica a preferência de auto-start salva (idempotente).
    const cfg = config.read();
    app.setLoginItemSettings({ openAtLogin: !!cfg.autostart, path: process.execPath });

    globalShortcut.register('CommandOrControl+Shift+Q', quitForGood); // saída de manutenção.
    createWindow();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
