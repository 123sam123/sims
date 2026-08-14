/**
 * The world map, moved off the front page. Same live canvas renderer as before —
 * planet to locality, drawn in code from what the world actually is. View
 * controls (layer, zoom) change what you look at, never the world itself.
 */

import SiteHeader from "@/components/SiteHeader";
import WorldMap from "@/components/WorldMap";

export const dynamic = "force-dynamic";

export default function MapPage() {
  return (
    <main className="wrap">
      <SiteHeader active="map" />
      <p className="lede">
        A spectator's map — the coastlines, mountains, rivers and orefields are
        the real Earth and are fixed. Everything drawn on top — settlements,
        borders, buildings — is the civilisations' own.
      </p>
      <WorldMap />
      <p className="foot">
        A settlement is only ever drawn from materials its people can actually
        make. Nothing here can be steered; this is a window, not a control room.
        The view polls the running world and redraws when it advances.
      </p>
    </main>
  );
}
