#!/usr/bin/env bash
# Puts the staged release live: points ~/.local/share/music/current at
# ~/.local/share/music/pending and restarts music.service.
#
#   scripts/activate-release.sh          only once nothing has played for
#                                        QUIET_MINUTES (default 10)
#   scripts/activate-release.sh --now    now, even mid-song
#
# music-release.timer runs this every minute; scripts/deploy-main.sh stages
# the releases. It asks the running server how long nothing has played
# (GET /session/quiet); a server that does not answer is switched at once.
# It also installs the release's music.service, so a change to the unit
# ships with the code that needs it. If the new server does not serve its
# own web app, it goes back to the release before.
set -euo pipefail

now=false
case "${1:-}" in
  --now) now=true ;;
  "") ;;
  *)
    echo "Usage: $0 [--now]" >&2
    exit 2
    ;;
esac

music_home="${MUSIC_HOME:-$HOME/.local/share/music}"
quiet_minutes="${QUIET_MINUTES:-10}"
server="${MUSIC_SERVER_URL:-http://127.0.0.1:4310}"
pending="$music_home/pending"
current="$music_home/current"
unit_dir="$HOME/.config/systemd/user"

exec 9>"$music_home/release.lock"
flock 9

[ -L "$pending" ] || exit 0
target="$(readlink -f "$pending")"
if [ ! -d "$target" ]; then
  echo "The staged release $target is gone." >&2
  rm -f "$pending"
  exit 1
fi
if [ -L "$current" ] && [ "$(readlink -f "$current")" = "$target" ]; then
  rm -f "$pending"
  exit 0
fi

if [ "$now" = false ]; then
  status=0
  report="$(curl --fail --silent --max-time 5 "$server/session/quiet")" || status=$?
  case "$status" in
    0)
      quiet_seconds="$(jq -r '.quietSeconds' <<<"$report")"
      if [ "$quiet_seconds" -lt $((quiet_minutes * 60)) ]; then
        exit 0
      fi
      ;;
    # Nothing listens, or nothing answers: the server is down or stuck.
    7 | 28) echo "The server did not answer; switching now." ;;
    *)
      echo "The server could not say whether music plays (curl exit $status); waiting." >&2
      exit 0
      ;;
  esac
fi

switch_to() {
  ln -sfn "$1" "$current.new"
  mv -T "$current.new" "$current"
  if ! cmp -s "$1/scripts/systemd/music.service" "$unit_dir/music.service"; then
    mkdir -p "$unit_dir"
    cp "$1/scripts/systemd/music.service" "$unit_dir/music.service"
    systemctl --user daemon-reload
  fi
  systemctl --user restart music.service
  curl --fail --silent --retry 30 --retry-connrefused --retry-delay 1 \
    "$server/" | cmp -s - "$1/apps/web/dist/index.html"
}

maybe_before="$(readlink -f "$current" 2>/dev/null || true)"
echo "Switching to $(basename "$target")..."
if ! switch_to "$target"; then
  echo "The release $(basename "$target") did not come up." >&2
  if [ -n "$maybe_before" ] && [ -d "$maybe_before" ]; then
    echo "Going back to $(basename "$maybe_before")." >&2
    switch_to "$maybe_before" || true
  fi
  rm -f "$pending"
  exit 1
fi
rm -f "$pending"
if [ -n "$maybe_before" ]; then
  ln -sfn "$maybe_before" "$music_home/previous"
fi

# Keep the live release and the one before it; remove the rest.
keep_previous="$(readlink -f "$music_home/previous" 2>/dev/null || true)"
for release in "$music_home"/releases/*; do
  [ -d "$release" ] || continue
  case "$release" in
    # A `.partial` is a deploy still building.
    "$target" | "$keep_previous" | *.partial) ;;
    *) rm -rf "$release" ;;
  esac
done
echo "Live: $(basename "$target")."
