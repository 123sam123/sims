/**
 * The chronicle: the durable spine of what mattered, oldest first, grouped by
 * century. This is the world's memory read end to end — collapses, wars, first
 * meetings and paradigm discoveries, with the year-to-year hum filtered out.
 * Rendered as an overlay panel; the living map stays underneath.
 */

import EventRow from "@/components/EventRow";
import OverlayPanel from "@/components/OverlayPanel";
import { getChroniclePage } from "@/lib/data";
import type { FeedItem } from "@/lib/format";
import { formatYear } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function byCentury(entries: FeedItem[]): { label: string; items: FeedItem[] }[] {
  const groups: { label: string; items: FeedItem[] }[] = [];
  let current: { label: string; items: FeedItem[] } | null = null;
  for (const e of entries) {
    const start = Math.floor(e.year / 100) * 100;
    const label = `${formatYear(start)}–${start + 99}`;
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(e);
  }
  return groups;
}

export default async function ChroniclePage() {
  const chron = await getChroniclePage();
  const groups = byCentury(chron.entries);

  return (
    <OverlayPanel kind="Chronicle">
      <header className="page-head">
        <h1 className="page-title">The Chronicle</h1>
        <p className="page-sub">
          {chron.entries.length > 0
            ? `${chron.entries.length} events that mattered, ${formatYear(
                chron.from ?? 0,
              )} to ${formatYear(chron.to ?? chron.year)}`
            : "Nothing of weight has happened yet."}
        </p>
      </header>

      {groups.length === 0 ? (
        <p className="empty">
          The chronicle is empty. As the world advances, its turning points are
          recorded here.
        </p>
      ) : (
        groups.map((g) => (
          <section className="century" key={g.label}>
            <h2 className="century-h">{g.label}</h2>
            <div className="feed-list">
              {g.items.map((e) => (
                <EventRow key={e.id} item={e} />
              ))}
            </div>
          </section>
        ))
      )}
    </OverlayPanel>
  );
}
