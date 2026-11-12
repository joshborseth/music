#!/usr/bin/env bash
# Renders every app icon from the SVGs in branding/. Needs rsvg-convert and
# ImageMagick. Run it after changing the logo, and commit the results.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
brand="$root/branding"
web="$root/apps/web/public"
tv="$root/apps/tv"

png() { rsvg-convert -w "$2" -h "$2" "$brand/$1.svg" -o "$3"; }

cp "$brand/logo.svg" "$web/favicon.svg"
png logo-square 180 "$web/apple-touch-icon.png"
png logo 192 "$web/pwa-192x192.png"
png logo 512 "$web/pwa-512x512.png"
png logo-maskable 512 "$web/maskable-icon-512x512.png"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for size in 16 32 48; do png logo "$size" "$tmp/$size.png"; done
magick "$tmp/16.png" "$tmp/32.png" "$tmp/48.png" "$web/favicon.ico"

png logo 96 "$tv/res/mipmap-xhdpi/ic_launcher.png"
png logo 192 "$tv/res/mipmap-xxxhdpi/ic_launcher.png"
rsvg-convert -h 340 "$brand/logo-mark.svg" -o "$tv/ui/images/logo-mark.png"
