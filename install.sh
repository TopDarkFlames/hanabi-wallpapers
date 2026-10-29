#!/bin/sh
# Installs Hanabi Wallpapers for the current user (no root needed).
set -eu
cd "$(dirname "$0")"
bin="$HOME/.local/bin/hanabi-picker"
apps="$HOME/.local/share/applications"
desktop="$apps/io.github.topdarkflames.HanabiWallpapers.desktop"
mkdir -p "$apps"
install -Dm755 hanabi-picker "$bin"
# Exec com o caminho completo entre aspas: funciona sem ~/.local/bin no PATH e com espaços no HOME
escaped=$(printf '%s' "$bin" | sed 's/[\\"`$]/\\&/g')
tmp=$(mktemp "$apps/.hanabi-wallpapers.XXXXXX")
grep -v '^Exec=' io.github.topdarkflames.HanabiWallpapers.desktop > "$tmp"
printf 'Exec="%s"\n' "$escaped" >> "$tmp"
mv "$tmp" "$desktop"
rm -f "$apps/hanabi-picker.desktop" "$apps/hanabi-wallpapers.desktop"  # nomes de versões antigas
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" 2>/dev/null || true
echo "Installed. Open \"Hanabi Wallpapers\" from your app menu."
