#!/bin/sh
# Installs Hanabi Wallpapers for the current user (no root needed).
set -e
cd "$(dirname "$0")"
install -Dm755 hanabi-picker "$HOME/.local/bin/hanabi-picker"
sed "s|^Exec=.*|Exec=$HOME/.local/bin/hanabi-picker|" hanabi-wallpapers.desktop \
  > "$HOME/.local/share/applications/hanabi-wallpapers.desktop"
echo "Installed. Open \"Hanabi Wallpapers\" from your app menu."
