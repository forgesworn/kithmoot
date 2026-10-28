#!/bin/sh
# Build the standard-profile spry-node and spry-turn executables that
# test/spry-room-relay.spec.ts runs, from one pinned spry-turn commit.
#
#   scripts/build-spry-node-fixture.sh <empty-or-new-directory>
#
# Prints the absolute path to put in E2E_SPRY_NODE_BINARY. The directory holds
# a shallow checkout of the pinned commit and its Cargo target; delete it when
# finished. Reuse one directory across runs to avoid recompiling dependencies.
set -eu

# Full commit SHA on forgesworn/spry-turn main. Move it deliberately, with the
# spec re-run, never to a branch name.
# SPRY_TURN_SHA may name another full commit for a run against unmerged
# server work (with SPRY_TURN_URL pointing at a local checkout); the room-seal
# tests in the spec need the room-grant paths, which this pin predates.
SPRY_TURN_SHA=${SPRY_TURN_SHA:-6b9dd555f57f54d45a0c01b77dd1d68a4ce6f5a4}
SPRY_TURN_URL=${SPRY_TURN_URL:-https://github.com/forgesworn/spry-turn.git}
case $SPRY_TURN_SHA in *[!0-9a-f]*|'') echo "SPRY_TURN_SHA must be a full commit SHA" >&2; exit 2 ;; esac
[ ${#SPRY_TURN_SHA} -eq 40 ] || { echo "SPRY_TURN_SHA must be a full commit SHA" >&2; exit 2; }

[ $# -eq 1 ] || { echo "usage: $0 <build-directory>" >&2; exit 2; }
mkdir -p "$1"
dir=$(cd "$1" && pwd)

if [ ! -d "$dir/src/.git" ]; then
  mkdir -p "$dir/src"
  git -C "$dir/src" init --quiet
  git -C "$dir/src" remote add origin "$SPRY_TURN_URL"
fi
git -C "$dir/src" fetch --quiet --depth 1 origin "$SPRY_TURN_SHA"
git -C "$dir/src" checkout --quiet --detach FETCH_HEAD
[ "$(git -C "$dir/src" rev-parse HEAD)" = "$SPRY_TURN_SHA" ] || { echo "checked out the wrong commit" >&2; exit 1; }

# spry-node supervises spry-turn from the same directory, so build both.
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$dir/target" \
  cargo build --locked --release --manifest-path "$dir/src/Cargo.toml" --workspace --features tls --bins >&2
echo "$dir/target/release/spry-node"
