#!/usr/bin/env bash
# Builds the signed TV app into dist/music-tv.apk.
#
#   scripts/build-tv-apk.sh            64- and 32-bit ARM in one APK
#   scripts/build-tv-apk.sh arm64      64-bit ARM only (fast: Skia comes prebuilt)
#
# 32-bit ARM builds Skia from source the first time (about half an hour),
# because rust-skia publishes no prebuilt 32-bit Android binaries.
#
# Needs rustup's Android targets, the Android SDK with build-tools 35 and
# NDK 27, a JDK, and cargo-apk. See README "TV app".
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT:-$ANDROID_HOME/ndk/27.2.12479018}"
# Building Skia from source (32-bit ARM) reads this name.
export ANDROID_NDK="$ANDROID_NDK_ROOT"

# Updates only install over an APK signed with the same key, so keep it.
keystore="${MUSIC_TV_KEYSTORE:-$HOME/.config/music/tv-release.keystore}"
password="${MUSIC_TV_KEYSTORE_PASSWORD:-music-tv}"
if [[ ! -f "$keystore" ]]; then
  mkdir -p "$(dirname "$keystore")"
  keytool -genkeypair -keystore "$keystore" -storepass "$password" -keypass "$password" \
    -alias music-tv -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Music TV" >/dev/null
  echo "Created signing key $keystore. Back it up: updates need the same key."
fi
export CARGO_APK_RELEASE_KEYSTORE="$keystore"
export CARGO_APK_RELEASE_KEYSTORE_PASSWORD="$password"

cd "$root/apps/tv"
if [[ "${1:-}" == "arm64" ]]; then
  cargo apk build --release --lib --target aarch64-linux-android
else
  cargo apk build --release --lib
fi
mkdir -p "$root/dist"
cp "$root/target/release/apk/music-tv.apk" "$root/dist/music-tv.apk"
ls -lh "$root/dist/music-tv.apk"
