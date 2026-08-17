# DS View (dsview-apps/android) — mapa vivo

App **kiosk offline Android** (Kotlin + WebView), irmão do `../dsview` (Windows/Electron). Roda em
**qualquer Android** incluindo **Android TV**. Mesma arquitetura **cache-proxy**: servidor local espelha a API do
player, loop de sync espelha a mídia no disco. **v0.7.1** (versionCode 27).
Repo git compartilhado com o app Windows (`dsview-apps/`, monorepo), **PÚBLICO** (`github.com/dantetesta/dsview-apps`)
— é justamente por ser público que o `player.js` copiado tem a marca removida (ver Gotchas de build). Faz parte do
guarda-chuva `Projetos/DSFácil/`.

**Único app de TV mantido (desde 05/08/2026).** Existia um irmão com a marca DS Fácil (`dsfacil-apps`) que foi
**descontinuado e arquivado** — o dono do `dsfacil.com.br` e qualquer comprador do plugin usam este mesmo
binário agora, não dois projetos em paralelo. Ícone/banner/logo em uso vêm da marca DS View oficial (arte em
`app/src/main/assets/logo-mark.png` + `res/mipmap-*`), não são mais placeholder.

## Stack / build
- **Kotlin**, **AGP 8.6.1**, **Gradle 8.7** (wrapper), **Kotlin 1.9.24**, **compileSdk 35 / minSdk 21 / targetSdk 34**.
- Deps: `nanohttpd:2.3.1` (servidor local), `kotlinx-coroutines-android`, `androidx.core/appcompat/webkit`. JSON = `org.json` (nativo).
- Build: `./gradlew assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`. SDK em `local.properties` (gitignored).
- Pacote/applicationId: `com.dsview.player`.

## Arquitetura (porta 1:1 do app Windows — se mexer num, olhe o outro)
`App` (sobe `LocalServer` + `Syncer` no processo) · `LocalServer` (NanoHTTPD 127.0.0.1: `/state`, `/state/auth`,
`/media/{hash}` com Range, + `/setup` `/player` `/assets/…` + API `/dsf/…` do setup) · `Syncer` (=sync.js: syncOnce por
`version`, authenticate, loop de intervalo) · `MediaCache` (=cache.js: `filesDir/media`, sha1+ext, download atômico,
prune/clear) · `Config` (SharedPreferences) · `StateStore` (last-good.json) · `Resolver` (=resolve.js) ·
`MainActivity` (WebView kiosk; menu no Voltar/Menu) · `BootReceiver` (auto-start) · `Updater` (auto-update).

`Syncer` também envia heartbeat independente a cada 60 s. A autenticação e o heartbeat informam ao plugin
plataforma/versão, modo online ou cache offline, saúde do WebView e data da última sincronização. Morte do
renderizador/tela de erro marca `degraded`; voltar ao player marca `healthy`. A telemetria não leva URL, senha
nem conteúdo da playlist e uma falha de rede nunca interrompe o kiosk.

`Updater` — auto-update via GitHub Releases (repo público `dsview-apps`, "latest"). Extrai a versão do
**nome do asset** (`dsview-android-X.Y.Z.apk`), não da tag do release. `checkLatest()` compara com o
`versionName` instalado; `downloadAndInstall()` baixa pro `cacheDir` e chama `ACTION_VIEW` com o APK via
`FileProvider` (manifest: `REQUEST_INSTALL_PACKAGES` + `<provider>`). **O Android SEMPRE pede confirmação
do usuário pra instalar** — nenhum app consegue se auto-atualizar em silêncio fora de ser app de sistema;
isto só poupa o caminho manual. Espelha `updater.js` do app Windows.

## Regras de domínio / gotchas
1. **Player é single-source do plugin.** `assets/player.js|css|qrcode.js` são **cópias gitignoradas** — a task Gradle `copyPlayer`
   copia de `../../ds-facil/player/` no build. Nunca editar aqui; corrigir no plugin e rebuildar. `setup.*` e `player.html`
   são do app (fetch nos `/dsf/…`), não vêm do plugin.
2. **Tudo passa pelo servidor local** (127.0.0.1:{porta aleatória}). O WebView carrega `/setup` ou
   `/player?token=&device=`; o player usa `location.origin + '/state'` como api. Mesma origem → sem CORS/porta injetada.
   `network_security_config` libera cleartext **só** p/ 127.0.0.1 (resto exige HTTPS).
3. **Áudio no autoplay** = `WebSettings.mediaPlaybackRequiresUserGesture=false` **+** o gesto sintético no `player.html`
   (o `player.js` só desmuta quando seu `audioOn` vira true). Um sem o outro = mudo.
4. **Offline sem device → setup** (`MainActivity.route`), senão o player mostraria o form de senha dele.
   Só-online → carrega `/play/{token}` remoto (o `shouldOverrideUrlLoading` libera o origin configurado).
