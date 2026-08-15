# Operating cost

What it costs to run AI Civilization Earth in public, as deployed (2026-08).

## The moving parts

| Part | Where | Plan | Monthly |
|---|---|---|---|
| Website (`apps/web`) | Vercel, project `sims` | Hobby | $0 |
| Simulation daemon | AWS Lightsail `sims-daemon` (1 GB / 2 vCPU / 40 GB, us-east-1) | `micro_3_0` | $7 |
| Shared read store | Neon Postgres `sims-world` (Vercel Marketplace, iad1) | Free | $0 |
| Model brain | — (deployed with `--brain heuristic`) | — | $0 |
| **Total** | | | **~$7** |

## Where the ceilings are

- **Lightsail ($7, fixed).** The world uses ~150 MB RSS and the bundle includes
  the public IPv4 and 2 TB of transfer — nothing usage-based to watch. The 40 GB
  disk holds the SQLite store; events are ~200 bytes/row, keyframe snapshots
  ~2.6 MB each, so years of history fit with room to spare.
- **Neon (free tier: ~190 compute-hours/mo, 0.5 GB storage).** The daemon
  publishes at most one 2.6 MB snapshot per 30 s plus tiny event rows, and only
  when the sim-year actually advances. In fast, empty eras that keeps the
  endpoint awake more of the day; as event density rises the pace slows toward
  hours-per-year and Neon autosuspends between writes. If the free
  compute-hours run out the store throttles (the site then serves each
  instance's memoised snapshot); the fix is Neon **Launch at $19/mo**. Storage
  holds ~2.5 M events on the free tier — decades of sim history.
- **Vercel (Hobby, $0).** Everything the site serves is small JSON/HTML; the
  heavy 2.6 MB snapshot is fetched from Neon only when the world version
  changes per warm function instance. High public traffic would first show up
  as Neon egress and Vercel function invocations; Pro is $20/mo if it comes to
  that.
- **Model brain ($0 as deployed).** The daemon runs the deterministic heuristic
  minds. Giving the civilisations a model mind is an env edit on the sim host
  (see `deploy/README.md`): the attention budget then caps spend at
  `--daily-usd N` — $2/day ≈ $60/mo worst case, spent only when decisions are
  consequential enough to bid past the bar.

## Rough total by posture

| Posture | Monthly |
|---|---|
| As deployed (heuristic minds, free Neon) | ~$7 |
| Model minds at $2/day cap | ~$67 |
| Busy site (Neon Launch + Vercel Pro) + model minds | ~$106 |
