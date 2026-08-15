/**
 * The sheet every deep-link route renders into: a scrollable panel OVER the
 * map, never a page you navigate away to. The map stays mounted (and visible)
 * underneath; closing is just a link back to `/`. Server-renderable, so cold
 * deep links paint their content without waiting for any client JS.
 */

import Link from "next/link";

export default function OverlayPanel({
  kind,
  children,
}: {
  /** What this sheet is — "Civilisation", "Settlement", "Event", "Chronicle". */
  kind: string;
  children: React.ReactNode;
}) {
  return (
    <aside className="sheet" role="dialog" aria-label={kind}>
      <div className="sheet-bar">
        <span className="sheet-kind">{kind}</span>
        <Link href="/" className="sheet-close" aria-label="Close and return to the map">
          × map
        </Link>
      </div>
      <div className="sheet-body">{children}</div>
    </aside>
  );
}
