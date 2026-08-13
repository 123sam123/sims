import type { ResourceKind } from "./geo-data.ts";

/**
 * Capabilities, not a historical tech tree.
 *
 * A node describes something physically possible given prerequisites and
 * materials. It says nothing about when — or whether — anyone discovers it.
 * A civilisation with no tin in reach cannot make bronze no matter how long it
 * researches, and nothing here obliges anyone to invent anything.
 */
export interface Capability {
  id: string;
  name: string;
  era: number; // rough ordering hint, 0 = paleolithic
  /** Capabilities that must already be held. */
  needs: string[];
  /** Materials that must be reachable and extractable. */
  materials?: ResourceKind[];
  /** Terrain the civilisation must actually control. */
  terrain?: ("river" | "coast" | "fertile" | "forest" | "mountain")[];
  /** Effort in research-years at baseline scholarship. */
  effort: number;
  /** Minimum settled population before this is even conceivable. */
  minPop?: number;
  what: string;
}

export const CAPABILITIES: Capability[] = [
  // --- Paleolithic: what a band already knows on the first tick -------------
  { id: "fire", name: "Controlled Fire", era: 0, needs: [], effort: 0, what: "Warmth, cooked food, protection." },
  { id: "stone_tools", name: "Knapped Stone", era: 0, needs: [], effort: 0, what: "Cutting, scraping, killing." },
  { id: "language", name: "Language", era: 0, needs: [], effort: 0, what: "Coordination beyond gesture." },
  { id: "foraging", name: "Foraging", era: 0, needs: [], effort: 0, what: "Reading the land for food." },

  // --- Late paleolithic ----------------------------------------------------
  { id: "hafting", name: "Hafted Tools", era: 1, needs: ["stone_tools"], effort: 40, what: "Axes and spears with handles." },
  { id: "clothing", name: "Sewn Clothing", era: 1, needs: ["stone_tools"], effort: 50, what: "Survival in cold latitudes." },
  { id: "shelter", name: "Built Shelter", era: 1, needs: ["hafting"], effort: 60, what: "Structures that outlast a season." },
  { id: "boats", name: "Small Craft", era: 1, needs: ["hafting"], terrain: ["river"], effort: 90, what: "Rivers become roads." },
  { id: "bow", name: "Bow", era: 1, needs: ["hafting"], terrain: ["forest"], effort: 100, what: "Killing at range." },

  // --- Neolithic -----------------------------------------------------------
  { id: "plant_domestication", name: "Plant Domestication", era: 2, needs: ["foraging"], terrain: ["fertile"], effort: 220, what: "Food you plant instead of find." },
  { id: "animal_domestication", name: "Animal Domestication", era: 2, needs: ["foraging"], effort: 200, what: "Meat, milk, muscle, wool." },
  { id: "settlement", name: "Permanent Settlement", era: 2, needs: ["plant_domestication", "shelter"], effort: 150, what: "Staying put through the winter." },
  { id: "pottery", name: "Pottery", era: 2, needs: ["fire", "settlement"], effort: 120, what: "Storage and cooking vessels." },
  { id: "weaving", name: "Weaving", era: 2, needs: ["settlement"], effort: 130, what: "Cloth, rope, sails, nets." },
  { id: "granary", name: "Grain Storage", era: 2, needs: ["pottery", "settlement"], effort: 110, what: "Surplus survives to next year." },
  { id: "irrigation", name: "Irrigation", era: 2, needs: ["settlement"], terrain: ["river"], effort: 260, what: "Farming beyond the rainfall." },
  { id: "plough", name: "Plough", era: 2, needs: ["animal_domestication", "settlement"], effort: 240, what: "One family works far more land." },
  { id: "wheel", name: "Wheel", era: 2, needs: ["hafting", "settlement"], effort: 280, what: "Carts, and later everything." },

  // --- Metals: the geography bottleneck ------------------------------------
  { id: "kiln", name: "Kiln", era: 3, needs: ["pottery"], effort: 200, what: "Sustained high heat." },
  { id: "smelting", name: "Smelting", era: 3, needs: ["kiln"], effort: 300, what: "Metal out of rock." },
  { id: "copper_working", name: "Copperworking", era: 3, needs: ["smelting"], materials: ["copper"], effort: 260, what: "Soft metal tools and ornament." },
  { id: "tin_working", name: "Tinworking", era: 3, needs: ["smelting"], materials: ["tin"], effort: 300, what: "The scarce half of bronze." },
  { id: "bronze", name: "Bronze", era: 3, needs: ["copper_working", "tin_working"], materials: ["copper", "tin"], effort: 380, what: "Hard tools, hard weapons, hard politics." },
  { id: "bellows", name: "Bellows", era: 3, needs: ["kiln", "weaving"], effort: 250, what: "Heat past what a fire will give." },
  { id: "iron_smelting", name: "Ironworking", era: 4, needs: ["bellows", "smelting"], materials: ["iron"], effort: 620, what: "Common ore, uncommon consequences." },
  { id: "steel", name: "Steel", era: 5, needs: ["iron_smelting"], materials: ["iron", "coal"], effort: 900, what: "Iron that holds an edge." },

  // --- Building & settlement ----------------------------------------------
  { id: "masonry", name: "Masonry", era: 3, needs: ["settlement", "hafting"], effort: 300, what: "Walls that outlive their builders." },
  { id: "roads", name: "Roads", era: 3, needs: ["wheel", "masonry"], effort: 350, what: "Trade, armies, and tax collectors move." },
  { id: "aqueduct", name: "Aqueduct", era: 4, needs: ["masonry", "irrigation"], effort: 500, what: "Cities larger than their water table." },
  { id: "sanitation", name: "Sanitation", era: 4, needs: ["aqueduct"], effort: 450, what: "Density without perpetual plague." },
  { id: "architecture", name: "Architecture", era: 4, needs: ["masonry", "mathematics"], effort: 600, what: "Building deliberately, at scale." },

  // --- Knowledge & institutions -------------------------------------------
  { id: "counting", name: "Counting", era: 3, needs: ["granary"], effort: 140, what: "Knowing how much you have." },
  { id: "writing", name: "Writing", era: 3, needs: ["counting", "settlement"], effort: 420, minPop: 3000, what: "Memory that survives the rememberer." },
  { id: "mathematics", name: "Mathematics", era: 4, needs: ["writing"], effort: 500, what: "Reasoning about quantity in the abstract." },
  { id: "law_code", name: "Written Law", era: 4, needs: ["writing"], effort: 380, what: "Rules that outlast the ruler." },
  { id: "currency", name: "Currency", era: 4, needs: ["counting", "copper_working"], effort: 400, what: "Trade without coincidence of wants." },
  { id: "astronomy", name: "Astronomy", era: 4, needs: ["mathematics"], effort: 550, what: "Calendars, navigation, and awe." },
  { id: "medicine", name: "Medicine", era: 4, needs: ["writing"], effort: 600, what: "Sometimes helping." },
  { id: "philosophy", name: "Philosophy", era: 4, needs: ["writing"], effort: 500, minPop: 8000, what: "Arguing about what is worth doing." },
  { id: "schools", name: "Formal Schooling", era: 5, needs: ["writing", "law_code"], effort: 650, minPop: 15000, what: "Knowledge taught, not inherited." },

  // --- Movement & reach ----------------------------------------------------
  { id: "sailing", name: "Sailing", era: 3, needs: ["boats", "weaving"], terrain: ["coast"], effort: 340, what: "The sea stops being a wall." },
  { id: "navigation", name: "Navigation", era: 4, needs: ["sailing", "astronomy"], effort: 620, what: "Arriving where you intended." },
  { id: "cavalry", name: "Riding", era: 3, needs: ["animal_domestication"], effort: 320, what: "Speed that changes what war is." },

  // --- War -----------------------------------------------------------------
  { id: "military_org", name: "Organised Warfare", era: 3, needs: ["settlement", "hafting"], effort: 260, what: "Fighting as a body, not a crowd." },
  { id: "fortification", name: "Fortification", era: 3, needs: ["masonry", "military_org"], effort: 400, what: "Making a place expensive to take." },
  { id: "siegecraft", name: "Siegecraft", era: 4, needs: ["fortification", "mathematics"], effort: 550, what: "Making it expensive anyway." },

  // --- Toward industry (headroom; nobody is owed any of this) --------------
  { id: "watermill", name: "Watermill", era: 5, needs: ["masonry", "wheel"], terrain: ["river"], effort: 550, what: "Power that is not muscle." },
  { id: "windmill", name: "Windmill", era: 5, needs: ["watermill"], effort: 500, what: "Power away from the river." },
  { id: "glass", name: "Glassmaking", era: 5, needs: ["kiln", "bellows"], effort: 480, what: "Windows, vessels, and eventually lenses." },
  { id: "paper", name: "Paper", era: 5, needs: ["weaving", "writing"], effort: 420, what: "Cheap memory." },
  { id: "printing", name: "Printing", era: 6, needs: ["paper", "metallurgy_precision"], effort: 800, minPop: 40000, what: "Ideas that outrun the people carrying them." },
  { id: "metallurgy_precision", name: "Precision Metalwork", era: 6, needs: ["steel"], effort: 850, what: "Parts that fit other parts." },
  { id: "optics", name: "Optics", era: 6, needs: ["glass", "mathematics"], effort: 700, what: "Seeing the very far and the very small." },
  { id: "gunpowder", name: "Gunpowder", era: 6, needs: ["chemistry"], effort: 900, what: "Fortification stops working." },
  { id: "chemistry", name: "Chemistry", era: 6, needs: ["philosophy", "glass"], effort: 950, what: "Matter has rules." },
  { id: "steam", name: "Steam Power", era: 7, needs: ["metallurgy_precision", "chemistry"], materials: ["coal"], effort: 1400, minPop: 80000, what: "Work without muscle, wind, or water." },
];

