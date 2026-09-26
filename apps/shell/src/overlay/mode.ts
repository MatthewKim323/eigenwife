/** ?mode=overlay: the desktop companion (apps/overlay loads this). Only Eve, on a transparent page. */
export function isOverlayMode(search: string): boolean {
  return new URLSearchParams(search).get("mode") === "overlay";
}

export const OVERLAY = typeof location !== "undefined" && isOverlayMode(location.search);
