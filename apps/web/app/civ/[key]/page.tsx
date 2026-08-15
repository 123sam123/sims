/**
 * A civilisation page: who they are, how many, how far they reach, what they can
 * and cannot make, who they have met, and their chronicle. Ground truth read
 * from the world and the event log — never a name or fact the world did not
 * itself produce.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import EventRow from "@/components/EventRow";
import MapFocus from "@/components/MapFocus";
import OverlayPanel from "@/components/OverlayPanel";
import { getCivPage } from "@/lib/data";
import { formatNumber, formatYear, settlementHref } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CivPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const civ = await getCivPage(key);
  if (!civ) notFound();

  return (
    <OverlayPanel kind="Civilisation">
      <MapFocus cell={civ.focusCell} />
      <header className="page-head" style={{ borderTopColor: civ.color }}>
        <h1 className="page-title">
          <span className="dot lg" style={{ background: civ.color }} />
          {civ.name}
        </h1>
        <p className="page-sub">
          {civ.alive
            ? `${formatNumber(civ.population)} people across ${formatNumber(
                civ.settlementCount,
              )} settlements`
            : `Fell in ${formatYear(civ.extinctYear ?? civ.year)}`}
        </p>
        <p className="doctrine">{civ.doctrine}</p>
      </header>

      <section className="stats" aria-label="At a glance">
        <div className="stat-card">
          <span className="k">Population</span>
          <span className="v">{formatNumber(civ.population)}</span>
        </div>
        <div className="stat-card">
          <span className="k">Settlements</span>
          <span className="v">{formatNumber(civ.settlementCount)}</span>
        </div>
        <div className="stat-card">
          <span className="k">Territory</span>
          <span className="v">{formatNumber(civ.territoryKm2)} km²</span>
          <span className="sub">{formatNumber(civ.territoryCells)} cells</span>
        </div>
        <div className="stat-card">
          <span className="k">Government</span>
          <span className="v cap">{civ.government.form}</span>
          <span className="sub">
            legitimacy {civ.government.legitimacy} · central{" "}
            {civ.government.centralization}
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="section-h">Capabilities</h2>
          <span className="count">
            {civ.capsHeld} of {civ.capsTotal} known
          </span>
        </div>

        {civ.research && (
          <p className="researching">
            Currently pursuing <strong>{civ.research.target}</strong> ·{" "}
            {civ.research.progress}
          </p>
        )}

        <h3 className="sub-h">Held</h3>
        <div className="caps">
          {civ.held.map((c) => (
            <span key={c.id} className="cap-chip held" title={c.what}>
              {c.name}
            </span>
          ))}
        </div>

        {civ.reach.length > 0 && (
          <>
            <h3 className="sub-h">Within reach</h3>
            <div className="caps">
              {civ.reach.map((c) => (
                <span key={c.id} className="cap-chip reach" title={c.what}>
                  {c.name}
                </span>
              ))}
            </div>
          </>
        )}

        {civ.walls.length > 0 && (
          <>
            <h3 className="sub-h">Beyond reach — the world says no</h3>
            <ul className="walls">
              {civ.walls.map((c) => (
                <li key={c.id}>
                  <span className="cap-chip wall">{c.name}</span>
                  <span className="reason">{c.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {civ.forgotten.length > 0 && (
          <>
            <h3 className="sub-h">Forgotten</h3>
            <div className="caps">
              {civ.forgotten.map((c) => (
                <span key={c.id} className="cap-chip lost" title={c.what}>
                  {c.name}
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2 className="section-h">Relations</h2>
        {civ.relations.length === 0 ? (
          <p className="empty">Has met no other people.</p>
        ) : (
          <ul className="relations">
            {civ.relations.map((r) => (
              <li key={r.key}>
                <Link
                  className="chip"
                  href={`/civ/${encodeURIComponent(r.key)}`}
                  style={{ borderColor: r.color }}
                >
                  <span className="dot" style={{ background: r.color }} />
                  {r.name}
                </Link>
                <span className={`rel-op ${r.opinion < 0 ? "neg" : "pos"}`}>
                  opinion {r.opinion}
                </span>
                {r.atWar && <span className="rel-tag war">at war</span>}
                {r.treaty && <span className="rel-tag">{r.treaty}</span>}
                {!r.alive && <span className="rel-tag">gone</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="section-h">Settlements</h2>
        <ul className="settle-list">
          {civ.settlements.slice(0, 60).map((s) => (
            <li key={s.id}>
              <Link href={settlementHref(s.id)} className="settle-link">
                <span className="s-name">{s.name}</span>
                <span className="s-meta">
                  {formatNumber(s.pop)} · founded {formatYear(s.founded)} ·{" "}
                  {s.coords}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {civ.settlements.length > 60 && (
          <p className="muted">
            …and {formatNumber(civ.settlements.length - 60)} more.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="section-h">Chronicle</h2>
        {civ.chronicleLines.length > 0 && (
          <ul className="chron-lines">
            {civ.chronicleLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {civ.notable.length > 0 ? (
          <div className="feed-list">
            {civ.notable.map((e) => (
              <EventRow key={e.id} item={e} showCiv={false} />
            ))}
          </div>
        ) : (
          civ.chronicleLines.length === 0 && (
            <p className="empty">No events of note recorded yet.</p>
          )
        )}
      </section>
    </OverlayPanel>
  );
}
