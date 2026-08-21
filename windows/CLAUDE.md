# DS View — mapa vivo

App **kiosk offline** (Electron 31, Windows 10/11 x64). Uma casca full-screen sem barra de URL em volta do
**player do plugin DS View**, com **cache local** que espelha o conteúdo online no disco — a TV segue tocando
mesmo sem internet. Repo git compartilhado com o app Android (`dsview-apps/`, monorepo), separado do plugin,
**PÚBLICO** (`github.com/dantetesta/dsview-apps`). **v0.6.1**; falta validar o instalador em Windows real.

> Faz parte do guarda-chuva `Projetos/DSFácil/`. O produto é o plugin (`../ds-facil/`, tem o CLAUDE.md detalhado).
> Este app **consome os endpoints públicos que já existem** no plugin — não exige nenhuma mudança nele.

**Único app de TV mantido (desde 05/08/2026).** Existia um irmão com a marca DS Fácil (`dsfacil-apps`) que foi
**descontinuado e arquivado** — o dono do `dsfacil.com.br` e qualquer comprador do plugin usam este mesmo
binário agora. Ícone/logo em uso vêm da marca DS View oficial (`src/renderer/logo-mark.png` +
`assets/icon.ico`/`icon.png`), não são mais placeholder.

## Stack

- **Electron 31.7** (main process Node + renderer Chromium), **electron-builder 24** (NSIS, x64, sem portable).
- **Zero dependências de runtime.** Só `http`/`fs`/`crypto`/`path` do Node + `net`/`app`/`BrowserWindow` do Electron.
- Player em JS puro (copiado do plugin). Sem framework, sem bundler.

## O que ele faz

- **Kiosk full-screen** sem barra de endereço. Botão direito, **ESC** ou o **"x" discreto do canto** (aparece só no
  hover do mouse, em `player.html`) saem do kiosk pras configurações. Menu de contexto = Configurações / Recarregar / Sair.
- **Setup na 1ª execução:** sem nada configurado abre **direto o setup** e **não baixa nada** até o usuário colar o link
  `/play/{token}` (ou código curto) e confirmar. Campo de **senha da playlist** ali no setup. **Favoritos** (até 30 URLs).
- **Senha:** autentica **no setup** (`/auth` do plugin → device de sessão eterna, guardado em `config.device`) e injeta
  o device no player → o formulário de senha do `player.js` **nunca aparece**. Offline sem device → volta pro setup.
- **Áudio no autoplay:** vídeo com `audio` ligado toca **com som sozinho** (Electron com `autoplay-policy=
  no-user-gesture-required` + gesto sintético no `player.html`). Item sem áudio fica mudo. Respeita o flag da playlist.
- **Recarregar (menu):** força `syncOnce()` (consulta a API) **antes** de recarregar — pega mudança sem apagar o cache.
- **Modo offline (opção, ligado por padrão):** um servidor local em `127.0.0.1:{porta-aleatória}` fica **entre o player e
  o servidor remoto**. O player só fala com o local; um **loop de sync** (intervalo configurável) baixa mídia nova, remove
  a que saiu e mantém o disco como espelho do online. Internet caiu → toca do cache sem perceber.
  **Desligado → modo só-online:** carrega a página real `/play/{token}` direto, sem cache nem servidor local.
- **Intervalo de consulta configurável:** min 1 min · **padrão 60 min** · max 24 h.
- **Limpar dados offline:** botão no setup que apaga toda a mídia + a "última versão boa" e rebaixa do zero.
- **Preloader** no 1º acesso / troca de playlist (só no modo offline; baixa tudo antes de iniciar, com barra de progresso).
- **Auto-start no boot** do Windows (opção): liga → ao ligar o PC o app abre sozinho em fullscreen e inicia a playlist.
  **Fechar de propósito (menu "Sair", Ctrl+Shift+Q, "Encerrar" no setup, ou recusar/desligar o auto-start) suprime só
  um auto-relançador externo tentando religar NA HORA** (`config.suppressAutoRelaunch`/`shouldSuppressStartup`,
  janela de `config.AUTO_RELAUNCH_SUPPRESS_MS` = 8s). **Reabertura manual do usuário sempre funciona**, mesmo minutos
  depois no mesmo boot — bug real corrigido em 0.4.2 (a versão anterior suprimia até reiniciar o Windows, então
  "Sair" e depois tentar abrir de novo na mão deixava o app "morto" até reboot).