export const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** What every band starts knowing. */
export const STARTING_CAPABILITIES = ["fire", "stone_tools", "language", "foraging"];

/**
 * Capabilities whose prerequisites a civilisation currently satisfies —
 * i.e. what it could plausibly work on next. Materials and terrain are checked
 * by the caller against what the civ actually controls.
 */
export function researchable(
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
): Capability[] {
  return CAPABILITIES.filter((c) => {
    if (held.has(c.id)) return false;
    if (!c.needs.every((n) => held.has(n))) return false;
    if (c.materials && !c.materials.every(hasMaterial)) return false;
    if (c.terrain && !c.terrain.some(hasTerrain)) return false;
    if (c.minPop && population < c.minPop) return false;
    return true;
  });
}

/**
 * Why a civ cannot pursue something — used to give the AI an honest refusal
 * rather than silent failure.
 */
export function blockedBecause(
  cap: Capability,
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
): string | null {
  const missingNeeds = cap.needs.filter((n) => !held.has(n));
  if (missingNeeds.length) {
    return `requires ${missingNeeds.map((n) => CAPABILITY_BY_ID.get(n)?.name ?? n).join(" and ")} first`;
  }
  if (cap.materials) {
    const missing = cap.materials.filter((m) => !hasMaterial(m));
    if (missing.length) return `no reachable ${missing.join(" or ")}`;
  }
  if (cap.terrain && !cap.terrain.some(hasTerrain)) {
    return `needs territory with ${cap.terrain.join(" or ")}`;
  }
  if (cap.minPop && population < cap.minPop) {
    return `needs a settled population of about ${cap.minPop.toLocaleString()}`;
  }
  return null;
}
