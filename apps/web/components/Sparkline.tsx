/**
 * A population-over-time sparkline for the settlement page. Pure SVG rendered
 * from the census, no client JS — it scales to its container via `viewBox`.
 * Read-only, like everything on the spectator surface.
 */

import { formatNumber, formatYear } from "@/lib/format";

const W = 640;
const H = 160;
const PAD = 6;

export default function Sparkline({
  data,
}: {
  data: { year: number; pop: number }[];
}) {
  if (data.length === 0) return null;

  const years = data.map((d) => d.year);
  const pops = data.map((d) => d.pop);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const maxPop = Math.max(...pops, 1);
  const spanYear = Math.max(1, maxYear - minYear);

  const x = (year: number) => PAD + ((year - minYear) / spanYear) * (W - 2 * PAD);
  const y = (pop: number) => H - PAD - (pop / maxPop) * (H - 2 * PAD);

  const pts = data.map((d) => `${x(d.year).toFixed(1)},${y(d.pop).toFixed(1)}`);
  const line = pts.join(" ");
  const area = `${x(minYear).toFixed(1)},${H - PAD} ${line} ${x(maxYear).toFixed(1)},${H - PAD}`;
  const last = data[data.length - 1];
  const peak = data.reduce((a, b) => (b.pop > a.pop ? b : a));

  return (
    <figure className="spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Population from ${formatYear(minYear)} to ${formatYear(maxYear)}, peaking at ${formatNumber(peak.pop)}`}
      >
        {data.length > 1 && <polygon className="spark-area" points={area} />}
        {data.length > 1 ? (
          <polyline className="spark-line" points={line} />
        ) : null}
        <circle className="spark-dot" cx={x(last.year)} cy={y(last.pop)} r={4} />
      </svg>
      <figcaption className="spark-cap">
        <span>{formatYear(minYear)}</span>
        <span>
          peak {formatNumber(peak.pop)} · {formatYear(peak.year)}
        </span>
        <span>{formatYear(maxYear)}</span>
      </figcaption>
    </figure>
  );
}
