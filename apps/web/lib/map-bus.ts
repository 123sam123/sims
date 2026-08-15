/**
 * A one-way message from the overlay panels to the map underneath: "fly the
 * camera to this cell". Panels and the map stage are separate client islands,
 * so the channel is a DOM CustomEvent on `window` — no shared React tree
 * required, and a panel mounted before the map has data simply queues.
 *
 * Spectator rule: this moves the CAMERA only. Nothing on this channel — or
 * anywhere else in the app — can steer the world itself.
 */

export const FLY_EVENT = "aice:flyto";

export interface FlyDetail {
  cell: number;
}

/** Ask the map to fly to a grid cell. Safe to call from any client component. */
export function flyToCell(cell: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FlyDetail>(FLY_EVENT, { detail: { cell } }));
}

/** Subscribe to fly requests. Returns the unsubscribe function. */
export function onFlyTo(handler: (cell: number) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<FlyDetail>).detail;
    if (detail && Number.isFinite(detail.cell)) handler(detail.cell);
  };
  window.addEventListener(FLY_EVENT, listener);
  return () => window.removeEventListener(FLY_EVENT, listener);
}
