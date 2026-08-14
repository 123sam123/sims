"use client";

/**
 * The live stream. Seeded server-side with the most recent events, it then
 * polls `/api/feed` for anything newer and prepends it with a brief flash, and
 * lets a spectator pull older events in on demand. Read-only: it observes the
 * world, it never touches it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import EventRow from "@/components/EventRow";
import type { FeedItem } from "@/lib/format";

const POLL_MS = 5000;
const PAGE = 40;

export default function Feed({ initial }: { initial: FeedItem[] }) {
  const [items, setItems] = useState<FeedItem[]>(initial);
  const [fresh, setFresh] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(initial.length < PAGE);

  const newestRef = useRef<number>(initial[0]?.id ?? -1);
  const oldestRef = useRef<number>(initial[initial.length - 1]?.id ?? -1);

  const sync = useCallback((next: FeedItem[]) => {
    if (next.length) {
      newestRef.current = next[0].id;
      oldestRef.current = next[next.length - 1].id;
    }
  }, []);

  /* ---- poll for newer events ---- */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/feed?after=${newestRef.current}`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const { items: incoming } = (await res.json()) as { items: FeedItem[] };
        if (!alive || !incoming.length) return;
        setItems((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const add = incoming.filter((e) => !seen.has(e.id));
          if (!add.length) return prev;
          const merged = [...add, ...prev];
          sync(merged);
          return merged;
        });
        setFresh((n) => n + incoming.length);
      } catch {
        // transient; the next tick retries
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sync]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || exhausted) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/feed?before=${oldestRef.current}&limit=${PAGE}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const { items: older } = (await res.json()) as { items: FeedItem[] };
        if (!older.length) setExhausted(true);
        else
          setItems((prev) => {
            const merged = [...prev, ...older];
            sync(merged);
            if (older.length < PAGE) setExhausted(true);
            return merged;
          });
      }
    } catch {
      // leave the button for a retry
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, exhausted, sync]);

  return (
    <section className="feed" aria-label="Live event feed">
      <div className="feed-status" aria-live="polite">
        <span className="pulse" aria-hidden />
        {fresh > 0
          ? `${fresh} new since you arrived`
          : "Live — new events appear as the world advances"}
      </div>
      <div className="feed-list">
        {items.map((e) => (
          <EventRow key={e.id} item={e} />
        ))}
      </div>
      {items.length === 0 ? (
        <p className="empty">
          The world has not begun. Once the simulation runs, its history appears here.
        </p>
      ) : exhausted ? (
        <p className="feed-end">You have reached the first recorded events.</p>
      ) : (
        <button
          type="button"
          className="more"
          onClick={loadOlder}
          disabled={loadingOlder}
        >
          {loadingOlder ? "Loading…" : "Load earlier events"}
        </button>
      )}
    </section>
  );
}