- **Anti-sleep** (tela não apaga). **Single-instance**.
- **Monitoramento:** heartbeat independente a cada 60–75 s informa versão, modo online/cache offline, saúde do
  renderizador e última sincronização. Crash ou janela sem resposta marca `degraded`; recuperar o player marca
  `healthy`. O jitter de até 15 s evita que muitos aparelhos ligados juntos atinjam o servidor no mesmo segundo.
  Falha de rede é silenciosa e não derruba a reprodução local.

## Arquitetura (cache-proxy + webview)

```
RENDERER (janela kiosk, contextIsolation)      MAIN PROCESS (Node)
  setup.html → setup.js ── window.dsf.* ──→   main.js    ciclo de vida, janela kiosk, IPC, atalhos
                            (preload)          config.js  JSON em userData (origin/token/device/favs/autostart)
  player.html injeta:                          resolve.js input colado → {origin, token} (segue 302)
    window.DSF_PLAYER = {api:127.0.0.1/state}  server.js  HTTP local: /state, /state/auth, /media/{hash}
  player.js (cópia do plugin) ──fetch──→ ↑     sync.js    loop a cada syncInterval (padrão 60 min): busca payload real → baixa/poda → last-good
                                               cache.js   download atômico .part→rename, sha1(url), prune
                                               state.js   "última versão boa" (payload original) → last-good.json
```

### Por pasta / arquivo

| Arquivo | Papel |
|---|---|
| `src/main/main.js` | Entrypoint. Cria a `BrowserWindow` kiosk (frame:false, fullscreen, backgroundThrottling:false), bloqueia navegação externa e `window.open` (libera o origin configurado p/ o modo só-online), monta o menu de contexto, faz o wiring de todo o IPC, single-instance lock, `powerSaveBlocker`, atalho global **Ctrl+Shift+Q** = sair, aplica auto-start. `routeStartup()` decide: player se já configurado, senão setup. `loadPlayer()` ramifica: **offline** → `player.html` local; **só-online** → `loadURL(origin/play/{token})`. |
| `src/main/config.js` | Config persistente (`userData/dsview-config.json`). Campos em **Modelo de dados** abaixo. `realApi(cfg)` monta `origin + /wp-json/ds-facil/v1/player/{token}` (null se não configurado). `syncIntervalMin()`/`setSyncInterval()` clampam o intervalo em 1..1440 min. Nunca crasha por falha de disco. |
| `src/main/state.js` | "Última versão boa" do payload — o **original, sem reescrita de URL** — em `userData/last-good.json` + memoizado. É o que permite abrir offline depois de um reboot. |
| `src/main/server.js` | Servidor local `127.0.0.1:0` (porta alta aleatória). Imita a forma da API do player. `rewrite()` troca o `src` das mídias **cacheadas** por `/media/{hash}` (YouTube/Vimeo ficam intactos). |
| `src/main/cache.js` | Espelho de mídia no disco (`userData/media/`). Nome = `sha1(url)+ext` (determinístico, sem manifesto). Download **atômico** (`.part`→`rename`). `prune()` apaga o que saiu do payload; `clear()` apaga tudo (reset do cache). |
| `src/main/sync.js` | O coração do offline. `syncOnce()`: busca o payload real; se `version` mudou, baixa mídia nova, **depois** grava last-good e poda. No modo só-online retorna `online-only` sem baixar. Loop com intervalo de `config.syncIntervalMin()`, `restart()` reagenda ao trocar o intervalo, **nunca lança**. Também mantém o heartbeat de 60–75 s separado do intervalo de download. |
| `src/main/resolve.js` | Resolve o que o usuário cola → `{origin, token}`. Aceita link `/play/{token}`, código curto (segue o 302 até o `/play/`), ou código + origin conhecido. Usa o `net` do Electron (respeita proxy do SO). |
| `src/preload.js` | Bridge segura. Expõe **só** `window.dsf.*` ao renderer (nada de Node solto). |
| `src/renderer/setup.*` | Tela de configuração: cola URL → `resolveSave` → `favAdd` → `authenticate(senha)` (dispara `syncOnce()` por dentro) → `play`. Favoritos, toggle de auto-start. `syncNow`/IPC `sync:now` existe no preload mas hoje não é chamado por nenhuma UI (código morto). |
| `src/renderer/player.html` | Injeta `window.DSF_PLAYER = {api:'http://127.0.0.1:{port}/state', token}` e carrega o `player.js`. |
| `src/renderer/player.js` · `player.css` | **CÓPIA do plugin — gitignorada, NÃO editar aqui.** Ver "Regras de domínio". |
| `scripts/copy-player.js` | Copia `player.js`/`player.css` de `../../ds-facil/player/` → `src/renderer/`. Roda em `npm start`/`dist`. Se o plugin não estiver ao lado, avisa mas não trava o build. |
| `src/main/updater.js` | Auto-update via GitHub Releases (repo público `dsview-apps`, "latest"). Extrai a versão do **nome do asset** (`dsview-windows-setup-X.Y.Z.exe`), não da tag do release (um release combina os dois apps). `checkLatest()` compara com `app.getVersion()`; `download()` baixa pro temp com progresso; `main.js` roda o instalador com `/S` (silencioso, funciona mesmo com `oneClick:false`) **detached** e dá `app.quit()` — mesma técnica do "Remover aplicativo". Sem assinatura de código: o binário baixado ainda pode ser barrado por SmartScreen/Defender, risco aceito (documentado, sem cert Windows). |

