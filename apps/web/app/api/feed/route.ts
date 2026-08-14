/**
 * `/api/feed` — a page of the live event feed as JSON, for the client `Feed` to
 * poll. Newest first. `after` returns events newer than an id (polling);
 * `before` returns events older than an id (scroll-back). Read-only.
 *
 * Runs on the Node runtime (it reads the `node:sqlite` store) and is always
 * dynamic — it must reflect the latest events the runner has written.
 */

import { NextResponse } from "next/server";
import { getFeedPage } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const toInt = (v: string | null): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const before = toInt(url.searchParams.get("before"));
    const after = toInt(url.searchParams.get("after"));
    const limitRaw = toInt(url.searchParams.get("limit"));
    const limit = Math.min(100, Math.max(1, limitRaw ?? 40));
    const page = await getFeedPage({ before, after, limit });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to load feed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
