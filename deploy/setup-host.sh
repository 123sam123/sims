#!/bin/sh
# One-time bootstrap for the sim host (Ubuntu 24.04). Run as root:
#
#   scp -r deploy ubuntu@HOST: && ssh ubuntu@HOST "sudo sh deploy/setup-host.sh"
#
# Installs Node 24 (node:sqlite needs it) and pnpm, creates the `sim` user and
# the code/state directories, adds swap headroom for a 1 GB instance, and
# installs the systemd unit. Idempotent — safe to re-run.
#
# It does NOT write secrets: /etc/sim-daemon.env is created as a template on
# first run and you fill DATABASE_URL in by hand (or with deploy/sync.sh --env).

set -eu

# --- Node 24 + pnpm ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
corepack enable
corepack prepare pnpm@11.18.0 --activate

# --- user + directories -----------------------------------------------------
id sim >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin sim
mkdir -p /opt/sims /var/lib/sims
chown sim:sim /opt/sims /var/lib/sims

# --- swap (1 GB instances: keep a rare allocation spike from OOM-killing) ---
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- config template (secrets filled in by hand, never committed) -----------
if [ ! -f /etc/sim-daemon.env ]; then
  cat > /etc/sim-daemon.env <<'EOF'
# Shared read store the daemon publishes into (the website reads it).
DATABASE_URL=
# Brain transport + budget. Heuristic is free and deterministic; to give the
# civilisations a model mind, set ANTHROPIC_API_KEY and use:
#   DAEMON_FLAGS=--brain api --daily-usd 2
DAEMON_FLAGS=--brain heuristic
EOF
  chmod 600 /etc/sim-daemon.env
fi

# --- systemd unit ------------------------------------------------------------
cp "$(dirname "$0")/sim-daemon.service" /etc/systemd/system/sim-daemon.service
systemctl daemon-reload
systemctl enable sim-daemon
echo "setup complete — sync code with deploy/sync.sh, seed a world, then: systemctl start sim-daemon"
