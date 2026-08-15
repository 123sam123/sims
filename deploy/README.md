# Deployment

The public deployment is split exactly the way the code splits: **Vercel serves
the site, a small VM runs the world, Neon Postgres is the store both can
reach.** Vercel Functions are request-scoped (300 s ceiling) and can never run
the tick loop — that is a settled finding, not a preference.

```
┌─────────────────────┐   publishes (30s throttle)   ┌──────────────────┐
│ Lightsail VM        │ ───────────────────────────▶ │ Neon Postgres    │
│  sim-daemon.service │   snapshot · events · census │  world_latest    │
│  SQLite (authority) │                              │  events, census  │
└─────────────────────┘                              └────────┬─────────┘
                                                      reads   │ (read-only)
                                                     ┌────────▼─────────┐
                                                     │ Vercel: apps/web │
                                                     └──────────────────┘
```

- The VM's SQLite file (`/var/lib/sims/world.db`) is **authoritative**: the
  daemon resumes from it and its snapshot/dedupe contract is unchanged.
- Postgres is the site's **read replica** (`packages/runner/src/publish.ts`
  writes it; `apps/web/lib/remote.ts` reads it). The daemon is the only writer.
- Every layer degrades: Postgres down → daemon keeps ticking and the replica
  self-heals by event id; daemon down → the site serves the last published
  snapshot; replica empty → the site renders a generated year-0 Earth.

## Live resources (2026-08)

- Site: https://sims-orcin-kappa.vercel.app (Vercel project `sims`, root
  directory `apps/web`, Node 24)
- Sim host: Lightsail `sims-daemon`, us-east-1a, `micro_3_0` (1 GB), Ubuntu
  24.04, firewall SSH-only, static IP `75.101.216.16` — `ssh ubuntu@75.101.216.16`
- Store: Neon `sims-world` via the Vercel Marketplace integration (region
  iad1); `DATABASE_URL` is injected into Vercel env by the integration

## First-time host setup

```sh
scp -r deploy ubuntu@HOST:
ssh ubuntu@HOST "sudo sh deploy/setup-host.sh"   # Node 24, pnpm, sim user, unit
deploy/sync.sh ubuntu@HOST                       # code → /opt/sims (+ install)
ssh ubuntu@HOST "sudo vi /etc/sim-daemon.env"    # paste DATABASE_URL (vercel env pull)
ssh ubuntu@HOST "sudo -u sim sh -c 'cd /opt/sims && pnpm new --seed 1 --db /var/lib/sims/world.db'"
ssh ubuntu@HOST "sudo systemctl start sim-daemon"
```

## Updating code

- **Site**: `vercel deploy --prod` from the repo root (or the Git integration).
- **Daemon**: `deploy/sync.sh ubuntu@HOST` — rsyncs, installs, restarts. The
  world DB lives outside the code tree and is never touched by a sync.

## Secrets

All configuration is environment-side, never in the repo:

- Vercel: the Neon integration manages `DATABASE_URL` (see `vercel env ls`).
- VM: `/etc/sim-daemon.env` (mode 600) carries `DATABASE_URL`, `DAEMON_FLAGS`
  and optionally `ANTHROPIC_API_KEY`.

## Giving the civilisations a model mind

The daemon ships running the free deterministic heuristic. To route
consequential decisions through a model within a hard daily budget, edit
`/etc/sim-daemon.env` on the host:

```sh
ANTHROPIC_API_KEY=sk-ant-…
DAEMON_FLAGS=--brain api --daily-usd 2
```

then `sudo systemctl restart sim-daemon`. The attention allocator keeps spend
under the cap and degrades to the heuristic when it runs out — the world never
stalls (see `docs/operating-cost.md` for what a cap costs).

## Operations

```sh
ssh ubuntu@HOST "sudo journalctl -u sim-daemon -f"          # live log
ssh ubuntu@HOST "sudo systemctl restart sim-daemon"          # supervised restart
ssh ubuntu@HOST "sudo -u sim sh -c 'cd /opt/sims && pnpm daemon report --db /var/lib/sims/world.db'"
```

Kill it however you like — every tick ends with a durable snapshot, so a crash,
`kill -9` or reboot resumes from the last completed tick (verified on this
host: hard kill resumed mid-run; a reboot auto-started the unit and continued).

**Losing the VM entirely** loses only sim-host state since the last publish
(≤ 30 s). Provision a fresh host with the steps above, then instead of
`pnpm new`, continue the same world from the replica:

```sh
ssh ubuntu@HOST "sudo -u sim sh -c 'cd /opt/sims && set -a && . /etc/sim-daemon.env && pnpm daemon restore --db /var/lib/sims/world.db'"
```
