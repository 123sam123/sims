"use client";

/**
 * The site IS this component: a full-viewport Earth you manipulate directly.
 * Press-and-drag pans (the grabbed point stays under the pointer), the wheel
 * zooms continuously about the cursor, one finger drags and two fingers pinch —
 * all through Pointer Events, one code path for mouse and touch. Every other
 * surface (feed, civilisation, settlement, event, chronicle) opens as an
 * overlay above it; this stage never unmounts while you move between them.
 *
 * It mounts in the root layout, polls `/api/world`, and redraws on animation
 * frames only. Spectator-only: every control here changes what you look at,
 * never the world itself.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Feed from "@/components/Feed";
import { onFlyTo } from "@/lib/map-bus";
import { decodePayload, type MapPayload, type WorldData } from "@/lib/payload";
import { formatYear, settlementHref } from "@/lib/format";
import {
  BIOME_NAMES,
  centerFor,
  clampView,
  type Layer,
  MIN_CELLS_ACROSS,
  ORE_COL,
  renderWorld,
  screenToCell,
  screenToWorld,
  settlementDotRadius,
  settlementsOnScreen,
  type View,
} from "@/lib/render";

const POLL_MS = 5000;
/** The last payload this browser saw, so terrain paints before the network answers. */
const PAYLOAD_CACHE_KEY = "aice:world-payload:v1";
/** Where a fly-to lands, in cells across (region scale), unless already closer. */
const FLY_ACROSS = 36;
const FLY_MS = 900;

const LAYERS: { key: Layer; label: string }[] = [
  { key: "biome", label: "Biome" },
  { key: "relief", label: "Relief" },
  { key: "temp", label: "Temp" },
  { key: "territory", label: "Territory" },
];

const LAYER_CAPTION: Record<Layer, string> = {
  biome: "Biome — land classified by climate; rivers in blue",
  relief: "Elevation — shaded from the north-west",
  temp: "Mean annual temperature — blue −40 °C to red +40 °C",
  territory: "Territory — land tinted by the civilisation that holds it",
};

const BIOME_COL_CSS = [
  "rgb(22,52,78)",
  "rgb(223,230,234)",
  "rgb(141,156,142)",
  "rgb(47,79,62)",
  "rgb(63,107,58)",
  "rgb(125,148,81)",
  "rgb(156,154,95)",
  "rgb(200,177,131)",
  "rgb(168,154,82)",
  "rgb(36,92,51)",
  "rgb(107,100,89)",
  "rgb(74,115,89)",
];

const nf = new Intl.NumberFormat("en-US");
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

interface Gesture {
  mode: "drag" | "pinch";
  /** World point pinned under the pointer (drag) or the pinch midpoint. */
  anchorWx: number;
  anchorWy: number;
  /** Pinch baseline. */
  startDist: number;
  startAcross: number;
  /** Tap detection. */
  downX: number;
  downY: number;
  downAt: number;
  moved: boolean;
}

interface Fly {
  fromX: number;
  fromY: number;
  fromAcross: number;
  toX: number;
  toY: number;
  toAcross: number;
  start: number;
}

