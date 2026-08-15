/**
 * The canvas renderer, ported from the validated rendering study and driven by
 * live world data instead of a baked-in blob.
 *
 * The method is the study's: paint one pixel per grid cell into a small
 * offscreen canvas, then blit it up to the display canvas with
 * `imageSmoothingEnabled = false`. Nearest-neighbour upscaling of a 1× buffer is
 * what makes it read as pixel art rather than smeared vector shapes. Relief is a
 * north-west hillshade of the elevation field; rivers are laid over everything;
 * settlements are drawn on top after the upscale — as dots that scale with
 * population when far out, and as procedurally drawn buildings when close in.
 */

import { availableMaterials, MATERIALS } from "./materials";
import type { SettlementInfo, WorldData } from "./payload";

export type Layer = "biome" | "relief" | "temp" | "territory";

export interface View {
  /** Grid cell the view is centred on. */
  centerX: number;
  centerY: number;
  /** Width of the view in grid cells. Smaller = closer in. */
  cellsAcross: number;
  layer: Layer;
}

/** Named zoom stops, in cells across. Planet shows the whole 360-wide grid. */
export const ZOOM = { planet: 360, region: 72, locality: 16 } as const;
/** At or below this width, settlements are drawn as buildings, not dots. */
const LOCALITY_MAX = 24;
/** At or below this width, terrain gets fertility texture. */
const STIPPLE_MAX = 130;

export const BIOME_NAMES = [
  "ocean",
  "ice",
  "tundra",
  "taiga",
  "temperate forest",
  "grassland",
  "steppe",
  "desert",
  "savanna",
  "tropical forest",
  "mountain",
  "wetland",
];

// Cartographic palette. Ocean is depth-shaded; land gets relief shading.
const BIOME_COL: [number, number, number][] = [
  [22, 52, 78], // ocean
  [223, 230, 234], // ice
  [141, 156, 142], // tundra
  [47, 79, 62], // taiga
  [63, 107, 58], // temperate forest
  [125, 148, 81], // grassland
  [156, 154, 95], // steppe
  [200, 177, 131], // desert
  [168, 154, 82], // savanna
  [36, 92, 51], // tropical forest
  [107, 100, 89], // mountain
  [74, 115, 89], // wetland
];

