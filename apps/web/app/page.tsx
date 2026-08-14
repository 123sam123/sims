/**
 * The front page: a live feed of what is happening on Earth right now. It leads
 * with what mattered — the highest-weight recent events — then runs the full
 * recency stream below. Spectator-only; there is not one control that touches
 * the world.
 */

import Link from "next/link";
import EventRow from "@/components/EventRow";
import Feed from "@/components/Feed";
import SiteHeader from "@/components/SiteHeader";
import { getFeedBundle } from "@/lib/data";
import { civHref, formatNumber } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page() {
  const feed = await getFeedBundle();

  return (
    <main className="wrap">
      <SiteHeader year={feed.year} active="feed" />

      <p className="lede">
        The physical Earth is fixed. Everything made — the settlements, the
        borders, the discoveries below — is the civilisations' own. This is the
        world's only memory: if it is not written here, it did not happen.
      </p>

      {feed.civs.length > 0 && (
        <section className="rail" aria-label="Civilisations">
          {feed.civs.map((c) => (
            <Link
              key={c.key}
              href={civHref(c.key)}
              className={`railcard${c.alive ? "" : " dead"}`}
              style={{ borderLeftColor: c.color }}
            >
              <span className="rc-name">
                <span className="dot" style={{ background: c.color }} />
                {c.name}
              </span>
              <span className="rc-stat">
                {formatNumber(c.population)} people · {c.settlements} settlements
              </span>
              <span className="rc-stat dim">{c.capabilities} capabilities</span>
            </Link>
          ))}
        </section>
      )}

      {feed.headlines.length > 0 && (
        <section className="headlines" aria-label="Leading events">
          <h2 className="section-h">What is mattering now</h2>
          <div className="headline-list">
            {feed.headlines.map((e) => (
              <EventRow key={e.id} item={e} />
            ))}
          </div>
        </section>
      )}

      <h2 className="section-h">The feed</h2>
      <Feed initial={feed.stream} />

      <p className="foot">
        Events are ranked by weight, not just recency, so the world leads with a
        collapse or a first meeting rather than the year-to-year hum. Click any
        event to walk backwards to what caused it.
      </p>
    </main>
  );
}