## Modelo de dados

**`config.json`** (userData): `{ origin, token, device, favorites:[{name,url}], autostart, offline, syncInterval, lastUrl }`.
`device` = device_token do 1º `/auth` (permite offline sem re-senha). **Trocar de playlist zera o `device`.**
`offline` (bool, default `true`) = usa cache local; `false` = só-online. `syncInterval` (min, default 60, clamp 1..1440).

**`last-good.json`** (userData): o payload original da última sync boa. Contrato consumido do plugin:
`{ version, queue:[{ src, provider, kind, audio, ... }] }`. Só é usado quando `version` muda (economiza download).

**`media/`** (userData): arquivos nomeados `sha1(url)+ext`. `.part` = download em andamento.

## Rotas do servidor local + IPC

**Servidor `127.0.0.1:{porta}`** (o `player.js` fala só com ele):
- `GET /state[?t=&device=]` → `{status:'ok', payload}` (reescrito p/ `/media/{hash}`) ou `{status:'offline'}`.
- `POST /state/auth` → repassa pro `/auth` real via `net`; guarda `device`; cacheia o payload; dispara sync; devolve ao player. Offline: se já autenticou antes e tem cache, devolve `ok` com o last-good.
- `GET /media/:name` → arquivo do disco, **com suporte a Range (206)** — essencial p/ seek de vídeo. Guarda contra path traversal (regex `^[a-f0-9]{40}\.[a-z0-9]{1,5}$`).

**IPC (`window.dsf.*` via preload):** `getConfig`, `resolveSave(input)`, `syncNow`, `play`, `openSetup`,
`favList`/`favAdd`/`favRemove`, `setAutostart(on)`, `setOffline(on)`, `setInterval(min)`, `clearCache()`,
`onSyncStatus(cb)` (progresso do preloader).

## Regras de domínio / gotchas (lições que voltam)

1. **O player tem fonte única: o plugin.** `src/renderer/player.js|css|qrcode.js` são **cópias gitignoradas**. Nunca editar aqui —
   corrigir no plugin (`../../ds-facil/player/`) e rodar `npm run copy-player` (já embutido em `start`/`dist`).
   Player velho no app = você esqueceu de rodar o copy.
2. **O truque `/state` + `/state/auth`.** O `player.js` faz `fetch(api)` e `fetch(api + '/auth')`. Por isso o `api`
   injetado é `.../state` (sem barra no fim) — concatenar `/auth` dá `/state/auth`. As rotas do `server.js` são
   **literalmente** `/state` e `/state/auth`. No servidor real o `api` seria `.../player/{token}` e o mesmo `+ '/auth'`
   resolve certo. **Não mude o path do `api` sem alinhar as rotas do server.**
3. **Sync é por `version`.** Só rebaixa mídia quando `payload.version` muda. Depende do plugin **bumpar o `version`**
   a cada alteração de conteúdo (ele faz). Se o conteúdo mudar sem mudar o `version`, o app não pega.
4. **Tudo atômico, na ordem certa.** Mídia baixa em `.part`→`rename`; o `last-good` só aponta pro payload novo
   **depois** que toda a mídia está no disco, e só então `prune()`. Queda no meio nunca deixa o cache inconsistente.
