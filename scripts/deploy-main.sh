#!/usr/bin/env bash
# Builds the latest origin/main as a release, which goes live once nothing
# has played for a while.
#
#   scripts/deploy-main.sh             stage it; scripts/activate-release.sh
#                                      restarts onto it when the music is quiet
#   scripts/deploy-main.sh --now       stage it and restart onto it now
#   scripts/deploy-main.sh --tv        also rebuild the TV app
#
# music.service runs from ~/.local/share/music/current, a link to one
# release: a copy of the repository at one commit, with its own node_modules,
# web build, and TV app. A deploy fast-forwards the main checkout, builds a
# new release from it, and points ~/.local/share/music/pending at it. The
# running server never sees a file change under it, so the site, the server,
# and the TV app it offers always come from one commit, and a restart never
# cuts off a song. music-release.timer runs scripts/activate-release.sh every
# minute, which switches over once nothing has played for 10 minutes.
#
# The TV app is rebuilt when apps/tv or the Cargo files changed since the
# last deploy. The TV downloads it after the switch, and installs it only
# when someone picks Install update in its Settings.
#
# Deploys run one at a time and fetch after taking the lock, so a slower
# deploy cannot replace a newer merge with older code.
set -euo pipefail

now=false
force_tv=false
for argument in "$@"; do
  case "$argument" in
    --now) now=true ;;
    --tv) force_tv=true ;;
    *)
      echo "Usage: $0 [--now] [--tv]" >&2
      exit 2
      ;;
  esac
done

git_dir="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)"
checkout="$(dirname "$git_dir")"
deployed_rev_file="$git_dir/music-deployed-rev"
music_home="${MUSIC_HOME:-$HOME/.local/share/music}"
releases="$music_home/releases"

exec 9>"$git_dir/music-deploy.lock"
echo "Waiting for any other deploy to finish..."
flock 9

cd "$checkout"
if [ "$(git symbolic-ref --short HEAD)" != main ]; then
  echo "$checkout is not on main; deploys build from it. Switch it back first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "$checkout has uncommitted changes; deploys build from it:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

previous_rev="$(cat "$deployed_rev_file" 2>/dev/null || git rev-parse HEAD)"
git fetch origin main
git merge --ff-only origin/main
rev="$(git rev-parse HEAD)"

# The TV app builds in the checkout, where Cargo keeps its build cache.
if [ "$force_tv" = true ] ||
  ! git cat-file -e "$previous_rev^{commit}" 2>/dev/null ||
  ! git diff --quiet "$previous_rev" "$rev" -- apps/tv Cargo.toml Cargo.lock scripts/build-tv-apk.sh ||
  [ ! -f dist/music-tv.apk ]; then
  ./scripts/build-tv-apk.sh
fi

release="$releases/$rev"
staging="$release.partial"
rm -rf "$staging"
if [ ! -d "$release" ]; then
  echo "Building the release for $(git rev-parse --short HEAD)..."
  mkdir -p "$staging"
  git archive "$rev" | tar -x -C "$staging"
  (
    cd "$staging"
    bun install --frozen-lockfile
    bun run build
  )
fi

# NOTE: under the lock scripts/activate-release.sh holds while it switches
# and prunes, so it never removes a release between here and `pending`.
mkdir -p "$music_home"
exec 8>"$music_home/release.lock"
flock 8
if [ -d "$staging" ]; then
  if [ -d "$release" ]; then
    rm -rf "$staging"
  else
    mv "$staging" "$release"
  fi
elif [ ! -d "$release" ]; then
  echo "The release $rev was removed while this deploy ran. Deploy again." >&2
  exit 1
fi
# The TV app the release offers: the newest build, made from this commit
# or from the last one that changed the TV app.
mkdir -p "$release/dist"
cp dist/music-tv.apk "$release/dist/music-tv.apk.partial"
mv -f "$release/dist/music-tv.apk.partial" "$release/dist/music-tv.apk"
cp dist/music-tv.build "$release/dist/music-tv.build"
ln -sfn "$release" "$music_home/pending.new"
mv -T "$music_home/pending.new" "$music_home/pending"
exec 8>&-
echo "$rev" >"$deployed_rev_file"

# The timer that puts the release live, from the checkout's copy of its units.
mkdir -p "$HOME/.config/systemd/user"
units_changed=false
for unit in music-release.service music-release.timer; do
  if ! cmp -s "scripts/systemd/$unit" "$HOME/.config/systemd/user/$unit"; then
    cp "scripts/systemd/$unit" "$HOME/.config/systemd/user/$unit"
    units_changed=true
  fi
done
if [ "$units_changed" = true ]; then
  systemctl --user daemon-reload
fi
systemctl --user enable --now music-release.timer >/dev/null

if [ "$now" = true ]; then
  ./scripts/activate-release.sh --now
else
  echo "Staged $(git rev-parse --short HEAD). It goes live once nothing has played for 10 minutes; pass --now to restart onto it now."
fi
