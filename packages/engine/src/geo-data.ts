/**
 * Real Earth features, placed at their real coordinates.
 *
 * Coastlines come from Natural Earth (the `world-atlas` package) and are
 * rasterised at worldgen. Everything in this file is the stuff Natural Earth
 * doesn't carry: mountain ranges, major rivers, and where the ore actually is.
 *
 * Coordinates are [lat, lon]. Positions are deliberately coarse — one grid cell
 * is ~111km, so a range or an orefield only needs to land in the right region.
 *
 * Nothing human-made appears here. No cities, no borders, no names of nations.
 * That is entirely the civilisations' business.
 */

export type LatLon = [number, number];

/** Mountain ranges as ridge polylines. Drives elevation, rainfall shadow, movement cost. */
export const RANGES: { name: string; height: number; path: LatLon[] }[] = [
  { name: "Himalaya", height: 1.0, path: [[35, 74], [32, 78], [28, 84], [27, 92]] },
  { name: "Karakoram", height: 0.95, path: [[36, 75], [35, 77]] },
  { name: "Hindu Kush", height: 0.8, path: [[36, 71], [34, 69]] },
  { name: "Kunlun", height: 0.85, path: [[36, 80], [35, 88], [37, 94]] },
  { name: "Tien Shan", height: 0.8, path: [[43, 74], [42, 80], [43, 86]] },
  { name: "Altai", height: 0.7, path: [[50, 86], [48, 90]] },
  { name: "Andes", height: 0.95, path: [[10, -73], [0, -78], [-15, -70], [-33, -70], [-45, -72], [-53, -72]] },
  { name: "Rockies", height: 0.8, path: [[60, -133], [52, -120], [45, -111], [39, -106], [33, -108]] },
  { name: "Sierra Nevada", height: 0.7, path: [[40, -121], [36, -118]] },
  { name: "Sierra Madre Occidental", height: 0.7, path: [[29, -108], [23, -104], [19, -100]] },
  { name: "Appalachians", height: 0.4, path: [[46, -70], [41, -76], [37, -80], [34, -84]] },
  { name: "Alps", height: 0.8, path: [[45, 6], [46, 9], [47, 12], [47, 15]] },
  { name: "Pyrenees", height: 0.6, path: [[43, -1], [42, 1], [42, 3]] },
  { name: "Carpathians", height: 0.55, path: [[49, 19], [47, 23], [45, 25]] },
  { name: "Scandes", height: 0.5, path: [[69, 20], [65, 15], [61, 9], [59, 7]] },
  { name: "Urals", height: 0.45, path: [[68, 66], [62, 60], [55, 59], [51, 58]] },
  { name: "Caucasus", height: 0.75, path: [[44, 40], [42, 44], [41, 47]] },
  { name: "Zagros", height: 0.7, path: [[37, 45], [33, 48], [29, 52], [27, 57]] },
  { name: "Elburz", height: 0.7, path: [[36, 51], [36, 55]] },
  { name: "Atlas", height: 0.6, path: [[33, -6], [32, -2], [34, 4], [36, 8]] },
  { name: "Ethiopian Highlands", height: 0.65, path: [[14, 38], [10, 38], [7, 39]] },
  { name: "Drakensberg", height: 0.55, path: [[-26, 30], [-29, 29], [-32, 28]] },
  { name: "Great Dividing", height: 0.5, path: [[-17, 145], [-25, 149], [-31, 151], [-37, 147]] },
  { name: "Southern Alps", height: 0.6, path: [[-43, 170], [-45, 168]] },
  { name: "Japanese Alps", height: 0.55, path: [[37, 138], [35, 138]] },
  { name: "Taurus", height: 0.6, path: [[37, 30], [37, 35], [38, 40]] },
  { name: "Apennines", height: 0.45, path: [[44, 10], [42, 13], [40, 16]] },
  { name: "Balkans", height: 0.5, path: [[43, 20], [42, 23], [41, 21]] },
  { name: "Verkhoyansk", height: 0.5, path: [[67, 130], [63, 133]] },
  { name: "Brooks", height: 0.5, path: [[68, -150], [68, -145]] },
];

