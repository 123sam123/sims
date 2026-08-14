"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodePayload, type MapPayload, type WorldData } from "@/lib/payload";
import {
  BIOME_NAMES,
  type Layer,
  ORE_COL,
  renderWorld,
  screenToCell,
  type View,
  ZOOM,
} from "@/lib/render";

const POLL_MS = 5000;
const LAYERS: { key: Layer; label: string }[] = [
  { key: "biome", label: "Biome" },
  { key: "relief", label: "Relief" },
  { key: "temp", label: "Temperature" },
  { key: "territory", label: "Territory" },
];
const ZOOMS: { key: keyof typeof ZOOM; label: string }[] = [
  { key: "planet", label: "Planet" },
  { key: "region", label: "Region" },
  { key: "locality", label: "Locality" },
];

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

const LAYER_CAPTION: Record<Layer, string> = {
  biome: "Biome — land classified by climate; rivers in blue",
  relief: "Elevation — shaded from the north-west",
  temp: "Mean annual temperature — blue −40 °C to red +40 °C",
  territory: "Territory — land tinted by the civilisation that holds it",
};

export default function WorldMap() {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  const [data, setData] = useState<WorldData | null>(null);
  const [view, setView] = useState<View>({
    centerX: 180,
    centerY: 90,
    cellsAcross: ZOOM.planet,
    layer: "biome",
  });
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const dataRef = useRef<WorldData | null>(null);
  const viewRef = useRef(view);
  const lastKeyRef = useRef<string>("");
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /* ---- draw ---- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const d = dataRef.current;
    if (!canvas || !d) return;
    renderWorld(canvas, d, viewRef.current);
  }, []);

  /* ---- size the canvas to its container, 2:1, and redraw ---- */
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    let raf = 0;
    const resize = () => {
      const w = Math.max(240, Math.min(1400, Math.round(frame.clientWidth)));
      const h = Math.round(w / 2);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(frame);
    resize();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [draw]);

  /* ---- redraw when data or view changes ---- */
  useEffect(() => {
    const raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [draw, data, view]);

  /* ---- fetch + poll ---- */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/world", { cache: "no-store" });
        if (!res.ok) throw new Error(`server ${res.status}`);
        const payload = (await res.json()) as MapPayload;
        if (!alive) return;
        const key = `${payload.year}:${payload.settlements.length}:${payload.civs.reduce(
          (a, c) => a + c.population,
          0,
        )}`;
        if (key === lastKeyRef.current) return;
        const wasLoaded = lastKeyRef.current !== "";
        lastKeyRef.current = key;
        setData(decodePayload(payload));
        setError(null);
        if (wasLoaded) {
          setFlash(true);
          setTimeout(() => alive && setFlash(false), 1200);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "load failed");
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  /* ---- hover readout (HTML overlay, no canvas redraw) ---- */
  const onMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const d = dataRef.current;
    const el = readoutRef.current;
    if (!canvas || !d || !el) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const sy = ((e.clientY - rect.top) / rect.height) * canvas.height;
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

  const onLeave = useCallback(() => {
    if (readoutRef.current) readoutRef.current.innerHTML = "&nbsp;";
  }, []);

  /* ---- click to recentre ---- */
  const onClick = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const d = dataRef.current;
    if (!canvas || !d) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const sy = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const cell = screenToCell(d, viewRef.current, canvas.width, canvas.height, sx, sy);
    if (cell == null) return;
    const cx = cell % d.w;
    const cy = Math.floor(cell / d.w);
    setView((v) => ({
      ...v,
      centerX: cx,
      centerY: cy,
      // clicking on the whole planet dives one level in
      cellsAcross: v.cellsAcross >= d.w ? ZOOM.region : v.cellsAcross,
    }));
  }, []);

  /* ---- wheel to zoom around the cursor ---- */
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const d = dataRef.current;
    if (!canvas || !d) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const sy = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const target = screenToCell(d, viewRef.current, canvas.width, canvas.height, sx, sy);
    setView((v) => {
      const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3;
      const across = Math.max(8, Math.min(d.w, Math.round(v.cellsAcross * factor)));
      if (target == null || across >= d.w) {
        return { ...v, cellsAcross: across, centerX: 180, centerY: 90 };
      }
      const tx = target % d.w;
      const ty = Math.floor(target / d.w);
      // ease the centre toward the cursor as we zoom in
      const blend = e.deltaY > 0 ? 0.15 : 0.4;
      return {
        ...v,
        cellsAcross: across,
        centerX: v.centerX + (tx - v.centerX) * blend,
        centerY: v.centerY + (ty - v.centerY) * blend,
      };
    });
  }, []);

  const setZoom = (key: keyof typeof ZOOM) => {
    setView((v) => {
      const d = dataRef.current;
      let cx = v.centerX;
      let cy = v.centerY;
      // if we're leaving the planet view, land on the biggest settlement
      if (v.cellsAcross >= (d?.w ?? 360) && key !== "planet" && d && d.settlements.length) {
        const big = d.settlements.reduce((a, b) => (b.pop > a.pop ? b : a));
        cx = big.cell % d.w;
        cy = Math.floor(big.cell / d.w);
      }
      if (key === "planet") {
        cx = 180;
        cy = 90;
      }
      return { ...v, cellsAcross: ZOOM[key], centerX: cx, centerY: cy };
    });
  };

  const zoomLabel =
    view.cellsAcross >= (data?.w ?? 360)
      ? "planet"
      : view.cellsAcross <= ZOOM.locality
        ? "locality"
        : view.cellsAcross <= ZOOM.region * 1.2
          ? "region"
          : "custom";

  return (
    <>
      <div className="toolbar">
        <div className="group">
          <span className="glabel">Layer</span>
          <div className="seg" role="group" aria-label="Map layer">
            {LAYERS.map((l) => (
              <button
                key={l.key}
                type="button"
                aria-pressed={view.layer === l.key}
                onClick={() => setView((v) => ({ ...v, layer: l.key }))}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          <span className="glabel">Zoom</span>
          <div className="seg" role="group" aria-label="Zoom level">
            {ZOOMS.map((z) => (
              <button
                key={z.key}
                type="button"
                aria-pressed={zoomLabel === z.key}
                onClick={() => setZoom(z.key)}
              >
                {z.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mapframe" ref={frameRef}>
        <canvas
          className="map"
          ref={canvasRef}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          onClick={onClick}
          onWheel={onWheel}
          aria-label="World map rendered from the live simulation"
        />
        <div className="status">
          {error ? `offline · ${error}` : data ? `${flash ? "updated · " : "live · "}year ${nf.format(data.year)}` : "loading…"}
        </div>
        <div className="readout" ref={readoutRef} aria-live="off">
          &nbsp;
        </div>
      </div>

      <p className="hint">{LAYER_CAPTION[view.layer]} · click to recentre · scroll to zoom</p>

      <Legend layer={view.layer} data={data} />

      {data && (
        <div className="civs">
          {[...data.civs]
            .sort((a, b) => b.population - a.population)
            .map((c) => (
              <div className="civ" key={c.id} style={{ borderLeftColor: c.color }}>
                <div className="name">
                  <span
                    className="sw"
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: 3,
                      background: c.color,
                      display: "inline-block",
                    }}
                  />
                  {c.name}
                </div>
                <div className="stat">
                  {nf.format(c.population)} people · {c.settlements} settlements
                </div>
                <div className="stat">{c.capabilities.length} capabilities</div>
              </div>
            ))}
        </div>
      )}
    </>
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