export default function MapStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  const [data, setData] = useState<WorldData | null>(null);
  const [layer, setLayer] = useState<Layer>("biome");
  const [status, setStatus] = useState<"loading" | "cached" | "live" | "offline">("loading");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const [feedMounted, setFeedMounted] = useState(false);
  const [civsOpen, setCivsOpen] = useState(false);

  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  const dataRef = useRef<WorldData | null>(null);
  const viewRef = useRef<View>({ centerX: 180, centerY: 90, cellsAcross: 360, layer: "biome" });
  const fittedRef = useRef(false);
  const lastKeyRef = useRef("");
  const rafRef = useRef(0);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture | null>(null);
  const flyRef = useRef<Fly | null>(null);
  const pendingFlyRef = useRef<number | null>(null);

  /* ---- draw, always through one animation frame ---- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const d = dataRef.current;
    if (!canvas || !d || canvas.width === 0) return;
    renderWorld(canvas, d, viewRef.current);
  }, []);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  const canvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    return { cw: canvas?.width ?? 0, ch: canvas?.height ?? 0 };
  }, []);

  const applyView = useCallback(
    (next: View) => {
      const d = dataRef.current;
      const { cw, ch } = canvasSize();
      if (!d || !cw) {
        viewRef.current = next;
        return;
      }
      viewRef.current = clampView(d, next, cw, ch);
      requestDraw();
    },
    [canvasSize, requestDraw],
  );

  /* ---- fly the camera (view only — the world cannot be steered) ---- */
  const cancelFly = useCallback(() => {
    flyRef.current = null;
  }, []);

  const stepFly = useCallback(() => {
    const fly = flyRef.current;
    const d = dataRef.current;
    if (!fly || !d) return;
    const t = clamp((performance.now() - fly.start) / FLY_MS, 0, 1);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // ease in-out cubic
    applyView({
      ...viewRef.current,
      centerX: fly.fromX + (fly.toX - fly.fromX) * e,
      centerY: fly.fromY + (fly.toY - fly.fromY) * e,
      cellsAcross: Math.exp(
        Math.log(fly.fromAcross) + (Math.log(fly.toAcross) - Math.log(fly.fromAcross)) * e,
      ),
    });
    if (t >= 1) flyRef.current = null;
    else requestAnimationFrame(stepFly);
  }, [applyView]);

  const flyTo = useCallback(
    (cell: number) => {
      const d = dataRef.current;
      const { cw, ch } = canvasSize();
      if (!d || !cw) {
        pendingFlyRef.current = cell;
        return;
      }
      const v = viewRef.current;
      const wx = (cell % d.w) + 0.5;
      const wy = Math.floor(cell / d.w) + 0.5;
      const toAcross = Math.min(v.cellsAcross, FLY_ACROSS);
      // On a wide screen an open panel covers the right edge — aim the
      // destination at the centre of the map that stays visible.
      const panelW = pathnameRef.current !== "/" && cw > 720 ? Math.min(520, cw * 0.45) : 0;
      const anchorSx = (cw - panelW) / 2;
      // approach along the short way around the seam
      let dx = wx - v.centerX;
      dx = ((dx % d.w) + d.w * 1.5) % d.w - d.w / 2;
      const target = centerFor(
        d,
        { ...v, cellsAcross: toAcross },
        cw,
        ch,
        anchorSx,
        ch / 2,
        v.centerX + dx,
        wy,
      );
      const clamped = clampView(
        d,
        { ...v, centerX: target.centerX, centerY: target.centerY, cellsAcross: toAcross },
        cw,
        ch,
      );
      // keep the unwrapped x so the animation interpolates the short way
      const toX = target.centerX;
      flyRef.current = {
        fromX: v.centerX,
        fromY: v.centerY,
        fromAcross: v.cellsAcross,
        toX,
        toY: clamped.centerY,
        toAcross: clamped.cellsAcross,
        start: performance.now(),
      };
      requestAnimationFrame(stepFly);
    },
    [canvasSize, stepFly],
  );

  useEffect(() => onFlyTo(flyTo), [flyTo]);

  /* ---- size the canvas to the viewport ---- */
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const resize = () => {
      const w = Math.max(1, Math.round(stage.clientWidth));
      const h = Math.max(1, Math.round(stage.clientHeight));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const d = dataRef.current;
      if (d) {
        if (!fittedRef.current) {
          // land on Earth edge to edge: fit the planet's height to the frame
          fittedRef.current = true;
          viewRef.current = clampView(
            d,
            { ...viewRef.current, cellsAcross: Math.min(d.w, (d.h * w) / h) },
            w,
            h,
          );
        } else {
          viewRef.current = clampView(d, viewRef.current, w, h);
        }
      }
      requestDraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    resize();
    return () => ro.disconnect();
  }, [requestDraw]);

  /* ---- world data: cached warm start, then fetch + poll ---- */
  useEffect(() => {
    let alive = true;

    const adopt = (payload: MapPayload, live: boolean) => {
      const key = `${payload.year}:${payload.settlements.length}:${payload.civs.reduce(
        (a, c) => a + c.population,
        0,
      )}`;
      const isNew = key !== lastKeyRef.current;
      const wasLive = lastKeyRef.current !== "" && live;
      if (isNew) {
        lastKeyRef.current = key;
        const decoded = decodePayload(payload);
        dataRef.current = decoded;
        setData(decoded);
        const canvas = canvasRef.current;
        if (canvas && canvas.width > 0 && !fittedRef.current) {
          fittedRef.current = true;
          viewRef.current = clampView(
            decoded,
            {
              ...viewRef.current,
              cellsAcross: Math.min(decoded.w, (decoded.h * canvas.width) / canvas.height),
            },
            canvas.width,
            canvas.height,
          );
        }
        requestDraw();
        if (pendingFlyRef.current != null) {
          const cell = pendingFlyRef.current;
          pendingFlyRef.current = null;
          flyTo(cell);
        }
        if (wasLive) {
          setFlash(true);
          setTimeout(() => alive && setFlash(false), 1200);
        }
      }
      if (live) {
        setStatus("live");
        setError(null);
      }
    };

    // warm start: paint the last world this browser saw while the fetch runs
    try {
      const raw = localStorage.getItem(PAYLOAD_CACHE_KEY);
      if (raw) {
        adopt(JSON.parse(raw) as MapPayload, false);
        setStatus("cached");
      }
    } catch {
      // no cache, or an unreadable one — the fetch below covers it
    }

    const load = async () => {
      try {
        const res = await fetch("/api/world", { cache: "no-store" });
        if (!res.ok) throw new Error(`server ${res.status}`);
        const text = await res.text();
        if (!alive) return;
        const payload = JSON.parse(text) as MapPayload;
        adopt(payload, true);
        try {
          localStorage.setItem(PAYLOAD_CACHE_KEY, text);
        } catch {
          // storage full or unavailable — purely an optimisation
        }
      } catch (e) {
        if (alive) {
          setStatus((s) => (s === "live" || s === "cached" ? s : "offline"));
          setError(e instanceof Error ? e.message : "load failed");
        }
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [requestDraw, flyTo]);

  /* ---- hover readout (HTML overlay, no canvas redraw) ---- */
  const updateReadout = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const d = dataRef.current;
    const el = readoutRef.current;
    if (!canvas || !d || !el) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * canvas.width;
    const sy = ((clientY - rect.top) / rect.height) * canvas.height;
    const cell = screenToCell(d, viewRef.current, canvas.width, canvas.height, sx, sy);
    if (cell == null) {
      el.innerHTML = "&nbsp;";
      return;
    }
    const x = cell % d.w;
    const y = Math.floor(cell / d.w);
    const lat = Math.round(90 - y - 0.5);
    const lon = Math.round(x - 180 + 0.5);
    const bi = d.biome[cell];
    const t = ((d.temp[cell] / 255) * 80 - 40).toFixed(1);
    const river = d.river[cell] > 40;
    const dep = d.deposits.find((dd) => dd.c === cell);
    const owner = d.owner[cell];
    const civ = owner > 0 ? d.civById.get(owner - 1) : undefined;
    const settle = d.settlements.find((s) => s.cell === cell);
    let html = `<b>${lat}°, ${lon}°</b> <span class="dim">·</span> ${BIOME_NAMES[bi]} <span class="dim">·</span> ${t} °C`;
    if (river) html += ` <span class="dim">·</span> river`;
    if (civ) html += ` <span class="dim">·</span> <b style="color:${civ.color}">${civ.name}</b>`;
    if (settle) html += ` <span class="dim">·</span> ${settle.name} (${nf.format(settle.pop)})`;
    if (dep) html += ` <span class="dim">·</span> ${dep.n} (${dep.k})`;
    el.innerHTML = html;
  }, []);

  /* ---- pointers: one path for mouse and touch ---- */
  const canvasPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { sx: 0, sy: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      sx: ((e.clientX - rect.left) / rect.width) * canvas.width,
      sy: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }, []);

  const beginDrag = useCallback((sx: number, sy: number, downAt: number) => {
    const d = dataRef.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const { wx, wy } = screenToWorld(d, viewRef.current, canvas.width, canvas.height, sx, sy);
    const prev = gestureRef.current;
    gestureRef.current = {
      mode: "drag",
      anchorWx: wx,
      anchorWy: wy,
      startDist: 0,
      startAcross: viewRef.current.cellsAcross,
      downX: sx,
      downY: sy,
      downAt,
      moved: prev?.moved ?? false,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const d = dataRef.current;
      if (!canvas || !d) return;
      cancelFly();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // a pointer that vanished between down and capture still drags fine
      }
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointersRef.current.values()];
      if (pts.length === 1) {
        const { sx, sy } = canvasPoint(e);
        beginDrag(sx, sy, performance.now());
        if (gestureRef.current) gestureRef.current.moved = false;
      } else if (pts.length === 2) {
        const p0 = canvasPoint({ clientX: pts[0].x, clientY: pts[0].y });
        const p1 = canvasPoint({ clientX: pts[1].x, clientY: pts[1].y });
        const mid = { sx: (p0.sx + p1.sx) / 2, sy: (p0.sy + p1.sy) / 2 };
        const { wx, wy } = screenToWorld(
          d,
          viewRef.current,
          canvas.width,
          canvas.height,
          mid.sx,
          mid.sy,
        );
        gestureRef.current = {
          mode: "pinch",
          anchorWx: wx,
          anchorWy: wy,
          startDist: Math.hypot(p1.sx - p0.sx, p1.sy - p0.sy) || 1,
          startAcross: viewRef.current.cellsAcross,
          downX: mid.sx,
          downY: mid.sy,
          downAt: performance.now(),
          moved: true,
        };
      }
    },
    [beginDrag, canvasPoint, cancelFly],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const d = dataRef.current;
      if (!canvas || !d) return;
      if (!pointersRef.current.has(e.pointerId)) {
        // plain hover
        updateReadout(e.clientX, e.clientY);
        return;
      }
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gestureRef.current;
      if (!g) return;
      const cw = canvas.width;
      const ch = canvas.height;

      if (g.mode === "drag" && pointersRef.current.size === 1) {
        const { sx, sy } = canvasPoint(e);
        if (!g.moved && Math.hypot(sx - g.downX, sy - g.downY) > 5) g.moved = true;
        const c = centerFor(d, viewRef.current, cw, ch, sx, sy, g.anchorWx, g.anchorWy);
        applyView({ ...viewRef.current, centerX: c.centerX, centerY: c.centerY });
        updateReadout(e.clientX, e.clientY);
      } else if (g.mode === "pinch" && pointersRef.current.size >= 2) {
        const pts = [...pointersRef.current.values()];
        const p0 = canvasPoint({ clientX: pts[0].x, clientY: pts[0].y });
        const p1 = canvasPoint({ clientX: pts[1].x, clientY: pts[1].y });
        const dist = Math.hypot(p1.sx - p0.sx, p1.sy - p0.sy) || 1;
        const mid = { sx: (p0.sx + p1.sx) / 2, sy: (p0.sy + p1.sy) / 2 };
        const across = clamp(g.startAcross * (g.startDist / dist), MIN_CELLS_ACROSS, d.w);
        const c = centerFor(
          d,
          { ...viewRef.current, cellsAcross: across },
          cw,
          ch,
          mid.sx,
          mid.sy,
          g.anchorWx,
          g.anchorWy,
        );
        applyView({
          ...viewRef.current,
          cellsAcross: across,
          centerX: c.centerX,
          centerY: c.centerY,
        });
      }
    },
    [applyView, canvasPoint, updateReadout],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      pointersRef.current.delete(e.pointerId);
      try {
        canvas?.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      const g = gestureRef.current;
      const remaining = [...pointersRef.current.entries()];

      if (remaining.length === 1) {
        // pinch decayed to a single finger: continue as a drag from here
        const [, p] = remaining[0];
        const { sx, sy } = canvasPoint({ clientX: p.x, clientY: p.y });
        beginDrag(sx, sy, g?.downAt ?? performance.now());
        if (gestureRef.current) gestureRef.current.moved = true;
        return;
      }
      if (remaining.length > 0) return;

      // a still, quick press is a tap — open the settlement under it, if any
      if (
        g &&
        g.mode === "drag" &&
        !g.moved &&
        performance.now() - g.downAt < 500 &&
        canvas &&
        dataRef.current
      ) {
        const d = dataRef.current;
        const { sx, sy } = canvasPoint(e);
        let best: { id: number; dist: number } | null = null;
        for (const { s, x, y, cellPx } of settlementsOnScreen(d, viewRef.current, canvas.width, canvas.height)) {
          const dist = Math.hypot(x - sx, y - sy);
          // dots when far out, whole drawn towns when close in
          const reach = Math.max(12, settlementDotRadius(s, canvas.width) + 4, cellPx * 0.6);
          if (dist <= reach && (!best || dist < best.dist)) best = { id: s.id, dist };
        }
        if (best) router.push(settlementHref(best.id));
      }
      gestureRef.current = null;
    },
    [beginDrag, canvasPoint, router],
  );

  const onPointerLeave = useCallback(() => {
    if (readoutRef.current) readoutRef.current.innerHTML = "&nbsp;";
  }, []);

  /* ---- wheel: continuous zoom about the cursor. Registered manually so the
   * listener is non-passive — preventDefault must actually stop page scroll. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = dataRef.current;
      if (!d || canvas.width === 0) return;
      cancelFly();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 120;
      // trackpad pinches arrive as ctrl+wheel with small deltas
      const k = e.ctrlKey ? 0.008 : 0.0022;
      const factor = Math.exp(clamp(dy, -400, 400) * k);
      const { sx, sy } = canvasPoint(e);
      const v = viewRef.current;
      const { wx, wy } = screenToWorld(d, v, canvas.width, canvas.height, sx, sy);
      const across = clamp(v.cellsAcross * factor, MIN_CELLS_ACROSS, d.w);
      const c = centerFor(
        d,
        { ...v, cellsAcross: across },
        canvas.width,
        canvas.height,
        sx,
        sy,
        wx,
        wy,
      );
      applyView({ ...v, cellsAcross: across, centerX: c.centerX, centerY: c.centerY });
      updateReadout(e.clientX, e.clientY);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [applyView, canvasPoint, cancelFly, updateReadout]);

  /* ---- zoom buttons: the discrete shortcut sets the same continuous scalar ---- */
  const zoomBy = useCallback(
    (factor: number) => {
      const d = dataRef.current;
      const canvas = canvasRef.current;
      if (!d || !canvas) return;
      cancelFly();
      const v = viewRef.current;
      applyView({
        ...v,
        cellsAcross: clamp(v.cellsAcross * factor, MIN_CELLS_ACROSS, d.w),
      });
    },
    [applyView, cancelFly],
  );

  /* ---- Escape closes the topmost surface ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pathnameRef.current !== "/") router.push("/");
      else setFeedOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const setLayerBoth = (l: Layer) => {
    setLayer(l);
    viewRef.current = { ...viewRef.current, layer: l };
    requestDraw();
  };

  const statusText =
    status === "offline"
      ? `offline${error ? ` · ${error}` : ""}`
      : data
        ? `${status === "cached" ? "cached" : flash ? "updated" : "live"} · ${formatYear(data.year)}`
        : "loading…";

  return (
    <div className="stage" ref={stageRef}>
      <canvas
        className="stage-canvas"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        aria-label="Earth, rendered live from the simulation. Drag to pan, scroll or pinch to zoom."
      />

      <header className="hud hud-top">
        <div className="hud-brand">
          <Link href="/" className="wordmark">
            AI Civilization Earth
          </Link>
          <span className={`live-pill${status === "offline" ? " off" : ""}`}>{statusText}</span>
        </div>
        <nav className="hud-nav" aria-label="Primary">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={civsOpen}
            onClick={() => setCivsOpen((v) => !v)}
          >
            Civilisations
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={feedOpen}
            onClick={() => {
              setFeedMounted(true);
              setFeedOpen((v) => !v);
            }}
          >
            Feed
          </button>
          <Link href="/chronicle" className="hud-btn">
            Chronicle
          </Link>
        </nav>
      </header>

      <div className="hud hud-controls">
        <div className="seg" role="group" aria-label="Map layer">
          {LAYERS.map((l) => (
            <button
              key={l.key}
              type="button"
              aria-pressed={layer === l.key}
              onClick={() => setLayerBoth(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="seg zoom-seg" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1 / 1.6)}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1.6)}>
            −
          </button>
        </div>
        <details className="key">
          <summary>Key</summary>
          <div className="key-body">
            <p className="key-caption">{LAYER_CAPTION[layer]}</p>
            <Legend layer={layer} data={data} />
          </div>
        </details>
      </div>

      {civsOpen && data && (
        <aside className="hud civs-panel" aria-label="Civilisations">
          {[...data.civs]
            .sort((a, b) => b.population - a.population)
            .map((c) => (
              <Link
                key={c.id}
                href={`/civ/${encodeURIComponent(c.key)}`}
                className="civ-card"
                style={{ borderLeftColor: c.color }}
              >
                <span className="civ-card-name">
                  <span className="dot" style={{ background: c.color }} />
                  {c.name}
                </span>
                <span className="civ-card-stat">
                  {nf.format(c.population)} people · {c.settlements} settlements
                </span>
                <span className="civ-card-stat">{c.capabilities.length} capabilities</span>
              </Link>
            ))}
        </aside>
      )}

      {feedMounted && (
        <aside className={`drawer${feedOpen ? " open" : ""}`} aria-label="Live event feed" aria-hidden={!feedOpen}>
          <div className="drawer-bar">
            <span className="drawer-title">The feed</span>
            <button
              type="button"
              className="drawer-close"
              aria-label="Close feed"
              onClick={() => setFeedOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="drawer-body">
            <Feed initial={[]} />
          </div>
        </aside>
      )}

      <div className="readout" ref={readoutRef} aria-live="off">
        &nbsp;
      </div>
      <p className="stage-hint">drag to pan · scroll or pinch to zoom · tap a settlement to visit it</p>
    </div>
  );
}

function Legend({ layer, data }: { layer: Layer; data: WorldData | null }) {
  if (layer === "biome") {
    return (
      <div className="legend">
        {BIOME_NAMES.map((n, i) =>
          i === 0 ? null : (
            <div key={n}>
              <span className="sw" style={{ background: BIOME_COL_CSS[i] }} />
              {n}
            </div>
          ),
        )}
      </div>
    );
  }
  if (layer === "territory" && data) {
    return (
      <div className="legend">
        {data.civs.map((c) => (
          <div key={c.id}>
            <span className="sw" style={{ background: c.color }} />
            {c.name}
          </div>
        ))}
        <div>
          <span className="sw" style={{ background: "rgb(120,120,120)" }} />
          unclaimed
        </div>
      </div>
    );
  }
  if (layer === "relief") {
    return (
      <div className="legend">
        <div>
          <span
            className="sw"
            style={{ background: "linear-gradient(90deg, #4a4a45, #e6e0d0)" }}
          />
          low → high elevation
        </div>
      </div>
    );
  }
  // temperature
  return (
    <div className="legend">
      <div>
        <span className="sw" style={{ background: "linear-gradient(90deg, #1c3c82, #b2c8e6)" }} />
        cold
      </div>
      <div>
        <span className="sw" style={{ background: "linear-gradient(90deg, #b2c8e6, #e64628)" }} />
        warm
      </div>
      {data && data.deposits.length > 0 && (
        <div>
          <span className="sw" style={{ background: ORE_COL.gold }} />
          orefields visible when zoomed in
        </div>
      )}
    </div>
  );
}
