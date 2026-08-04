# DS View

App **kiosk offline** (Electron, Windows 10/11 x64) que roda uma playlist do [DS View](https://seusite.com.br)
numa TV / mini-PC / TV Box. É uma **casca full-screen sem barra de URL** em volta do player que já existe no
plugin — com **cache local** para funcionar mesmo sem internet.

> Repositório separado do plugin. O player (`player.js`/`player.css`) é **copiado** do plugin no build
> (fonte única = `../ds-facil/player/`), nunca editado aqui.

---

## O que ele faz

- **Full-screen kiosk** sem barra de endereço. Botão direito abre o menu de contexto (Configurações / Recarregar / Sair).
- **Setup na 1ª execução:** cola o link `/play/{token}` (ou o código curto) da playlist. **Favoritos** para guardar várias URLs.
- **Offline-first:** um servidor local (`127.0.0.1`) fica entre o player e o servidor remoto. O player fala só com o
  local; um **loop de sync** (a cada 30s) baixa a mídia nova, remove a que saiu do payload e mantém o disco como
  **espelho do online**. Internet caiu? O player segue tocando do cache.
- **Preloader** no 1º acesso / troca de playlist (baixa tudo antes de iniciar).
- **Auto-start no boot** do Windows (opcional, ligado no setup).
- **Anti-sleep** (a tela não apaga) e **single-instance**.

---

## Rodar em desenvolvimento

```bash
npm install
npm start        # copia o player do plugin e abre o Electron
```

Sair do kiosk: **Ctrl+Shift+Q**.

## Gerar o instalador (Windows)

```bash
npm run dist      # gera dist/ com o instalador NSIS (.exe) + versão portátil
```

> Ícone: coloque um `assets/icon.ico` (256×256) e descomente a linha `icon:` em `electron-builder.yml`.
> Assinatura de código é opcional (sem ela, o Windows mostra o aviso do SmartScreen na 1ª execução).

---

## Arquitetura (cache-proxy + webview)

```
Renderer (janela kiosk)                 Main process (Node)
  player.html → player.js (cópia)   →   server.js  (127.0.0.1)
    api = 127.0.0.1:PORT/state             /state       → cache atual (reescrito p/ /media/{hash})
                                           /state/auth   → repassa pro servidor real + guarda device
                                           /media/{hash} → arquivo do disco (com Range → vídeo)
  setup.html → setup.js (preload)        sync.js    (loop 30s: baixa novo, remove o que saiu)
                                         cache.js   (download atômico .part→rename, prune)
                                         config.js  (userData: origin, token, device, favoritos, autostart)
```

- **Online:** o sync busca o payload real, baixa a mídia nova pro disco, e grava como "última versão boa".
- **Offline:** `/state` devolve a última versão boa do cache; o `player.js` roda **idêntico**, sem perceber.
- YouTube/Vimeo **não** são cacheados (o vídeo mora na plataforma) — online tocam normal, offline são pulados.

---

## Status

**MVP funcional** (kiosk + setup + favoritos + auto-start + servidor local + sync + cache offline).
Falta testar em máquina Windows real e empacotar o instalador. Ícone/arte e auto-update (electron-updater)
são fase 2. Baseado no `player-app/PLAN.md` do projeto.