/** Major rivers, mouth → headwaters. Drives fresh water, fertility, movement. */
export const RIVERS: { name: string; flow: number; path: LatLon[] }[] = [
  { name: "Nile", flow: 0.8, path: [[31, 31], [27, 31], [24, 33], [18, 33], [15, 32], [9, 32], [2, 32]] },
  { name: "Amazon", flow: 1.0, path: [[-1, -50], [-2, -55], [-3, -60], [-4, -66], [-4, -73]] },
  { name: "Congo", flow: 0.9, path: [[-6, 12], [-4, 16], [-2, 19], [0, 23], [2, 27]] },
  { name: "Mississippi", flow: 0.8, path: [[29, -89], [33, -91], [37, -89], [41, -91], [45, -93]] },
  { name: "Missouri", flow: 0.6, path: [[39, -91], [41, -96], [45, -101], [47, -110]] },
  { name: "Yangtze", flow: 0.9, path: [[31, 121], [30, 117], [30, 112], [30, 107], [29, 104]] },
  { name: "Yellow", flow: 0.7, path: [[38, 119], [36, 116], [35, 113], [37, 110], [36, 104]] },
  { name: "Ganges", flow: 0.8, path: [[22, 90], [24, 87], [25, 83], [27, 80], [30, 78]] },
  { name: "Brahmaputra", flow: 0.7, path: [[23, 90], [26, 91], [27, 94], [29, 95]] },
  { name: "Indus", flow: 0.6, path: [[24, 67], [26, 68], [29, 71], [32, 72], [35, 74]] },
  { name: "Mekong", flow: 0.7, path: [[10, 106], [13, 105], [16, 105], [20, 102], [23, 99]] },
  { name: "Danube", flow: 0.7, path: [[45, 29], [44, 25], [45, 20], [48, 17], [48, 12], [48, 9]] },
  { name: "Rhine", flow: 0.5, path: [[52, 4], [51, 6], [50, 7], [48, 8], [47, 9]] },
  { name: "Volga", flow: 0.7, path: [[46, 48], [49, 46], [52, 48], [56, 44], [58, 39]] },
  { name: "Dnieper", flow: 0.5, path: [[46, 32], [49, 34], [52, 31], [55, 32]] },
  { name: "Niger", flow: 0.7, path: [[5, 6], [9, 6], [13, 1], [15, -4], [12, -8], [10, -11]] },
  { name: "Zambezi", flow: 0.6, path: [[-18, 36], [-17, 31], [-16, 27], [-13, 23]] },
  { name: "Euphrates", flow: 0.6, path: [[30, 48], [32, 45], [35, 41], [37, 38]] },
  { name: "Tigris", flow: 0.5, path: [[31, 47], [33, 44], [36, 42], [38, 40]] },
  { name: "Ob", flow: 0.7, path: [[66, 69], [61, 69], [57, 74], [54, 82]] },
  { name: "Yenisei", flow: 0.7, path: [[71, 83], [66, 87], [58, 92], [53, 92]] },
  { name: "Lena", flow: 0.6, path: [[72, 127], [66, 124], [60, 121], [54, 108]] },
  { name: "Amur", flow: 0.6, path: [[53, 141], [50, 137], [49, 128], [50, 119]] },
  { name: "Parana", flow: 0.7, path: [[-34, -58], [-30, -59], [-25, -55], [-20, -51]] },
  { name: "Orinoco", flow: 0.6, path: [[9, -61], [8, -65], [6, -67], [4, -68]] },
  { name: "Murray", flow: 0.4, path: [[-35, 139], [-34, 142], [-34, 146], [-36, 148]] },
  { name: "Rio Grande", flow: 0.3, path: [[26, -97], [29, -101], [31, -106], [35, -106]] },
  { name: "Elbe", flow: 0.4, path: [[54, 9], [53, 11], [51, 14], [50, 14]] },
  { name: "Vistula", flow: 0.4, path: [[54, 19], [52, 21], [50, 20]] },
  { name: "Loire", flow: 0.35, path: [[47, -2], [47, 1], [47, 3]] },
  { name: "Po", flow: 0.35, path: [[45, 12], [45, 10], [45, 8]] },
  { name: "Irrawaddy", flow: 0.6, path: [[16, 95], [20, 95], [24, 96]] },
  { name: "Sao Francisco", flow: 0.4, path: [[-10, -36], [-9, -40], [-15, -44], [-18, -45]] },
  { name: "Colorado", flow: 0.3, path: [[32, -115], [35, -114], [37, -111], [40, -108]] },
  { name: "Columbia", flow: 0.5, path: [[46, -124], [46, -120], [48, -118], [51, -118]] },
  { name: "Saint Lawrence", flow: 0.6, path: [[49, -67], [47, -71], [45, -74], [44, -76]] },
];