export const ORE_COL: Record<string, string> = {
  iron: "#b9c2c9",
  copper: "#d2793f",
  tin: "#9aa6b5",
  coal: "#3c4046",
  oil: "#221c26",
  gold: "#e8c04a",
  silver: "#dfe4e8",
  uranium: "#7fd36a",
  bauxite: "#b0623a",
  silica: "#e8e3d1",
  rare_earth: "#c77fd3",
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Deterministic per-thing rng — same as the study, so buildings are stable. */
function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const civRgbCache = new Map<string, [number, number, number]>();
function civRgb(hex: string): [number, number, number] {
  let v = civRgbCache.get(hex);
  if (!v) {
    v = hexToRgb(hex);
    civRgbCache.set(hex, v);
  }
  return v;
}

export interface Window {
  x0: number;
  y0: number;
  across: number;
  down: number;
}

/** The grid window a view maps to, given the display canvas size. */
export function computeWindow(data: WorldData, view: View, cw: number, ch: number): Window {
  const W = data.w;
  const H = data.h;
  let across = Math.round(clamp(view.cellsAcross, 4, W));
  if (across >= W) {
    return { x0: 0, y0: 0, across: W, down: H };
  }
  let down = Math.round((across * ch) / cw);
  down = clamp(down, 3, H);
  const x0 = Math.round(view.centerX - across / 2);
  const y0 = clamp(Math.round(view.centerY - down / 2), 0, H - down);
  return { x0, y0, across, down };
}

/** Screen pixel → grid cell, using the same window the renderer used. */
export function screenToCell(
  data: WorldData,
  view: View,
  cw: number,
  ch: number,
  sx: number,
  sy: number,
): number | null {
  const win = computeWindow(data, view, cw, ch);
  const gx = (((win.x0 + Math.floor((sx / cw) * win.across)) % data.w) + data.w) % data.w;
  const gy = clamp(win.y0 + Math.floor((sy / ch) * win.down), 0, data.h - 1);
  if (gx < 0 || gy < 0) return null;
  return gy * data.w + gx;
}

/** Cell → screen pixel (centre of the cell), or null if outside the window. */
function cellToScreen(
  data: WorldData,
  win: Window,
  cw: number,
  ch: number,
  cell: number,
): { x: number; y: number; cellPx: number } | null {
  const cx = cell % data.w;
  const cy = Math.floor(cell / data.w);
  const dx = (((cx - win.x0) % data.w) + data.w) % data.w;
  if (dx >= win.across) return null;
  const dy = cy - win.y0;
  if (dy < 0 || dy >= win.down) return null;
  const cellPx = cw / win.across;
  return { x: (dx + 0.5) * cellPx, y: (dy + 0.5) * (ch / win.down), cellPx };
}

// NW-lit hillshade of the elevation field, wrapping east–west.
function shadeAt(data: WorldData, x: number, y: number): number {
  const W = data.w;
  const H = data.h;
  const E = data.elev;
  const xl = (x - 1 + W) % W;
  const xr = (x + 1) % W;
  const yu = clamp(y - 1, 0, H - 1);
  const yd = clamp(y + 1, 0, H - 1);
  const dzdx = (E[y * W + xr] - E[y * W + xl]) / 255;
  const dzdy = (E[yd * W + x] - E[yu * W + x]) / 255;
  return clamp(1 + (dzdx * 2.4 + dzdy * 2.4), 0.55, 1.55);
}

function tempColor(t: number): [number, number, number] {
  const c = t / 255;
  if (c < 0.5) {
    const k = c / 0.5;
    return [28 + 150 * k, 60 + 140 * k, 130 + 100 * k];
  }
  const k = (c - 0.5) / 0.5;
  return [178 + 70 * k, 200 - 130 * k, 230 - 190 * k];
}

/** Paint the grid window into a fresh offscreen canvas, one pixel per cell. */
function paintGrid(data: WorldData, view: View, win: Window): HTMLCanvasElement {
  const { x0, y0, across, down } = win;
  const W = data.w;
  const H = data.h;
  const { biome, elev, river, temp, owner, fertility } = data;
  const layer = view.layer;
  const stipple = across <= STIPPLE_MAX;

  const off = document.createElement("canvas");
  off.width = across;
  off.height = down;
  const octx = off.getContext("2d")!;
  const img = octx.createImageData(across, down);
  const p = img.data;

  for (let oy = 0; oy < down; oy++) {
    const gy = clamp(y0 + oy, 0, H - 1);
    for (let ox = 0; ox < across; ox++) {
      const gx = (((x0 + ox) % W) + W) % W;
      const i = gy * W + gx;
      const bi = biome[i];
      const isLand = bi !== 0;
      let r: number;
      let g: number;
      let bl: number;

      if (layer === "temp") {
        const c = tempColor(temp[i]);
        r = c[0];
        g = c[1];
        bl = c[2];
        if (!isLand) {
          r *= 0.55;
          g *= 0.6;
          bl *= 0.72;
        }
      } else if (layer === "relief") {
        if (isLand) {
          const e = elev[i] / 255;
          const v = 96 + e * 150;
          r = v * 1.02;
          g = v * 0.99;
          bl = v * 0.9;
        } else {
          r = 20;
          g = 30;
          bl = 44;
        }
      } else if (layer === "territory") {
        if (isLand) {
          const c = BIOME_COL[bi];
          // desaturate the land so owner colour reads on top
          const grey = (c[0] + c[1] + c[2]) / 3;
          r = c[0] * 0.5 + grey * 0.5;
          g = c[1] * 0.5 + grey * 0.5;
          bl = c[2] * 0.5 + grey * 0.5;
          const ow = owner[i];
          if (ow > 0) {
            const cc = data.civById.get(ow - 1);
            if (cc) {
              const [cr, cg, cb] = civRgb(cc.color);
              r = r * 0.42 + cr * 0.58;
              g = g * 0.42 + cg * 0.58;
              bl = bl * 0.42 + cb * 0.58;
            }
          }
        } else {
          r = 16;
          g = 24;
          bl = 36;
        }
      } else {
        // biome
        const c = BIOME_COL[bi];
        r = c[0];
        g = c[1];
        bl = c[2];
        if (!isLand) {
          let nearLand = 0;
          for (let dy = -1; dy <= 1 && !nearLand; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = (gx + dx + W) % W;
              const ny = clamp(gy + dy, 0, H - 1);
              if (biome[ny * W + nx] !== 0) {
                nearLand = 1;
                break;
              }
            }
          }
          if (nearLand) {
            r += 18;
            g += 30;
            bl += 34;
          }
        }
      }

      if (isLand && layer !== "temp") {
        const s = shadeAt(data, gx, gy);
        r *= s;
        g *= s;
        bl *= s;
      }

      // fertility texture, so good farmland reads before anyone farms it
      if (isLand && stipple && layer !== "temp") {
        const f = fertility[i] / 255;
        const jitter = mulberry(i * 7919)();
        const k = 0.9 + f * 0.22 + (jitter - 0.5) * 0.12;
        r *= k;
        g *= k * 1.01;
        bl *= k * 0.98;
      }

      // territory borders: thin darkening where ownership changes
      if (layer === "territory" && isLand && owner[i] > 0) {
        const rx = (gx + 1) % W;
        const dyc = clamp(gy + 1, 0, H - 1);
        if (owner[gy * W + rx] !== owner[i] || owner[dyc * W + gx] !== owner[i]) {
          r *= 0.6;
          g *= 0.6;
          bl *= 0.6;
        }
      }

      // rivers over everything
      if (isLand && river[i] > 40) {
        const t = Math.min(1, river[i] / 200) * 0.85;
        r = r * (1 - t) + 74 * t;
        g = g * (1 - t) + 140 * t;
        bl = bl * (1 - t) + 190 * t;
      }

      const o = (oy * across + ox) * 4;
      p[o] = clamp(r, 0, 255);
      p[o + 1] = clamp(g, 0, 255);
      p[o + 2] = clamp(bl, 0, 255);
      p[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return off;
}

/* =================== procedural buildings =================== */

interface BuildingSpec {
  material: string;
  seed: number;
  storeys: number;
  width: number;
  condition: "good" | "poor" | "ruin";
  lit: boolean;
}

/** Draw one building into a 1× pixel context. Origin is bottom-left. Ported
 *  verbatim from the study — the pixel courses are what make each material read. */
function drawBuilding(ctx: CanvasRenderingContext2D, ox: number, oy: number, spec: BuildingSpec) {
  const m = MATERIALS[spec.material];
  const rnd = mulberry(spec.seed);
  const pick = (arr: string[]) => arr[Math.floor(rnd() * arr.length)];

  const storeys = spec.storeys;
  const sh = m.glassy || m.roofKind === "flat" ? 7 : 8;
  const w = spec.width;
  const bodyH = storeys * sh;
  const top = oy - bodyH;
  const wear = spec.condition === "ruin" ? 0.45 : spec.condition === "poor" ? 0.18 : 0.04;

  for (let y = 0; y < bodyH; y++) {
    for (let x = 0; x < w; x++) {
      if (rnd() < wear * 0.35 && y < bodyH * 0.5) continue;
      let col: string;
      if (m.roofKind === "tile" && spec.material === "firedbrick") {
        const course = Math.floor(y / 2);
        const brick = Math.floor((x + (course % 2) * 2) / 4);
        col = m.wall[(course + brick) % m.wall.length];
      } else if (spec.material === "stone") {
        const course = Math.floor(y / 3);
        const block = Math.floor((x + (course % 2) * 3) / 6);
        col = m.wall[(course * 2 + block) % m.wall.length];
      } else if (spec.material === "timber") {
        col = m.wall[Math.floor(y / 2) % m.wall.length];
      } else {
        col = m.wall[Math.floor(rnd() * m.wall.length)];
      }
      ctx.fillStyle = col;
      ctx.fillRect(ox + x, top + y, 1, 1);
    }
  }

  if (m.beams) {
    ctx.fillStyle = m.trim;
    for (let s = 0; s < storeys; s++) {
      const sy = top + s * sh;
      ctx.fillRect(ox, sy, w, 1);
      ctx.fillRect(ox, sy + sh - 1, w, 1);
      ctx.fillRect(ox, sy, 1, sh);
      ctx.fillRect(ox + w - 1, sy, 1, sh);
      for (let k = 1; k < sh - 1; k++) {
        const bx = ox + Math.round((k / sh) * (w - 2)) + 1;
        ctx.fillRect(bx, sy + k, 1, 1);
      }
    }
  }

  const winW = m.glassy ? 3 : 2;
  const winH = m.glassy ? 3 : 2;
  const gap = m.glassy ? 2 : 3;
  const cols = Math.max(1, Math.floor((w - 2) / (winW + gap)));
  for (let s = 0; s < storeys; s++) {
    for (let c = 0; c < cols; c++) {
      const isDoorSlot = s === storeys - 1 && c === Math.floor(cols / 2);
      const wx = ox + 2 + c * (winW + gap);
      const wy = top + s * sh + 2;
      if (isDoorSlot) {
        ctx.fillStyle = m.trim;
        ctx.fillRect(wx, oy - 5, winW + 1, 5);
        continue;
      }
      if (spec.condition === "ruin" && rnd() < 0.5) continue;
      const lit = spec.lit && rnd() < 0.55;
      ctx.fillStyle = m.glassy
        ? lit
          ? "#cfe4ea"
          : "#7fa6b5"
        : lit
          ? "#e8c66a"
          : "#2b2620";
      ctx.fillRect(wx, wy, winW, winH);
      if (!m.glassy) {
        ctx.fillStyle = m.trim;
        ctx.fillRect(wx - 1, wy - 1, winW + 2, 1);
      }
    }
  }

  if (m.roofKind === "flat") {
    ctx.fillStyle = pick(m.roof);
    ctx.fillRect(ox - 1, top - 2, w + 2, 2);
    ctx.fillStyle = m.trim;
    ctx.fillRect(ox - 1, top - 2, w + 2, 1);
  } else {
    const rh = Math.round(w * 0.5 * m.pitch);
    for (let y = 0; y < rh; y++) {
      const inset = Math.round(((rh - 1 - y) / rh) * (w / 2));
      const rowW = w - inset * 2 + 2;
      if (rowW <= 0) break;
      for (let x = 0; x < rowW; x++) {
        if (spec.condition === "ruin" && rnd() < 0.3) continue;
        if (spec.condition === "poor" && rnd() < 0.1) continue;
        ctx.fillStyle =
          m.roofKind === "thatch"
            ? m.roof[(y + Math.floor(x / 2)) % m.roof.length]
            : m.roofKind === "slate" || m.roofKind === "tile"
              ? m.roof[(Math.floor(y / 2) + Math.floor(x / 3)) % m.roof.length]
              : m.roof[(y + x) % m.roof.length];
        ctx.fillRect(ox + inset - 1 + x, top - rh + y, 1, 1);
      }
    }
    ctx.fillStyle = m.trim;
    ctx.fillRect(ox + Math.floor(w / 2) - 1, top - rh, 3, 1);
  }

  if (m.roofKind !== "flat" && rnd() < 0.7) {
    const chx = ox + Math.floor(w * (0.2 + rnd() * 0.55));
    const rh = Math.round(w * 0.5 * m.pitch);
    ctx.fillStyle = m.trim;
    ctx.fillRect(chx, top - rh - 4, 3, 6);
    ctx.fillStyle = m.wall[0];
    ctx.fillRect(chx, top - rh - 3, 3, 4);
  }
}

/** Draw a settlement as a small procedurally-generated town, from what its civ
 *  can actually build with. Rendered at 1× into an offscreen, then upscaled. */
function drawTown(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  cellPx: number,
  s: SettlementInfo,
  data: WorldData,
) {
  const civ = data.civById.get(s.civ);
  const mats = civ ? availableMaterials(civ.capabilities) : ["thatch"];
  const best = mats[mats.length - 1];
  const rnd = mulberry((s.id + 1) * 2654435761);

  const LW = 72;
  const LH = 48;
  const off = document.createElement("canvas");
  off.width = LW;
  off.height = LH;
  const o = off.getContext("2d")!;

  // ground line
  const baseY = LH - 6;
  o.fillStyle = "#20262d";
  o.fillRect(0, baseY, LW, 1);
  o.fillStyle = "#171b21";
  o.fillRect(0, baseY + 1, LW, LH - baseY - 1);

  const count = clamp(Math.round(Math.sqrt(s.pop) / 5), 4, 26);
  const pickMat = () => {
    const r = rnd();
    if (mats.length === 1 || r < 0.62) return best;
    if (r < 0.86) return mats[mats.length - 2] ?? best;
    return mats[Math.max(0, mats.length - 3)];
  };
  const pickCond = (): "good" | "poor" | "ruin" => {
    const r = rnd();
    return r < 0.72 ? "good" : r < 0.93 ? "poor" : "ruin";
  };

  // two shallow rows, back row higher and dimmer for depth
  let placed = 0;
  for (let row = 0; row < 2 && placed < count; row++) {
    let x = 3 + Math.floor(rnd() * 3);
    const rowBase = baseY - row * 6;
    while (x < LW - 8 && placed < count) {
      const material = row === 1 ? best : pickMat();
      const m = MATERIALS[material];
      const width = 6 + Math.floor(rnd() * 7);
      if (x + width > LW - 3) break;
      const storeys = 1 + Math.floor(rnd() * rnd() * m.maxStorey);
      drawBuilding(o, x, rowBase, {
        material,
        seed: (s.id + 1) * 131 + placed * 17 + row * 911,
        storeys: Math.max(1, storeys),
        width,
        condition: pickCond(),
        lit: true,
      });
      x += width + 2 + Math.floor(rnd() * 3);
      placed++;
    }
  }

  const drawW = Math.max(cellPx * 2.6, 44);
  const drawH = drawW * (LH / LW);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, LW, LH, screenX - drawW / 2, screenY - drawH * 0.82, drawW, drawH);
}

/* =================== settlement marks =================== */

function drawSettlementDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: SettlementInfo,
  data: WorldData,
  scale: number,
) {
  const civ = data.civById.get(s.civ);
  const color = civ?.color ?? "#ffffff";
  const r = clamp(2 + Math.sqrt(s.pop) / 18, 2.4, 16) * scale;
  ctx.beginPath();
  ctx.arc(x, y, r + 1.6 * scale, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.1 * scale;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.stroke();
}

/* =================== top-level render =================== */

/** Render a full frame of the world into `canvas` for the given view. */
export function renderWorld(canvas: HTMLCanvasElement, data: WorldData, view: View) {
  const cw = canvas.width;
  const ch = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const win = computeWindow(data, view, cw, ch);

  const off = paintGrid(data, view, win);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(off, 0, 0, win.across, win.down, 0, 0, cw, ch);

  const scale = clamp(cw / 1000, 0.7, 2.2);
  const buildings = view.cellsAcross <= LOCALITY_MAX;

  // deposits, faint, only when zoomed in
  if (win.across <= STIPPLE_MAX) {
    for (const d of data.deposits) {
      const pos = cellToScreen(data, win, cw, ch, d.c);
      if (!pos) continue;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 2.4 * scale, 0, Math.PI * 2);
      ctx.fillStyle = ORE_COL[d.k] ?? "#ffffff";
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.8 * scale;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.stroke();
    }
  }

  // settlements — buildings up close, dots when far out. Draw smaller first so
  // big cities sit on top.
  const inView: { s: SettlementInfo; x: number; y: number; cellPx: number }[] = [];
  for (const s of data.settlements) {
    const pos = cellToScreen(data, win, cw, ch, s.cell);
    if (pos) inView.push({ s, ...pos });
  }
  inView.sort((a, b) => a.s.pop - b.s.pop);

  for (const { s, x, y, cellPx } of inView) {
    if (buildings) drawTown(ctx, x, y, cellPx, s, data);
    else drawSettlementDot(ctx, x, y, s, data, scale);
  }

  // Labels only up close, where they name a specific place instead of stamping
  // "settlement" a dozen times over the region. Show whose it is and how big.
  if (buildings) {
    ctx.font = `${Math.round(11 * scale)}px ui-monospace, monospace`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "center";
    for (const { s, x, y, cellPx } of inView) {
      const civ = data.civById.get(s.civ);
      const named = s.name && s.name !== "camp" && s.name !== "settlement";
      const label = `${named ? s.name : (civ?.name ?? "settlement")} · ${s.pop.toLocaleString()}`;
      const ly = y - Math.max(cellPx * 1.5, 26);
      ctx.lineWidth = 3 * scale;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.strokeText(label, x, ly);
      ctx.fillStyle = "rgba(240,244,248,0.95)";
      ctx.fillText(label, x, ly);
    }
  }
}
