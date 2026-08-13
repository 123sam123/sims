/**
 * Building materials, and the rule that a civilisation can only build with what
 * it can make.
 *
 * The material specs are ported verbatim from the validated rendering study —
 * palette, roof kind, pitch, storey ceiling. What is new here is the *gate*:
 * each material is unlocked by a capability id from the engine's tech tree
 * (`packages/engine/src/knowledge.ts`). A civ that never fires a kiln has no
 * fired-brick buildings, because `firedbrick` is gated on `kiln` and the gate
 * simply is not open. This is the whole point of drawing in code — appearance
 * is a function of possession, not a sprite unlock.
 */

export interface MaterialSpec {
  label: string;
  needs: string;
  wall: string[];
  trim: string;
  roof: string[];
  roofKind: "thatch" | "flat" | "shingle" | "slate" | "tile";
  pitch: number;
  maxStorey: number;
  beams?: boolean;
  glassy?: boolean;
}

export const MATERIALS: Record<string, MaterialSpec> = {
  thatch: {
    label: "Wattle & thatch",
    needs: "nothing but reeds and mud",
    wall: ["#a8946f", "#9c8763", "#b09b76"],
    trim: "#6b5942",
    roof: ["#c2a468", "#ad8f56", "#d0b478"],
    roofKind: "thatch",
    pitch: 0.85,
    maxStorey: 1,
  },
  mudbrick: {
    label: "Mud brick",
    needs: "clay + sun",
    wall: ["#bd9366", "#b0865c", "#c79d70"],
    trim: "#8a6743",
    roof: ["#a98a5f", "#9c7d54"],
    roofKind: "flat",
    pitch: 0,
    maxStorey: 2,
  },
  timber: {
    label: "Timber",
    needs: "forest + hafted axes",
    wall: ["#8a6a45", "#7c5f3e", "#96754e"],
    trim: "#4d3a25",
    roof: ["#6d5738", "#5e4a30", "#7a6242"],
    roofKind: "shingle",
    pitch: 0.8,
    maxStorey: 2,
  },
  stone: {
    label: "Cut stone",
    needs: "masonry",
    wall: ["#9b978d", "#8e8a80", "#a8a49a"],
    trim: "#6e6a62",
    roof: ["#5a6068", "#4b5158", "#666d75"],
    roofKind: "slate",
    pitch: 0.7,
    maxStorey: 3,
  },
  firedbrick: {
    label: "Fired brick",
    needs: "kiln",
    wall: ["#9d4f38", "#8c452f", "#ab5a41"],
    trim: "#6b3324",
    roof: ["#8a4030", "#78372a", "#98493a"],
    roofKind: "tile",
    pitch: 0.75,
    maxStorey: 4,
  },
  halftimber: {
    label: "Half-timbered",
    needs: "sawn timber + plaster",
    wall: ["#ded3bd", "#d2c6ae", "#e6dcc8"],
    trim: "#463526",
    roof: ["#7d4436", "#6d3b2e"],
    roofKind: "tile",
    pitch: 0.9,
    maxStorey: 3,
    beams: true,
  },
  concrete: {
    label: "Concrete",
    needs: "cement + steel",
    wall: ["#a9a59c", "#9d998f", "#b5b1a8"],
    trim: "#7a766e",
    roof: ["#8e8a82", "#807c74"],
    roofKind: "flat",
    pitch: 0,
    maxStorey: 6,
  },
  steelglass: {
    label: "Steel & glass",
    needs: "precision steel + float glass",
    wall: ["#3f5a68", "#365060", "#496675"],
    trim: "#22323c",
    roof: ["#2c3f4a", "#26373f"],
    roofKind: "flat",
    pitch: 0,
    maxStorey: 10,
    glassy: true,
  },
};

/**
 * Each material and the engine capability ids that unlock it, oldest first.
 * The ids are exactly those in `packages/engine/src/knowledge.ts`; a settlement
 * builds with the newest material whose gate its civ has opened.
 */
const MATERIAL_GATES: { material: string; needs: string[] }[] = [
  { material: "thatch", needs: [] },
  { material: "timber", needs: ["hafting"] },
  { material: "mudbrick", needs: ["pottery"] },
  { material: "stone", needs: ["masonry"] },
  { material: "firedbrick", needs: ["kiln"] },
  { material: "halftimber", needs: ["architecture"] },
  { material: "concrete", needs: ["steel"] },
  { material: "steelglass", needs: ["metallurgy_precision", "glass"] },
];

/**
 * The materials a civ can build with right now, oldest → newest. Always at
 * least `thatch`; the last entry is the most advanced it has reached.
 */
export function availableMaterials(capabilities: Iterable<string>): string[] {
  const caps = capabilities instanceof Set ? capabilities : new Set(capabilities);
  return MATERIAL_GATES.filter((g) => g.needs.every((n) => caps.has(n))).map((g) => g.material);
}
