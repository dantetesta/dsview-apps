/**
 * Copia o player (player.js/player.css) do plugin DS View para o renderer deste app.
 * Fonte única = ../../ds-facil/player/. A cópia é gitignorada; nunca editar aqui.
 * Se o plugin não estiver ao lado (ex.: build isolado), avisa mas não quebra — o dev pode
 * colocar os arquivos manualmente em src/renderer/.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const from = path.resolve(__dirname, '..', '..', '..', 'ds-facil', 'player');
const to = path.resolve(__dirname, '..', 'src', 'renderer');

const files = ['player.js', 'player.css'];
let ok = true;
for (const f of files) {
  const src = path.join(from, f);
  const dst = path.join(to, f);
  try {
    // O player vem do plugin com o cabeçalho da marca de origem. Este app é white-label, então
    // o bloco de comentário inicial vira um cabeçalho neutro — sem citar nome nenhum aqui, que
    // este repositório é público. Só o cabeçalho carrega marca; o código em si é neutro.
    const conteudo = fs
      .readFileSync(src, 'utf8')
      .split('\n')
      .map((linha) => (/^\s*(\/\*|\*)/.test(linha) ? '' : linha))
      .join('\n');
    fs.writeFileSync(dst, conteudo);
    console.log(`  ✓ ${f}  ←  ${path.relative(process.cwd(), src)}`);
  } catch (e) {
    ok = false;
    console.warn(`  ⚠ não achei ${src} — coloque ${f} em src/renderer/ manualmente.`);
  }
}
if (!ok) process.exitCode = 0; // não trava o build; só avisa.
