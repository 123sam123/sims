/**
 * A settlement page: when it was founded, how its population rose and fell, and
 * the events that happened on its ground. Read-only from the world and the log.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import EventRow from "@/components/EventRow";
import MapFocus from "@/components/MapFocus";
import OverlayPanel from "@/components/OverlayPanel";
import Sparkline from "@/components/Sparkline";
import { getSettlementPage } from "@/lib/data";
import { civHref, formatNumber, formatYear } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SettlementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const n = Number(id);
  const s = Number.isFinite(n) ? await getSettlementPage(n) : null;
  if (!s) notFound();

  return (
    <OverlayPanel kind="Settlement">
      <MapFocus cell={s.cell} />
      <header
        className="page-head"
        style={{ borderTopColor: s.civ?.color ?? "var(--line)" }}
      >
        <h1 className="page-title cap">{s.name}</h1>
        <p className="page-sub">
          {s.civ && (
            <Link
              className="chip"
              href={civHref(s.civ.key)}
              style={{ borderColor: s.civ.color }}
            >
              <span className="dot" style={{ background: s.civ.color }} />
              {s.civ.name}
            </Link>
          )}{" "}
          founded {formatYear(s.founded)} · {s.coords}
          {s.river ? " · on a river" : ""} · {s.biome}
        </p>
      </header>

      <section className="stats" aria-label="At a glance">
        <div className="stat-card">
          <span className="k">Population</span>
          <span className="v">{formatNumber(s.pop)}</span>
        </div>
        <div className="stat-card">
          <span className="k">Founded</span>
          <span className="v">{formatYear(s.founded)}</span>
          <span className="sub">{formatNumber(s.year - s.founded)} years ago</span>
        </div>
        <div className="stat-card">
          <span className="k">Housing</span>
          <span className="v">{formatNumber(s.housing)}</span>
        </div>
        <div className="stat-card">
          <span className="k">Unrest</span>
          <span className="v">{s.unrest}</span>
        </div>
      </section>

      <section className="panel">
        <h2 className="section-h">Population over time</h2>
        {s.census.length > 1 ? (
          <Sparkline data={s.census} />
        ) : (
          <p className="muted">
            Not enough of a record yet — a settlement's history is charted from
            snapshots as the world advances.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="section-h">What happened here</h2>
        {s.events.length === 0 ? (
          <p className="empty">Nothing of record has happened on this ground.</p>
        ) : (
          <div className="feed-list">
            {s.events.map((e) => (
              <EventRow key={e.id} item={e} showPlace={false} />
            ))}
          </div>
        )}
      </section>
    </OverlayPanel>
  );
}
