# DS View — WebView Android (kiosk offline)

App **kiosk offline** para **qualquer Android** — celular, tablet, TV box e **Android TV** — que roda uma playlist
do [DS View](https://seusite.com.br) em tela cheia. É o irmão Android do app de Windows (`../dsview`),
com a **mesma arquitetura cache-proxy**: um servidor HTTP local espelha a API do player e um loop de sync baixa a
mídia pro disco, então a tela **continua tocando mesmo sem internet**.

> O player (`player.js`/`player.css`) é **copiado do plugin** no build (fonte única = `../ds-facil/player/`),
> nunca editado aqui.

---

## O que faz

- **Kiosk full-screen** imersivo (sem barra de status/navegação). Tela sempre ligada.
- **Setup:** cola o link `/play/{token}` (ou o código) + a senha da playlist (se houver). **Favoritos.**
- **Offline-first:** servidor local em `127.0.0.1` fica entre o player e o servidor remoto; o player fala só com o
  local. Um **loop de sync** (intervalo configurável: 5 min / 60 min / 24 h) baixa mídia nova, remove a que saiu e
  mantém o disco como espelho do online. Internet caiu → toca do cache.
- **Modo só-online** (opção): carrega a página real `/play/{token}` direto, sem cache.
- **Áudio no autoplay:** vídeo com áudio ligado toca com som sozinho (`mediaPlaybackRequiresUserGesture=false`).
- **Menu** (botão **Voltar**/**Menu** do controle ou toque longo): Configurações / Recarregar / Sair.
- **Auto-start no boot** (opção) e **Android TV** (aparece no launcher de TV; funciona só com o controle, sem touch).

---

## Como buildar

Precisa do **Android SDK** (platform 35, build-tools 35) e **JDK 17+**. O `local.properties` aponta o SDK.

```bash
./gradlew assembleDebug     # gera app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease   # release (não assinado — assine antes de distribuir)
```

O build **copia o player do plugin** automaticamente (task Gradle `copyPlayer`, de `../ds-facil/player/`). Se buildar
sem o plugin ao lado, rode `scripts/copy-player.sh` ou coloque `player.js`/`player.css` em `app/src/main/assets/`.

## Instalar

- **Celular/tablet:** habilite "Fontes desconhecidas" e abra o `.apk`.
- **Android TV / TV box:** `adb connect <ip>` → `adb install app-debug.apk`, ou use um app de "Downloader" com o link
  do `.apk`. O app aparece na fileira de apps da TV.

---

## Arquitetura (espelha o app Windows)

| Kotlin | Papel | Equivalente Windows |
|---|---|---|
| `App` | Sobe o servidor local + o loop de sync no boot do processo. | `main.js` (bootstrap) |
| `LocalServer` (NanoHTTPD) | `127.0.0.1:{porta}`: `/state`, `/state/auth`, `/media/{hash}` (com Range) + `/setup`, `/player`, `/assets/…` + a API `/dsf/…` do setup. | `server.js` |
| `Syncer` | `syncOnce()` (por `version`), `authenticate()`, loop com intervalo configurável. | `sync.js` |
| `MediaCache` | Espelho no disco (`filesDir/media`), `sha1(url)+ext`, download atômico `.part`→rename, prune/clear. | `cache.js` |
| `Config` | SharedPreferences (origin/token/device/favoritos/offline/intervalo/autostart). | `config.js` |
| `StateStore` | "Última versão boa" (`last-good.json`). | `state.js` |
| `Resolver` | link/código → `{origin, token}` (segue 302). | `resolve.js` |
| `MainActivity` | WebView kiosk fullscreen; decide setup/player; menu no Voltar/Menu. | `main.js` (janela) |
| `BootReceiver` | Auto-start no boot se ligado. | `setLoginItemSettings` |
| `assets/setup.*` | Setup próprio (fetch nos `/dsf/…`). | `renderer/setup.*` |
| `assets/player.html` + `player.js`/`player.css` (copiado) | O player. | `renderer/player.*` |

**Status:** MVP codado e **compilando** (APK debug gera). Falta testar em Android/Android TV real, ícone/arte
definitivos e assinatura de release. Repo git próprio, privado.
