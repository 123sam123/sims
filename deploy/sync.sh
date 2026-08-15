#!/bin/sh
# Deploy (or update) the simulation code on the sim host.
#
#   deploy/sync.sh ubuntu@HOST
#
# Rsyncs the repo into /opt/sims (excluding local state and anything
# git-ignored that isn't needed at runtime), installs dependencies there, and
# restarts the daemon. The world database lives in /var/lib/sims — outside the
# code tree — so a code sync never touches world state.
#
# First-time host setup is deploy/setup-host.sh; secrets live in
# /etc/sim-daemon.env on the host and are never synced from here.

set -eu

HOST="${1:?usage: deploy/sync.sh user@host}"

rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude worlds \
  --exclude .vercel \
  --exclude .fredrin \
  --exclude ".env*" \
  --exclude .next \
  --rsync-path="sudo -u sim rsync" \
  ./ "$HOST":/opt/sims/

ssh "$HOST" "sudo -u sim sh -c 'cd /opt/sims && pnpm install --frozen-lockfile' && sudo systemctl restart sim-daemon && sleep 3 && systemctl --no-pager --lines 5 status sim-daemon"
