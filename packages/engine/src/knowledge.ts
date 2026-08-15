import type { ResourceKind } from "./geo-data.ts";

/**
 * Capabilities, not a historical tech tree.
 *
 * A node describes something physically possible given prerequisites and
 * materials. It says nothing about when — or whether — anyone discovers it.
 * A civilisation with no tin in reach cannot make bronze no matter how long it
 * researches, and nothing here obliges anyone to invent anything.
 *
 * The tree has no terminus. The authored spans run to era 12, and past them an
 * open frontier generates `frontier_<n>` capabilities on demand — each tier
 * needing the one before it and costing more — so `researchable()` never runs
 * dry for a civilisation that has learned everything written down here.
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

  // --- Late agrarian & mercantile (filling out eras 5–6) --------------------
  { id: "crop_rotation", name: "Crop Rotation", era: 5, needs: ["plough", "granary"], effort: 480, what: "The field rests and the yield rises." },
  { id: "distillation", name: "Distillation", era: 5, needs: ["glass"], effort: 520, what: "Essences, spirits and acids." },
  { id: "compass", name: "Compass", era: 5, needs: ["iron_smelting", "astronomy"], materials: ["iron"], effort: 500, what: "A needle that knows north." },
  { id: "banking", name: "Banking", era: 5, needs: ["currency", "writing"], effort: 560, minPop: 20000, what: "Money that works while you sleep." },
  { id: "clockwork", name: "Clockwork", era: 6, needs: ["metallurgy_precision"], effort: 780, what: "Time cut into equal pieces." },
  { id: "universities", name: "Universities", era: 6, needs: ["schools", "philosophy"], effort: 820, minPop: 60000, what: "Doubt, organised and funded." },
  { id: "cartography", name: "Cartography", era: 6, needs: ["navigation", "paper"], effort: 680, what: "The world drawn small enough to argue over." },
  { id: "deepwater_ships", name: "Deepwater Ships", era: 6, needs: ["sailing", "compass", "cartography"], terrain: ["coast"], effort: 900, what: "Out of sight of land, on purpose." },

  // --- Early industry (era 7) ------------------------------------------------
  { id: "scientific_method", name: "Scientific Method", era: 7, needs: ["universities", "optics", "printing"], effort: 1300, what: "Being wrong faster, on purpose." },
  { id: "coke_smelting", name: "Coke Smelting", era: 7, needs: ["steel"], materials: ["iron", "coal"], effort: 1500, what: "Iron made with coal, at any scale." },
  { id: "machine_tools", name: "Machine Tools", era: 7, needs: ["metallurgy_precision", "steam"], materials: ["iron"], effort: 1700, what: "Machines that cut the parts of machines." },
  { id: "cement", name: "Cement", era: 7, needs: ["kiln", "chemistry"], effort: 1250, what: "Stone you can pour." },
  { id: "textile_machinery", name: "Textile Machinery", era: 7, needs: ["machine_tools", "weaving"], effort: 1400, what: "Cloth by the mile." },
  { id: "railway", name: "Railways", era: 7, needs: ["steam", "machine_tools"], materials: ["iron", "coal"], effort: 2000, minPop: 100000, what: "Distance collapses." },
  { id: "vaccination", name: "Vaccination", era: 7, needs: ["medicine", "scientific_method"], effort: 1350, what: "Borrowed immunity." },
  { id: "gas_lighting", name: "Gas Lighting", era: 7, needs: ["coke_smelting"], materials: ["coal"], effort: 1300, what: "The day extended by pipe." },
  { id: "canning", name: "Canning", era: 7, needs: ["glass", "chemistry"], effort: 1200, what: "A harvest that keeps for years." },
  { id: "balloon_flight", name: "Balloon Flight", era: 7, needs: ["chemistry", "weaving"], effort: 1250, what: "Lighter than air, at the wind's mercy." },

  // --- The electric age (era 8) ----------------------------------------------
  { id: "electricity", name: "Electricity", era: 8, needs: ["scientific_method", "machine_tools"], materials: ["copper"], effort: 2800, minPop: 120000, what: "Power that travels down a wire." },
  { id: "telegraph", name: "Telegraph", era: 8, needs: ["electricity"], materials: ["copper"], effort: 2300, what: "News outruns the horse." },
  { id: "telephone", name: "Telephone", era: 8, needs: ["telegraph"], materials: ["copper"], effort: 2500, what: "A voice with no body in the room." },
  { id: "bessemer_steel", name: "Mass Steel", era: 8, needs: ["coke_smelting", "machine_tools"], materials: ["iron", "coal"], effort: 2600, minPop: 150000, what: "Steel by the ton, not the ingot." },
  { id: "oil_refining", name: "Oil Refining", era: 8, needs: ["chemistry", "machine_tools"], materials: ["oil"], effort: 2700, what: "Rock oil split into its useful parts." },
  { id: "internal_combustion", name: "Internal Combustion", era: 8, needs: ["oil_refining", "machine_tools"], materials: ["oil", "iron"], effort: 3200, minPop: 200000, what: "An explosion, harnessed a thousand times a minute." },
  { id: "industrial_chemistry", name: "Industrial Chemistry", era: 8, needs: ["chemistry", "steam"], effort: 2400, what: "Reactions by the vat, not the flask." },
  { id: "germ_theory", name: "Germ Theory", era: 8, needs: ["optics", "medicine", "scientific_method"], effort: 2600, what: "The killers are small, and they can be fought." },
  { id: "photography", name: "Photography", era: 8, needs: ["optics", "industrial_chemistry"], effort: 2200, what: "Light, fixed." },
  { id: "explosives", name: "High Explosives", era: 8, needs: ["industrial_chemistry"], effort: 2500, what: "Mountains move." },
  { id: "steamship", name: "Steamships", era: 8, needs: ["steam", "navigation"], materials: ["iron", "coal"], effort: 2400, what: "The wind stops mattering." },
  { id: "refrigeration", name: "Refrigeration", era: 8, needs: ["machine_tools", "industrial_chemistry"], effort: 2600, what: "Winter, manufactured." },
  { id: "anesthesia", name: "Anesthesia", era: 8, needs: ["medicine", "industrial_chemistry"], effort: 2300, what: "Surgery without the screaming." },

  // --- Motors, wings and grids (era 9) ----------------------------------------
  { id: "electrification", name: "Power Grids", era: 9, needs: ["electricity", "bessemer_steel"], materials: ["copper"], effort: 4500, minPop: 250000, what: "Every town on the wire." },
  { id: "automobile", name: "Automobiles", era: 9, needs: ["internal_combustion"], materials: ["iron", "oil"], effort: 4000, what: "The horse retires." },
  { id: "flight", name: "Powered Flight", era: 9, needs: ["internal_combustion"], materials: ["oil"], effort: 5000, what: "The air holds you after all." },
  { id: "radio", name: "Radio", era: 9, needs: ["electricity", "scientific_method"], materials: ["copper"], effort: 4200, what: "A voice in every house at once." },
  { id: "aluminium", name: "Aluminium", era: 9, needs: ["electrification", "industrial_chemistry"], materials: ["bauxite"], effort: 4800, what: "A metal light as ambition, paid for in electricity." },
  { id: "plastics", name: "Plastics", era: 9, needs: ["oil_refining", "industrial_chemistry"], materials: ["oil"], effort: 4300, what: "Any shape, forever." },
  { id: "nitrogen_fixation", name: "Synthetic Fertiliser", era: 9, needs: ["industrial_chemistry", "electricity"], effort: 4600, what: "Bread out of air." },
  { id: "antibiotics", name: "Antibiotics", era: 9, needs: ["germ_theory", "industrial_chemistry"], effort: 5200, what: "The mould that won." },
  { id: "assembly_line", name: "Mass Production", era: 9, needs: ["machine_tools", "electrification"], effort: 4400, minPop: 300000, what: "One thing, a million times." },
  { id: "structural_engineering", name: "Structural Engineering", era: 9, needs: ["cement", "bessemer_steel"], effort: 3800, what: "Buildings limited by nerve, not stone." },
  { id: "atomic_theory", name: "Atomic Theory", era: 9, needs: ["scientific_method", "industrial_chemistry"], effort: 5500, what: "Matter has parts, and the parts have rules." },
  { id: "cinema", name: "Cinema", era: 9, needs: ["photography", "electricity"], effort: 3600, what: "Dreams, ticketed." },
  { id: "hydroelectric", name: "Hydroelectric Power", era: 9, needs: ["electrification", "cement"], materials: ["copper"], terrain: ["river"], effort: 4700, what: "A river made to work night shifts." },

  // --- Electrons and atoms (era 10) --------------------------------------------
  { id: "electronics", name: "Electronics", era: 10, needs: ["radio"], materials: ["copper", "silica"], effort: 7500, minPop: 400000, what: "The current itself begins to think." },
  { id: "radar", name: "Radar", era: 10, needs: ["electronics"], materials: ["copper"], effort: 7000, what: "Seeing by echo." },
  { id: "sonar", name: "Sonar", era: 10, needs: ["electronics"], materials: ["copper"], effort: 6500, what: "The deep answers back." },
  { id: "computing", name: "Computing", era: 10, needs: ["electronics", "mathematics"], materials: ["copper", "silica"], effort: 9000, minPop: 600000, what: "Arithmetic at inhuman speed." },
  { id: "nuclear_fission", name: "Nuclear Fission", era: 10, needs: ["atomic_theory", "electronics"], materials: ["uranium"], effort: 11000, minPop: 800000, what: "The heart of matter, opened." },
  { id: "jet_engine", name: "Jet Engines", era: 10, needs: ["flight", "bessemer_steel"], materials: ["oil"], effort: 8000, what: "Faster than sound is a place you can go." },
  { id: "rocketry", name: "Rocketry", era: 10, needs: ["flight", "explosives"], materials: ["oil"], effort: 8500, what: "Thrust that needs no air." },
  { id: "television", name: "Television", era: 10, needs: ["electronics", "cinema"], materials: ["copper"], effort: 7200, what: "Every hearth, one window." },
  { id: "genetics", name: "Genetics", era: 10, needs: ["germ_theory", "electronics"], effort: 9500, what: "The recipe for living things, read." },
  { id: "synthetic_rubber", name: "Synthetic Rubber", era: 10, needs: ["plastics"], materials: ["oil"], effort: 6800, what: "Tyres that never saw a tree." },

  // --- Silicon and orbit (era 11) -----------------------------------------------
  { id: "semiconductors", name: "Semiconductors", era: 11, needs: ["computing"], materials: ["silica"], effort: 14000, minPop: 1000000, what: "Thought etched into sand." },
  { id: "nuclear_power", name: "Nuclear Power", era: 11, needs: ["nuclear_fission", "electrification"], materials: ["uranium"], effort: 15000, what: "A city lit by a kilogram." },
  { id: "spaceflight", name: "Spaceflight", era: 11, needs: ["rocketry", "computing", "aluminium"], materials: ["oil"], effort: 18000, minPop: 1200000, what: "Leaving." },
  { id: "satellites", name: "Satellites", era: 11, needs: ["spaceflight", "radio"], effort: 16000, what: "Eyes and voices in permanent fall." },
  { id: "lasers", name: "Lasers", era: 11, needs: ["electronics", "atomic_theory"], effort: 13000, what: "Light marching in step." },
  { id: "biotechnology", name: "Biotechnology", era: 11, needs: ["genetics", "computing"], effort: 17000, what: "Living things put to deliberate work." },
  { id: "advanced_materials", name: "Advanced Materials", era: 11, needs: ["plastics", "aluminium"], effort: 14500, what: "Stronger, lighter, stranger." },
  { id: "networked_computing", name: "Networked Computing", era: 11, needs: ["computing", "telephone"], materials: ["copper", "silica"], effort: 16500, minPop: 1000000, what: "Every machine talking to every machine." },
  { id: "fiber_optics", name: "Fiber Optics", era: 11, needs: ["lasers"], materials: ["silica"], effort: 15500, what: "Conversations at the speed of light." },
  { id: "medical_imaging", name: "Medical Imaging", era: 11, needs: ["electronics", "medicine"], effort: 13500, what: "The living body, seen without a knife." },
  { id: "green_revolution", name: "Green Revolution", era: 11, needs: ["genetics", "nitrogen_fixation"], effort: 14800, what: "Harvests the old maps call impossible." },
  { id: "robotics", name: "Robotics", era: 11, needs: ["computing", "assembly_line"], effort: 17500, what: "Hands that never tire." },

  // --- The speculative span (era 12) — Earth never finished this ---------------
  { id: "fusion_power", name: "Fusion Power", era: 12, needs: ["nuclear_power", "lasers"], materials: ["rare_earth"], effort: 30000, minPop: 2000000, what: "A bottled star." },
  { id: "orbital_industry", name: "Orbital Industry", era: 12, needs: ["spaceflight", "satellites", "robotics"], effort: 34000, minPop: 2000000, what: "Factories above the weather." },
  { id: "artificial_minds", name: "Artificial Minds", era: 12, needs: ["semiconductors", "networked_computing"], materials: ["silica", "rare_earth"], effort: 32000, minPop: 1500000, what: "Thought that is made, not born." },
  { id: "nanofabrication", name: "Nanofabrication", era: 12, needs: ["semiconductors", "lasers", "advanced_materials"], materials: ["silica", "rare_earth"], effort: 33000, what: "Building with individual atoms." },
  { id: "gene_engineering", name: "Gene Engineering", era: 12, needs: ["biotechnology"], effort: 28000, what: "Writing in the recipe of living things." },
  { id: "quantum_computing", name: "Quantum Computing", era: 12, needs: ["lasers", "networked_computing"], materials: ["rare_earth", "silica"], effort: 36000, what: "Arithmetic on the universe's own uncertainty." },
  { id: "weather_engineering", name: "Weather Engineering", era: 12, needs: ["satellites", "networked_computing"], effort: 31000, what: "Arguing with the sky, and sometimes winning." },
  { id: "closed_ecology", name: "Closed Ecologies", era: 12, needs: ["green_revolution", "gene_engineering"], effort: 29000, what: "A world small enough to carry." },
  { id: "life_extension", name: "Life Extension", era: 12, needs: ["gene_engineering", "medical_imaging"], effort: 35000, what: "More time." },
];

/* ------------------------------------------------------------------ *
 * The open frontier — the tree must never close
 * ------------------------------------------------------------------ */

