#!/usr/bin/env bash
set -euo pipefail

# prune-releases.sh ROOT KEEP
#
# Run on the box by `deploy.sh --prune N`, piped over ssh, and by
# prune-releases.test.mjs against a scratch tree. Deletes all but the KEEP
# newest release directories under ROOT/releases, never the one ROOT/current
# points at.
#
# Newest means by name. A release is named for the UTC time it was deployed
# (YYYYMMDDTHHMMSSZ), so the names sort in deploy order. Modification times do
# not: rsync gives a new release the staging tree's time, and anything copied
# into an old release later touches it. On 14 November 2026 `--prune 10` by
# modification time deleted the release deployed an hour before. Anything
# else under releases/ is not a release and is left alone.

root="$1"
keep="$2"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "prune-releases.sh: KEEP must be a positive whole number, got '$keep'" >&2; exit 1; }

cd "$root/releases"
# Never remove whatever current points at, whatever its name says.
live=""
if target="$(readlink -f "$root/current")"; then live="${target##*/}"; fi

export LC_ALL=C
seen=0
for name in $(ls -1 | sort -r); do
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ && -d "$name" && ! -L "$name" ]] || continue
  seen=$((seen + 1))
  (( seen <= keep )) && continue
  [[ "$name" == "$live" ]] && continue
  # A release this user cannot delete (one a root deploy left) is reported and
  # kept, rather than stopping the deploy after it has already gone live.
  if rm -rf -- "$name" 2>/dev/null; then echo "removed $name"; else echo "kept $name: not removable by $(id -un)"; fi
done
