#!/usr/bin/env bash
# Copia player.js/player.css do plugin de sinalização para os assets do app Android.
# Fonte única = ../../ds-facil/player/. A cópia é gitignorada; nunca editar aqui — corrigir no plugin.
# (O build já roda isso via task Gradle `copyPlayer`; este script é para rodar manual se quiser.)
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
FROM="$DIR/../../ds-facil/player"
TO="$DIR/app/src/main/assets"
for f in player.js player.css; do
  if cp "$FROM/$f" "$TO/$f" 2>/dev/null; then echo "  ✓ $f  ←  $FROM/$f"; else echo "  ⚠ não achei $FROM/$f — coloque $f em app/src/main/assets/ manualmente."; fi
done
