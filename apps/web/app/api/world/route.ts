/**
 * `/api/world` — the current world as a compact JSON payload for the renderer.
 *
 * Runs on the Node runtime (it reads a `node:sqlite` store and the engine's
 * Natural-Earth data) and is always dynamic: the client polls it, and it must
 * reflect the latest snapshot the runner has written, never a cached page.
 */

import { NextResponse } from "next/server";
import { getMapPayload } from "@/lib/world-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getMapPayload();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to load world";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
