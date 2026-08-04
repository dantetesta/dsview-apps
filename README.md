# DS View — apps para TV

Dois aplicativos que abrem uma playlist em tela cheia, baixam o conteúdo para o aparelho e
continuam tocando mesmo sem internet.

| Pasta | O que é | Roda em |
|---|---|---|
| `android/` | App Kotlin com WebView + servidor local (NanoHTTPD) | Android 5.0+, incluindo Android TV e TV Box |
| `windows/` | App Electron com o mesmo desenho de cache local | Windows 10 e 11 |

Os dois usam a mesma arquitetura: um servidor em `127.0.0.1` imita a API da playlist, o player
conversa só com ele, e um laço de sincronização espelha as mídias no disco. Por isso funcionam
offline depois do primeiro download.

## Baixar pronto

Os instaladores ficam em [Releases](../../releases/latest). Não é preciso compilar nada para usar.

## Compilar

**Android**

```bash
cd android
./gradlew assembleDebug      # gera app/build/outputs/apk/debug/app-debug.apk
```

**Windows**

```bash
cd windows
npm install
npm start                    # roda em modo desenvolvimento
npm run dist                 # gera o instalador NSIS em dist/
```

## Player

O arquivo `player.js` (e o `player.css`) **não vive aqui**. Ele é copiado no build a partir do
servidor de playlists, para que os dois apps e a página web toquem exatamente o mesmo player.
A cópia é ignorada pelo git de propósito: nunca edite os arquivos em
`android/app/src/main/assets/` nem em `windows/src/renderer/` — a correção é sempre na origem.

O build também limpa os comentários de cabeçalho da cópia, para o app sair neutro.