/** Ids of the generated frontier series: `frontier_1`, `frontier_2`, … */
export const FRONTIER_ID_PREFIX = "frontier_";
/** Era of `frontier_1`; each further tier is its own, later era. */
export const FRONTIER_BASE_ERA = 13;
/** Effort of `frontier_1`, in the same research-years as authored `effort`. */
export const FRONTIER_BASE_EFFORT = 60000;
/** Each tier costs this much more than the one before — the series never
 * cheapens and never ends, so no run can finish it. */
export const FRONTIER_EFFORT_GROWTH = 1.35;
/** The authored capabilities that open the frontier. Crossing all three of the
 * speculative span's flagship walls is what "past everything we wrote down"
 * means physically. */
export const FRONTIER_ANCHORS = ["fusion_power", "orbital_industry", "artificial_minds"];

export const frontierId = (tier: number): string => `${FRONTIER_ID_PREFIX}${tier}`;

/** Parse a frontier id back to its tier, or null for anything else. */
export function frontierTier(id: string): number | null {
  if (!id.startsWith(FRONTIER_ID_PREFIX)) return null;
  const digits = id.slice(FRONTIER_ID_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  return Number(digits);
}

/** The generated frontier capability for a tier (tier >= 1). Deterministic —
 * a function of the tier alone — so a world resumed from a snapshot rebuilds
 * exactly the capabilities its civs already hold. */
export function frontierCapability(tier: number): Capability {
  return {
    id: frontierId(tier),
    name: `Frontier Science ${tier}`,
    era: FRONTIER_BASE_ERA + (tier - 1),
    needs: tier === 1 ? [...FRONTIER_ANCHORS] : [frontierId(tier - 1)],
    effort: FRONTIER_BASE_EFFORT * FRONTIER_EFFORT_GROWTH ** (tier - 1),
    what: "Past the edge of everything anyone has written down.",
  };
}

/**
 * Lookup for every capability, authored or generated. `get`/`has` resolve
 * frontier ids on demand and memoise them, so a civ resumed from a snapshot
 * holding frontier tiers this process has never seen still finds them, and
 * every consumer (holders, spread, era, event text) treats a frontier tier
 * like any other capability. Iteration only sees what has been looked up.
 */
class CapabilityIndex extends Map<string, Capability> {
  override get(id: string): Capability | undefined {
    let cap = super.get(id);
    if (!cap) {
      const tier = frontierTier(id);
      if (tier !== null) {
        cap = frontierCapability(tier);
        super.set(id, cap);
      }
    }
    return cap;
  }
  override has(id: string): boolean {
    return super.has(id) || frontierTier(id) !== null;
  }
}

export const CAPABILITY_BY_ID: Map<string, Capability> = new CapabilityIndex(
  CAPABILITIES.map((c) => [c.id, c]),
);

/** What every band starts knowing. */
export const STARTING_CAPABILITIES = ["fire", "stone_tools", "language", "foraging"];

/** The one gate check, shared by `researchable()` and its callers: could this
 * capability be worked on right now, given what the civ holds and controls? */
export function meetsGates(
  c: Capability,
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
): boolean {
  if (held.has(c.id)) return false;
  if (!c.needs.every((n) => held.has(n))) return false;
  if (c.materials && !c.materials.every(hasMaterial)) return false;
  if (c.terrain && !c.terrain.some(hasTerrain)) return false;
  if (c.minPop && population < c.minPop) return false;
  return true;
}

/** The lowest frontier tier this civ has not yet learned. Tiers are learned in
 * order (each needs the one before), so the first gap is the frontier. */
export function nextFrontierTier(held: Set<string>): number {
  let tier = 1;
  while (held.has(frontierId(tier))) tier++;
  return tier;
}

/**
 * Capabilities whose prerequisites a civilisation currently satisfies —
 * i.e. what it could plausibly work on next. Materials and terrain are checked
 * by the caller against what the civ actually controls. Always includes the
 * next frontier tier once its anchors are held, so the list never empties for
 * a civ that has learned everything authored.
 */
export function researchable(
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
): Capability[] {
  const open = CAPABILITIES.filter((c) =>
    meetsGates(c, held, hasMaterial, hasTerrain, population),
  );
  const frontier = CAPABILITY_BY_ID.get(frontierId(nextFrontierTier(held)));
  if (frontier && meetsGates(frontier, held, hasMaterial, hasTerrain, population)) {
    open.push(frontier);
  }
  return open;
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
