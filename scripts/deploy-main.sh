#!/usr/bin/env bash
# Deploys the latest origin/main and confirms the live site serves that build.
#
#   scripts/deploy-main.sh         web app and server; the TV app only if it changed
#   scripts/deploy-main.sh --tv    also rebuild the TV app
#
# music.service runs from the repository's main checkout, so this script
# fast-forwards that checkout, builds the web app, and restarts the service.
# It rebuilds dist/music-tv.apk when the TV app changed since the last deploy.
# Deploys run one at a time and fetch after taking the lock, so a slower
# deploy cannot replace a newer merge with older code.
set -euo pipefail

force_tv=false
case "${1:-}" in
  --tv) force_tv=true ;;
  "") ;;
  *)
    echo "Usage: $0 [--tv]" >&2
    exit 2
    ;;
esac

git_dir="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)"
checkout="$(dirname "$git_dir")"
deployed_rev_file="$git_dir/music-deployed-rev"

exec 9>"$git_dir/music-deploy.lock"
echo "Waiting for any other deploy to finish..."
flock 9

cd "$checkout"
if [ "$(git symbolic-ref --short HEAD)" != main ]; then
  echo "$checkout is not on main; the service runs from it. Switch it back first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "$checkout has uncommitted changes; the service runs from it:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

previous_rev="$(cat "$deployed_rev_file" 2>/dev/null || git rev-parse HEAD)"
git fetch origin main
git merge --ff-only origin/main
rev="$(git rev-parse HEAD)"

bun install --frozen-lockfile
bun run build

tv_changed=false
if ! git cat-file -e "$previous_rev^{commit}" 2>/dev/null ||
  ! git diff --quiet "$previous_rev" "$rev" -- apps/tv Cargo.toml Cargo.lock scripts/build-tv-apk.sh; then
  tv_changed=true
fi
if [ "$force_tv" = true ] || [ "$tv_changed" = true ]; then
  ./scripts/build-tv-apk.sh
  echo "Rebuilt dist/music-tv.apk. Install it on the TV from http://192.168.1.67:4310/tv.apk."
fi

systemctl --user restart music.service
curl --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 1 \
  "http://127.0.0.1:4310/" | cmp - apps/web/dist/index.html

echo "$rev" >"$deployed_rev_file"
echo "Deployed $(git rev-parse --short HEAD)."
