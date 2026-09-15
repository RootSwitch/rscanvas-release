#!/usr/bin/env bash
# Push the working tree to the scale lab and install dependencies there.
#
# The application has to RUN on the lab, not talk to it. Postgres listens on
# localhost only, and every figure in the done-when criteria (search inside 262
# to 277ms cold, heartbeat worst gap under 50ms) assumes the application and
# the database share a machine. Driving the lab's database from a workstation
# over the LAN would put a network round trip inside every measurement and
# quietly invalidate all of them.
#
# Idempotent: run it as often as you like. node_modules is excluded so a sync
# does not blow away an install, and --delete keeps the lab from accumulating
# files that no longer exist here.
#
#   tools/sync-lab.sh              # sync and install
#   tools/sync-lab.sh --no-install # sync only
#
# Run from WSL, where the ssh key lives.

set -euo pipefail

# No default box: name it every time (LAB=user@host), so a public copy of
# this script cannot carry a private address and a habitual run cannot
# push to the wrong lab.
LAB="${LAB:?set LAB=user@host - the lab box to sync to}"
DEST="${DEST:-/home/user/rscanvas}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --delete makes DEST authoritative: everything under it that is not in this
# repo is removed. DEST=/home/user - one habitual value, and a plausible typo
# from the default - would delete the lab user's entire home directory,
# including the corpus's own backups and every result file not yet pulled back.
#
# Same question as every destructive path in this tree: is the target NAMED or
# discovered. Here it is named, and the name has to look like a checkout rather
# than a home or a root.
case "$DEST" in
    */rscanvas|*/rscanvas-*) ;;
    *)
        echo "refusing: DEST=$DEST is not a checkout path" >&2
        echo "rsync --delete makes it authoritative, so it must end in /rscanvas or /rscanvas-*" >&2
        exit 1
        ;;
esac

echo "syncing $HERE -> $LAB:$DEST"

# Bundles and the workstation's own assistant settings are not the tree: the
# 2026-09-06 upgrade dry run would have pushed twenty tarballs and .claude/
# to the lab box, because both are gitignored but not excluded here, and
# rsync copies the working directory, not the repository.
rsync -az --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '*.log' \
    --exclude '*.tar.gz' \
    --exclude '.claude/' \
    "$HERE/" "$LAB:$DEST/"

echo "synced"

if [[ "${1:-}" == "--no-install" ]]; then
    exit 0
fi

# npm ci would be stricter, but the lockfile is generated on Windows and the
# lab is Linux. npm install is the honest choice here.
ssh "$LAB" "cd $DEST && npm install --no-audit --no-fund 2>&1 | tail -3"

ssh "$LAB" "cd $DEST && node --version && npx tsc --noEmit && echo 'typecheck clean on lab'"