export type ResourceKind =
  | "iron"
  | "copper"
  | "tin"
  | "coal"
  | "oil"
  | "gold"
  | "silver"
  | "uranium";

/**
 * Real orefields. `richness` is relative abundance, `depth` gates which
 * capability a civilisation needs before it can even find the deposit —
 * surface copper is visible to anyone, Ghawar oil is not.
 */
export const DEPOSITS: {
  kind: ResourceKind;
  name: string;
  at: LatLon;
  richness: number;
  depth: number;
}[] = [
  // Iron
  { kind: "iron", name: "Kiruna", at: [67, 20], richness: 0.9, depth: 0.4 },
  { kind: "iron", name: "Pilbara", at: [-22, 118], richness: 1.0, depth: 0.2 },
  { kind: "iron", name: "Carajas", at: [-6, -50], richness: 1.0, depth: 0.3 },
  { kind: "iron", name: "Krivoy Rog", at: [48, 33], richness: 0.8, depth: 0.3 },
  { kind: "iron", name: "Mesabi", at: [47, -92], richness: 0.8, depth: 0.2 },
  { kind: "iron", name: "Anshan", at: [41, 123], richness: 0.7, depth: 0.3 },
  { kind: "iron", name: "Singhbhum", at: [23, 85], richness: 0.7, depth: 0.2 },
  { kind: "iron", name: "Lorraine", at: [49, 6], richness: 0.6, depth: 0.3 },
  { kind: "iron", name: "Bilbao", at: [43, -3], richness: 0.5, depth: 0.2 },
  { kind: "iron", name: "Wadi Halfa", at: [22, 31], richness: 0.4, depth: 0.3 },
  // Copper
  { kind: "copper", name: "Chuquicamata", at: [-22, -69], richness: 1.0, depth: 0.3 },
  { kind: "copper", name: "Copperbelt", at: [-12, 28], richness: 0.9, depth: 0.3 },
  { kind: "copper", name: "Bingham", at: [40, -112], richness: 0.7, depth: 0.4 },
  { kind: "copper", name: "Morenci", at: [33, -109], richness: 0.7, depth: 0.3 },
  { kind: "copper", name: "Cyprus", at: [35, 33], richness: 0.5, depth: 0.1 },
  { kind: "copper", name: "Timna", at: [30, 35], richness: 0.4, depth: 0.1 },
  { kind: "copper", name: "Rio Tinto", at: [38, -6], richness: 0.6, depth: 0.1 },
  { kind: "copper", name: "Great Lakes Native Copper", at: [47, -88], richness: 0.5, depth: 0.05 },
  { kind: "copper", name: "Ergani", at: [38, 40], richness: 0.4, depth: 0.15 },
  // Tin — the bronze-age bottleneck; deliberately rare and scattered
  { kind: "tin", name: "Cornwall", at: [50, -5], richness: 0.7, depth: 0.2 },
  { kind: "tin", name: "Malaya", at: [4, 101], richness: 0.9, depth: 0.15 },
  { kind: "tin", name: "Bolivian Altiplano", at: [-19, -66], richness: 0.8, depth: 0.3 },
  { kind: "tin", name: "Erzgebirge", at: [50, 13], richness: 0.5, depth: 0.25 },
  { kind: "tin", name: "Jos Plateau", at: [10, 9], richness: 0.5, depth: 0.2 },
  { kind: "tin", name: "Yunnan", at: [23, 103], richness: 0.6, depth: 0.25 },
  // Coal
  { kind: "coal", name: "Appalachian", at: [38, -81], richness: 1.0, depth: 0.4 },
  { kind: "coal", name: "Ruhr", at: [51, 7], richness: 0.9, depth: 0.5 },
  { kind: "coal", name: "Silesia", at: [50, 19], richness: 0.8, depth: 0.5 },
  { kind: "coal", name: "Donbas", at: [48, 38], richness: 0.8, depth: 0.5 },
  { kind: "coal", name: "Shanxi", at: [37, 112], richness: 1.0, depth: 0.4 },
  { kind: "coal", name: "Northumberland", at: [55, -1], richness: 0.7, depth: 0.35 },
  { kind: "coal", name: "Kuzbass", at: [54, 86], richness: 0.9, depth: 0.5 },
  { kind: "coal", name: "Hunter Valley", at: [-32, 151], richness: 0.7, depth: 0.35 },
  { kind: "coal", name: "Damodar", at: [24, 86], richness: 0.6, depth: 0.4 },
  // Oil — deep; nobody finds this without serious capability
  { kind: "oil", name: "Ghawar", at: [25, 49], richness: 1.0, depth: 0.9 },
  { kind: "oil", name: "Permian", at: [32, -102], richness: 0.9, depth: 0.85 },
  { kind: "oil", name: "Baku", at: [40, 50], richness: 0.7, depth: 0.6 },
  { kind: "oil", name: "West Siberia", at: [61, 73], richness: 0.9, depth: 0.9 },
  { kind: "oil", name: "Niger Delta", at: [5, 6], richness: 0.7, depth: 0.85 },
  { kind: "oil", name: "Maracaibo", at: [10, -71], richness: 0.8, depth: 0.8 },
  { kind: "oil", name: "North Sea", at: [58, 1], richness: 0.7, depth: 0.95 },
  { kind: "oil", name: "Daqing", at: [46, 125], richness: 0.6, depth: 0.85 },
  // Gold & silver
  { kind: "gold", name: "Witwatersrand", at: [-26, 27], richness: 1.0, depth: 0.6 },
  { kind: "gold", name: "Sierra Nevada Placers", at: [39, -121], richness: 0.6, depth: 0.1 },
  { kind: "gold", name: "Kalgoorlie", at: [-31, 121], richness: 0.7, depth: 0.4 },
  { kind: "gold", name: "Klondike", at: [64, -139], richness: 0.5, depth: 0.15 },
  { kind: "gold", name: "Ashanti", at: [6, -2], richness: 0.6, depth: 0.2 },
  { kind: "gold", name: "Nubian Desert", at: [20, 34], richness: 0.5, depth: 0.2 },
  { kind: "silver", name: "Potosi", at: [-19, -65], richness: 1.0, depth: 0.35 },
  { kind: "silver", name: "Zacatecas", at: [23, -102], richness: 0.8, depth: 0.35 },
  { kind: "silver", name: "Laurion", at: [38, 24], richness: 0.4, depth: 0.25 },
  // Uranium
  { kind: "uranium", name: "Athabasca", at: [58, -104], richness: 1.0, depth: 0.8 },
  { kind: "uranium", name: "Olympic Dam", at: [-30, 137], richness: 0.9, depth: 0.85 },
  { kind: "uranium", name: "Shu-Sarysu", at: [44, 68], richness: 0.9, depth: 0.75 },
  { kind: "uranium", name: "Arlit", at: [18, 7], richness: 0.6, depth: 0.7 },
  { kind: "uranium", name: "Erzgebirge Pitchblende", at: [50, 12], richness: 0.4, depth: 0.7 },
];

/**
 * Where the five bands wake up.
 *
 * Deliberately NOT the historical cradles — no Fertile Crescent, no Nile, no
 * Indus, no Yellow River, no Valley of Mexico. If they build a river-valley
 * empire it should be because they walked there, not because we put them there.
 */
export const START_SITES: { key: string; at: LatLon }[] = [
  { key: "aquitaine", at: [44, 0] },
  { key: "greatlakes", at: [43, -84] },
  { key: "zambezi", at: [-17, 30] },
  { key: "deccan", at: [18, 78] },
  { key: "honshu", at: [35, 137] },
];