5. **"Sair" precisa soltar o HOME, não só `finish()`.** Se o app for a **tela inicial (HOME)** do aparelho (é
   assim que o auto-start "à prova de bala" funciona), o Android sempre precisa de um HOME de pé e reinvoca este
   Activity na hora — chamar só `finish()` virava **loop infinito** (bug real relatado por cliente: apertava
   "Sair", TV box nunca saía da playlist, preso até desligar na força). `MainActivity.exitKiosk()` chama
   `packageManager.clearPackagePreferredActivities()` (API pública, sem permissão especial) e entrega o controle a
   outro launcher instalado no aparelho, se houver um. `Config.suppressAutoRelaunch()`/`shouldSuppressStartup()`
   seguram só uma janela CURTA (`AUTO_RELAUNCH_SUPPRESS_MS` = 8s, mesmo valor do app Windows) — o suficiente pra
   barrar o Android religando na hora, sem travar uma reabertura de verdade minutos depois (bug irmão do Windows:
   antes a supressão durava até reiniciar o aparelho inteiro). Desligar o auto-start nas configurações faz o
   mesmo: solta a preferência de HOME também, não só o flag interno. BACK/MENU (equivalente ao ESC do Windows) e o
   "x" discreto do `player.html` (hover, se houver mouse) levam pro setup sem fechar o app. O botão **"Fechar
   aplicativo"** na tela de setup (paridade com o "Encerrar o aplicativo" do Windows) chama o mesmo `exitKiosk()`
   por outro caminho: `LocalServer` roda numa thread própria (NanoHTTPD), sem referência ao `Activity`, então
   `MainActivity` guarda `instance` (companion, setado em `onResume`/limpo em `onPause`) e expõe `requestExit()`
   (`runOnUiThread { exitKiosk() }`) — a rota `/dsf/exit` chama `MainActivity.instance?.requestExit()`.
6. **Sync por `version`**: só rebaixa quando `payload.version` muda (depende do plugin bumpar). Tudo atômico
   (mídia `.part`→rename; last-good só depois de tudo no disco; então prune).
7. **Depende do contrato público do plugin** (endpoints `/wp-json/ds-facil/v1/player/{token}` + `/auth`, campos
   `queue[].{src,provider,kind,audio}` + `version`, status ok/password/expired/offline). Mudou lá → quebra aqui.

## Compatibilidade em TV box (v0.2.0) — por que cada coisa existe

Sintoma que originou: cliente instalou no TV box **Android 10**, instalação sem erro, **app não abre**.
O APK sempre esteve tecnicamente compatível (`minSdk 21`, `targetSdk 34`, sem lib nativa, `LAUNCHER` +
`LEANBACK_LAUNCHER`, assets embutidos) — o problema é que **toda falha de runtime era engolida em silêncio**
(`try { server.start() } catch { }` vazio), e sem logcat na casa do cliente ninguém consegue diagnosticar.

- **Nada falha calado.** `App` instala um `UncaughtExceptionHandler` que grava o stack em
  `filesDir/crash.txt`; `startupError` guarda falha de inicialização. A `MainActivity` mostra uma **tela
  preta com o motivo escrito** em vez de tela preta muda, com versão do app, Android, modelo, **versão do
  WebView** e porta do servidor (o cliente fotografa a tela e manda).
- **WebView pode não existir.** Em ROM de TV box o "Android System WebView" pode estar ausente, desativado
  ou atualizando: `WebView(this)` **lança** e o app morre na hora. Agora é `try/catch` com instrução na tela.
- **`onRenderProcessGone`** tratado: se o renderizador morre (falta de memória tocando vídeo em aparelho
  fraco), sem isso **o Android mata o app inteiro** — é a causa clássica de "a TV apagou sozinha depois de
  um tempo". Agora recria o WebView e volta pra rota. `largeHeap=true` no manifesto ajuda o decode.
- **Porta do servidor.** `startServer()` tenta 3 vezes (logo após o boot a rede às vezes ainda não subiu) e
  a `MainActivity` **checa `serverOk`** antes de carregar — antes carregava `http://127.0.0.1:-1` e dava
  tela preta eterna.
- **DPAD:** o WebView recebe `isFocusable`/`isFocusableInTouchMode` + `requestFocus()` no setup, senão o
  controle remoto não navega nos campos (TV box não tem touch).
- **Console do JS** vai pro anel de 40 linhas em `App.jsLog()` e aparece no menu **Diagnóstico** — é como
  se descobre erro de JS em WebView velho sem cabo USB. `setWebContentsDebuggingEnabled(true)` liga o
  `chrome://inspect` por USB quando houver acesso ao aparelho.

## Gotchas de build (Kotlin/Android) — já mordi, não repetir
- **Kotlin ANINHA comentários de bloco.** Um `/*` dentro de um KDoc `/** */` (ex.: escrever `/dsf/*` ou `/assets/*`)
  abre um comentário aninhado que não fecha → "Unclosed comment". Evite `/…/*` em KDoc (usei `/dsf/…`).
- **`val` não pode ser atribuído em `try` E `catch`** (o try pode atribuir e depois lançar). Reestruturar sem os dois ramos.
- Ícone/banner **já são arte final** (PNG por densidade em `res/mipmap-*/ic_launcher*.png` + adaptive-icon em
  `mipmap-anydpi-v26/`, banner em `res/drawable-nodpi/tv_banner.png`; `android:icon` aponta `@mipmap`, só o banner
  usa `@drawable`) — não é mais vetor placeholder.
- **Copy do player é branqueado por linha** (`copyPlayer` no `build.gradle.kts`): qualquer linha que, sem espaços nas
  pontas, começa com `/*` ou `*` vira `""`. Sem estado entre linhas, mesma closure pros dois arquivos — confirmado que
  nenhuma linha real de código do plugin começa assim, então o filtro não corrompe nada. Zero string de marca
  (`Dante`, `dantetesta`, `DS Fácil`) sobrevive na cópia.

## Backlog aberto
- Testar em **Android real + Android TV** (kiosk, auto-start no boot, offline, só-online).
- Validar instalação/atualização do APK assinado em Android real e Android TV.
- DPAD no setup já tem base (`isFocusable`+`tabIndex=0`+`onkeydown` Enter em `setup.js`); falta só validar em TV real.
- Considerar `WorkManager`/foreground service pra o sync sobreviver melhor em background em Androids restritivos.

> Este `CLAUDE.md` é doc de dev (não vai em build de release).
