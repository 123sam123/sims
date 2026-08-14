/**
 * One event, rendered as a row. Deliberately isomorphic — it imports only the
 * isomorphic `format` helpers and `next/link`, so it compiles as either a server
 * or a client component and can be used both inside server pages and inside the
 * client `Feed`.
 *
 * The row is not a single link: the headline and year link to the event, while
 * the civilisation and settlement chips link to their own pages, so a spectator
 * can fall into any of them without nested anchors.
 */

import Link from "next/link";
import {
  civHref,
  eventHref,
  type FeedItem,
  formatYear,
  kindLabel,
  kindTone,
  settlementHref,
  weightBand,
} from "@/lib/format";

export default function EventRow({
  item,
  showCiv = true,
  showPlace = true,
}: {
  item: FeedItem;
  showCiv?: boolean;
  showPlace?: boolean;
}) {
  const civChip = showCiv && item.civName && item.civKey;
  const placeChip = showPlace && item.settlementId != null && item.settlementName;
  return (
    <article className={`ev tone-${kindTone(item.kind)} band-${weightBand(item.weight)}`}>
      <div className="ev-meta">
        <span className="ev-kind">{kindLabel(item.kind)}</span>
        <Link className="ev-year" href={eventHref(item.id)}>
          {formatYear(item.year)}
        </Link>
      </div>
      <div className="ev-body">
        <Link className="ev-text" href={eventHref(item.id)}>
          {item.text}
        </Link>
        {(civChip || placeChip) && (
          <div className="ev-tags">
            {civChip && (
              <Link
                className="chip"
                href={civHref(item.civKey as string)}
                style={{ borderColor: item.civColor ?? undefined }}
              >
                <span
                  className="dot"
                  style={{ background: item.civColor ?? "currentColor" }}
                />
                {item.civName}
              </Link>
            )}
            {placeChip && (
              <Link
                className="chip ghost"
                href={settlementHref(item.settlementId as number)}
              >
                {item.settlementName}
              </Link>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
