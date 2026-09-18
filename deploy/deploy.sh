#!/usr/bin/env bash
set -euo pipefail

# deploy.sh - build the site locally and ship it to the KithMoot box as a new
# timestamped release, then flip the `current` symlink so Caddy serves it.
# This script is never run automatically by anything in this repo. It deploys
# to a real, public box, and a human runs it on purpose.
#
# Usage:
#   deploy/deploy.sh [--install-caddy] [--reload-caddy] [--prune N] [--dry-run]
#
# Env:
#   DEPLOY_HOST      required, e.g. deploy@your-box. No default on purpose:
#                    this is a public repository, and a hardcoded host is both
#                    somebody's server address and a way to deploy to the wrong
#                    box by forgetting to set it.
#   DEPLOY_KEY       ~/.ssh/id_ed25519
#   DEPLOY_ROOT      /var/www/kithmoot
#   ANDROID_APK      optional explicit APK path. It must match the checked-in
#                    site/android-release.json and passes signature, lineage,
#                    package, SDK, version and hash checks before upload.
#
# The published layout:
#
#   /var/www/kithmoot/
#     releases/<ts>/            one deploy: site/ at the root, app/dist under j/
#     current -> releases/<ts>  what Caddy's root points at
#     apk/                      outside the releases, so a rollback of the site
#                               does not take the downloads with it
#
# What it does, in order:
#   1. npm run build, local, producing app/dist
#   2. assemble a staging tree, local: site/ at the root, app/dist under j/
#   3. rsync it into a brand-new remote release directory. --delete only ever
#      applies to that just-created directory, never to an existing one
#   4. stage and re-hash an explicitly selected Android APK, if supplied
#   5. activate the stable APK link and current -> releases/<ts> together,
#      restoring the previous APK link if the site switch fails
#
# Idempotent: running it again with nothing changed builds and ships a new,
# identical release and re-flips the symlink at it. Nothing here overwrites a
# previous release in place, and nothing is deleted without --prune.

DEPLOY_HOST="${DEPLOY_HOST:-}"
if [ -z "$DEPLOY_HOST" ]; then
  echo "deploy.sh: DEPLOY_HOST is not set." >&2
  echo "  Set it to the box you mean to deploy to, e.g." >&2
  echo "    DEPLOY_HOST=deploy@your-box deploy/deploy.sh" >&2
  exit 2
fi
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/kithmoot}"

SSH_OPTS=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i "$DEPLOY_KEY")

INSTALL_CADDY=0
RELOAD_CADDY=0
PRUNE_KEEP=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: deploy/deploy.sh [--install-caddy] [--reload-caddy] [--prune N] [--dry-run]

  --install-caddy  Copy deploy/Caddyfile.kithmoot to the box's conf.d, validate
                   the whole Caddy config, and reload. Implies --reload-caddy.
                   Touches system config, so it never happens by default.
  --reload-caddy   Reload Caddy after the symlink flip. Not needed for a new
                   release to start serving, since Caddy re-resolves the
                   symlink on every request, but harmless.
  --prune N        Delete all but the N most recent release directories after a
                   successful deploy. The only destructive thing here, and it
                   never runs unless this flag is given.
  --dry-run        Build and assemble locally, print what would be shipped, and
                   touch nothing on the box.
  -h, --help       Show this help.

