/**
 * An event page: the headline in full, and the causes behind it. Every cause is
 * itself a link, so a spectator can walk backwards — a famine to the failed
 * harvest, and on to whatever lay behind that — for as far as the record goes.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import EventRow from "@/components/EventRow";
import MapFocus from "@/components/MapFocus";
import OverlayPanel from "@/components/OverlayPanel";
import { getEventPage } from "@/lib/data";
import {
  civHref,
  formatYear,
  kindTone,
  settlementHref,
  weightBand,
} from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const n = Number(id);
  const ev = Number.isFinite(n) ? await getEventPage(n) : null;
  if (!ev) notFound();

  const { item, causes, ancestry } = ev;
  const immediate = new Set(causes.map((c) => c.id));
  const deeper = ancestry.filter((a) => !immediate.has(a.id));

  return (
    <OverlayPanel kind="Event">
      <MapFocus cell={item.cell} />
      <header
        className={`event-head tone-${kindTone(item.kind)} band-${weightBand(
          item.weight,
        )}`}
      >
        <div className="event-meta">
          <span className="ev-kind">{ev.kindLabel}</span>
          <span className="event-year">{formatYear(item.year)}</span>
        </div>
        <h1 className="event-text">{item.text}</h1>
        <div className="ev-tags">
          {item.civName && item.civKey && (
            <Link
              className="chip"
              href={civHref(item.civKey)}
              style={{ borderColor: item.civColor ?? undefined }}
            >
              <span className="dot" style={{ background: item.civColor ?? "currentColor" }} />
              {item.civName}
            </Link>
          )}
          {item.settlementId != null && item.settlementName && (
            <Link className="chip ghost" href={settlementHref(item.settlementId)}>
              {item.settlementName}
            </Link>
          )}
        </div>
      </header>

      <section className="panel">
        <h2 className="section-h">Why this happened</h2>
        {causes.length === 0 ? (
          <p className="empty">
            No recorded cause. This is a first cause in the world's memory — its
            antecedents were never written, or there were none.
          </p>
        ) : (
          <>
            <p className="muted">
              Directly caused by the following. Follow any of them to keep walking
              backwards.
            </p>
            <div className="feed-list">
              {causes.map((e) => (
                <EventRow key={e.id} item={e} />
              ))}
            </div>
          </>
        )}

        {deeper.length > 0 && (
          <>
            <h3 className="sub-h">Further back</h3>
            <div className="feed-list">
              {deeper.map((e) => (
                <EventRow key={e.id} item={e} />
              ))}
            </div>
          </>
        )}
      </section>

      <p className="foot">
        <Link href="/" className="backlink">
          ← Back to the map
        </Link>
      </p>
    </OverlayPanel>
  );
}
