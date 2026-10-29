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

# GNOME Shell extension that runs scene/web wallpapers as the desktop background
ext="wpe-background@topdarkflames.github.io"
exts="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$exts"
rm -rf "${exts:?}/$ext"
cp -r "extension/$ext" "$exts/"
# a new extension is only loaded at the next login on Wayland, so `gnome-extensions enable` can't see it yet
if command -v gsettings >/dev/null; then
  python3 - "$ext" <<'PY' || true
import ast, subprocess, sys
ext = sys.argv[1]
cur = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True).stdout
cur = cur.split(" ", 1)[1] if cur.startswith("@as ") else cur
enabled = ast.literal_eval(cur.strip() or "[]")
if ext not in enabled:
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(enabled + [ext])], check=True)
PY
fi
echo "Installed. Open \"Hanabi Wallpapers\" from your app menu."
echo "Log out and back in once so GNOME loads the Wallpaper Engine Background extension (scene/web wallpapers)."