5. **A porta é aleatória (`listen 0`) e nunca é persistida.** Por isso o `rewrite()` (troca src → 127.0.0.1) roda
   **na hora de servir** (`server.js`), não ao gravar — o `last-good.json` fica port-agnostic e sobrevive a reboot.
6. **YouTube/Vimeo nunca são cacheados** (o vídeo mora na plataforma). Online tocam normal; offline são pulados.
7. **`device` mora em dois lugares:** no `config.json` (main) e no `localStorage` do `player.js` (`dsv_device_{token}`).
   O offline-auth do server devolve o `config.device`.
8. **Depende de o plugin manter o contrato público** intacto: endpoints `/wp-json/ds-facil/v1/player/{token}` + `/auth`,
   campos `queue[].{src,provider,kind,audio}` e `version`, e os status `ok`/`password`/`expired`/`offline`.
   Mudou o contrato no plugin → este app quebra silenciosamente.
9. **Senha é responsabilidade do setup, não do player.** O proxy local `/state` **sempre** devolve `ok` com o cache
   (não repassa `password`). Se o player boota **sem device**, ele usa o formulário de senha DELE e o conteúdo toca
   por trás (o form nem some — bug do `transitionTo` no `player.js` do plugin, que **não** é editado aqui). Por isso
   `routeStartup` manda pro setup quando offline **sem** device, e a senha é autenticada lá (`sync.authenticate`).
10. **Áudio precisa de DUAS coisas:** o switch `autoplay-policy` no Electron **e** o gesto sintético no `player.html`
    (o `player.js` só desmuta quando seu `audioOn` vira true, e isso exige um "click"). Um sem o outro = mudo.
11. **`scripts/copy-player.js` branqueia TODA linha de comentário do player, não só o cabeçalho de marca** — qualquer
    linha (sem espaço nas pontas) que começa com `/*` ou `*` vira `""`, inclusive diretivas de lint no meio do arquivo
    (`/* global YT */` etc.). Inofensivo hoje, mas se o plugin ganhar um comentário mid-file que importe, ele some
    silenciosamente na cópia branca.
12. **`loadPlayer()` reafirma kiosk+fullscreen toda vez que carrega** (`win.setKiosk(true)`/`setFullScreen(true)`).
    Sem isso, sair pras configurações (que tira kiosk) e depois "Salvar e iniciar" (IPC `app:play` → `loadPlayer()`)
    deixava a janela numa decoração/tamanho errado — bug real corrigido em 0.4.2. Qualquer novo caminho que leve
    de volta ao player tem que passar por `loadPlayer()`, não recriar a lógica de carregamento à parte.
13. **O slug `ds-facil` (a origem) continua vazando, e não tem como evitar.** `config.js` monta a URL real como
    `origin + '/wp-json/ds-facil/v1/player/' + token` — é a rota REST fixa do plugin, então o literal `ds-facil`
    fica no `app.asar` do instalador público (confirmado via `strings` no `.asar` empacotado). Não é uma falha do
    stripping — é a única forma de string de marca que o white-label não consegue esconder, porque é o contrato
    de API em si, não um comentário.

## Como rodar / buildar

```bash
npm install
npm start            # copy-player + electron . (dev). Sair do kiosk: Ctrl+Shift+Q
npm run dist         # instalador NSIS com wizard (.exe) em dist/ (Windows x64) — sem portable
npm run dist:dir     # build sem empacotar (dist/win-unpacked) — teste rápido
```

- Ícone já é definitivo (`assets/icon.ico` real + `icon:` ativo no `electron-builder.yml`). Sem assinatura de
  código, o Windows mostra o aviso do SmartScreen na 1ª execução.
- **`npm run dist` gera só o instalador NSIS com wizard** (`dist/DS View Setup {ver}.exe`), sem portable.
  Buildou no macOS sem Wine (electron-builder 24 resolve o NSIS sozinho). Assinatura de código, se for querer, pede
  cert Windows.

## Backlog aberto (fase 2)

- **Testar em Windows real** (kiosk, auto-start no boot, single-instance, anti-sleep, modo só-online) e validar o instalador.
- Assinatura de código (tirar o SmartScreen) — ícone/arte já resolvidos.
- Auto-update (`electron-updater`) — hoje a atualização é manual.
- Tratar `status:'password'`/`'expired'` na casca (hoje quem lida é o `player.js`; UX de kiosk pode querer um aviso).

> Design original: `../player-app/PLAN.md`. Este `CLAUDE.md`/README não entram em build de release.
