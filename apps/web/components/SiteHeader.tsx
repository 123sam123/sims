/**
 * The masthead + primary navigation, shared by every page. Spectator-only: the
 * links move you between views of the world; nothing here can change it.
 */

import Link from "next/link";
import { formatYear } from "@/lib/format";

const NAV = [
  { href: "/", label: "Feed", key: "feed" },
  { href: "/chronicle", label: "Chronicle", key: "chronicle" },
  { href: "/map", label: "Map", key: "map" },
] as const;

export default function SiteHeader({
  year,
  active,
}: {
  year?: number;
  active?: string;
}) {
  return (
    <header className="masthead">
      <div className="brand">
        <Link href="/" className="wordmark">
          AI Civilization Earth
        </Link>
        {year != null && <span className="year">{formatYear(year)}</span>}
      </div>
      <nav className="nav" aria-label="Primary">
        {NAV.map((n) => (
          <Link
            key={n.key}
            href={n.href}
            className="navlink"
            aria-current={active === n.key ? "page" : undefined}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