Env overrides: DEPLOY_HOST, DEPLOY_KEY, DEPLOY_ROOT, ANDROID_APK, ANDROID_BUILD_TOOLS.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-caddy) INSTALL_CADDY=1; RELOAD_CADDY=1; shift ;;
    --reload-caddy) RELOAD_CADDY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --prune)
      [[ $# -ge 2 ]] || { echo "deploy.sh: --prune needs a number" >&2; exit 1; }
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "deploy.sh: --prune wants a non-negative integer, got '$2'" >&2; exit 1; }
      PRUNE_KEEP="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy.sh: unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }

# --- build ------------------------------------------------------------------

echo "==> building app/dist"
npm run build

if [[ ! -s app/dist/index.html ]]; then
  echo "deploy.sh: app/dist/index.html is missing or empty after build, refusing to deploy" >&2
  exit 1
fi

# A wrong Vite base is invisible until the page is live and blank, with every
# asset 404ing. Check it here, where it is still cheap to fix.
if ! grep -q 'src="/j/assets/' app/dist/index.html; then
  echo "deploy.sh: app/dist/index.html does not reference /j/assets/, is base wrong in app/vite.config.ts?" >&2
  exit 1
fi

# --- assemble ---------------------------------------------------------------

staging="$(mktemp -d "${TMPDIR:-/tmp}/kithmoot-deploy.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

echo "==> assembling the release tree"
cp -R site/. "$staging"/
mkdir -p "$staging"/j
cp -R app/dist/. "$staging"/j/

for required in index.html style.css j/index.html j/sw.js j/manifest.webmanifest; do
  [[ -s "$staging/$required" ]] || { echo "deploy.sh: assembled tree is missing $required" >&2; exit 1; }
done

# mktemp -d makes the staging directory 0700, and rsync -a carries that
# faithfully to the box, where Caddy runs as its own user and answers 403 on
# every path underneath. Set the modes here rather than with rsync --chmod,
# which macOS's openrsync does not support. Doing it at the source also makes
# the result independent of whatever umask the operator happens to have.
chmod 755 "$staging"
find "$staging" -type d -exec chmod 755 {} +
find "$staging" -type f -exec chmod 644 {} +

echo "    $(find "$staging" -type f | wc -l | tr -d ' ') files, $(du -sh "$staging" | cut -f1)"

# --- the explicitly selected APK, if any ------------------------------------

apk_src="${ANDROID_APK:-}"
apk_name=""
apk_sha=""
node deploy/verify-android-publication.mjs
if [[ -n "$apk_src" ]]; then
  node deploy/verify-android-publication.mjs --apk "$apk_src"
  apk_name="$(node -e "const p=require('./site/android-release.json'); process.stdout.write(p.downloadFilename)")"
  apk_sha="$(node -e "const p=require('./site/android-release.json'); process.stdout.write(p.apkSha256.replaceAll(':', '').toLowerCase())")"
  echo "==> android: $apk_src -> $apk_name ($(du -h "$apk_src" | cut -f1))"
else
  echo "==> android: ANDROID_APK is not set, leaving the public APK unchanged"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> dry run: nothing was sent to $DEPLOY_HOST"
  exit 0
fi

# --- ship -------------------------------------------------------------------

release="$(date -u +%Y%m%dT%H%M%SZ)"
remote_release="$DEPLOY_ROOT/releases/$release"

# /var/www is root-owned, and every other tenant's directory under it is owned
# by the deploy user. First run creates ours the same way; after that nothing
# here needs sudo except the Caddy steps.
echo "==> ensuring $DEPLOY_ROOT exists"
remote bash -s <<REMOTE
set -euo pipefail
if [[ ! -d "$DEPLOY_ROOT" ]]; then
  echo "    creating $DEPLOY_ROOT (first run)"
  sudo install -d -m 0755 -o "\$(id -un)" -g "\$(id -gn)" "$DEPLOY_ROOT"
fi
mkdir -p "$remote_release" "$DEPLOY_ROOT/apk"
REMOTE

echo "==> rsyncing the release"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "$staging"/ "$DEPLOY_HOST:$remote_release/"

if [[ -n "$apk_name" ]]; then
  incoming="$DEPLOY_ROOT/apk/.incoming-$release-$apk_name"
  echo "==> staging $apk_name"
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$apk_src" "$DEPLOY_HOST:$incoming"
  remote bash -s <<REMOTE
set -euo pipefail
actual="\$(sha256sum "$incoming" | awk '{print \$1}')"
[[ "\$actual" == "$apk_sha" ]] || { echo "remote APK checksum mismatch" >&2; exit 1; }
# The signer writes its APK under umask 077 and rsync carries that mode here,
# where it is a file the web server cannot read: 0.6.5 was a 403 for everyone
# until somebody noticed. A published download is world-readable, always.
chmod 644 "$incoming"
if [[ -L "$DEPLOY_ROOT/apk/$apk_name" ]]; then
  echo "refusing a symlink at the versioned APK path" >&2
  exit 1
elif [[ -e "$DEPLOY_ROOT/apk/$apk_name" ]]; then
  existing="\$(sha256sum "$DEPLOY_ROOT/apk/$apk_name" | awk '{print \$1}')"
  [[ "\$existing" == "$apk_sha" ]] || { echo "refusing to replace a different $apk_name" >&2; exit 1; }
  chmod 644 "$DEPLOY_ROOT/apk/$apk_name"
  rm "$incoming"
else
  mv "$incoming" "$DEPLOY_ROOT/apk/$apk_name"
fi
REMOTE
fi

echo "==> activating releases/$release${apk_name:+ and $apk_name}"
remote bash -s <<REMOTE
set -euo pipefail
current_tmp="$DEPLOY_ROOT/current.$release.tmp"
ln -sfn "$remote_release" "\$current_tmp"
if [[ -n "$apk_name" ]]; then
  latest="$DEPLOY_ROOT/apk/kithmoot-latest.apk"
  latest_tmp="$DEPLOY_ROOT/apk/kithmoot-latest.$release.tmp"
  previous="\$(readlink "\$latest" 2>/dev/null || true)"
  ln -sfn "$apk_name" "\$latest_tmp"
  mv -Tf "\$latest_tmp" "\$latest"
  if ! mv -Tf "\$current_tmp" "$DEPLOY_ROOT/current"; then
    if [[ -n "\$previous" ]]; then
      ln -sfn "\$previous" "\$latest_tmp"
      mv -Tf "\$latest_tmp" "\$latest"
    else
      rm -f "\$latest"
    fi
    exit 1
  fi
else
  mv -Tf "\$current_tmp" "$DEPLOY_ROOT/current"
fi
REMOTE

# --- caddy ------------------------------------------------------------------

if [[ "$INSTALL_CADDY" -eq 1 ]]; then
  echo "==> installing the vhost"
  rsync -az -e "ssh ${SSH_OPTS[*]}" \
    deploy/Caddyfile.kithmoot "$DEPLOY_HOST:/tmp/kithmoot.forgesworn.dev.Caddyfile"
  remote bash -s <<'REMOTE'
set -euo pipefail
sudo install -m 0644 -o root -g root \
  /tmp/kithmoot.forgesworn.dev.Caddyfile \
  /etc/caddy/conf.d/kithmoot.forgesworn.dev.Caddyfile
rm -f /tmp/kithmoot.forgesworn.dev.Caddyfile
# Validates the whole config, every tenant's vhost included. A broken drop-in
# would take the entire box's Caddy down on reload, so this must pass first.
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
REMOTE
fi

if [[ "$RELOAD_CADDY" -eq 1 ]]; then
  echo "==> reloading caddy"
  remote "sudo systemctl reload caddy"
fi

# --- prune ------------------------------------------------------------------

if [[ "$PRUNE_KEEP" -gt 0 ]]; then
  echo "==> pruning releases, keeping the $PRUNE_KEEP most recent"
  remote bash -s <<REMOTE
set -euo pipefail
cd "$DEPLOY_ROOT/releases"
# Never remove whatever current points at, whatever its timestamp says.
live="\$(basename "\$(readlink -f "$DEPLOY_ROOT/current")")"
ls -1t | tail -n +$((PRUNE_KEEP + 1)) | while read -r old; do
  [[ "\$old" == "\$live" ]] && continue
  echo "removing \$old"
  rm -rf -- "\$old"
done
REMOTE
fi

echo "==> deployed release $release"
echo "    https://kithmoot.forgesworn.dev/  and  /j"
