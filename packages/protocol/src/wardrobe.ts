/**
 * Eve's wardrobe catalog: what she can wear, independent of the avatar model.
 * The shell's model registry maps each item to a model expression (a model
 * that lacks an item just doesn't list it); the core owns what she has on.
 * Items in the same slot are exclusive, `conflicts` adds cross-slot exclusions.
 * Pure data + pure functions, shared by core and shell.
 */

export type WardrobeSlot = "top" | "eyes" | "face" | "eyewear" | "prop";

export interface WardrobeItemInfo {
  id: string;
  /** Spoken / menu label, lowercase: "cat hoodie". */
  label: string;
  slot: WardrobeSlot;
  conflicts?: string[];
}

export const WARDROBE_ITEMS: Record<string, WardrobeItemInfo> = {
  hoodie: { id: "hoodie", label: "cat hoodie", slot: "top" },
  hood_up: { id: "hood_up", label: "cat hoodie, hood up", slot: "top" },
  sunglasses: { id: "sunglasses", label: "sunglasses", slot: "eyewear" },
  sunglasses_up: { id: "sunglasses_up", label: "sunglasses pushed up", slot: "eyewear" },
  lollipop: { id: "lollipop", label: "lollipop", slot: "prop" },
  odd_eye_left: { id: "odd_eye_left", label: "violet left eye", slot: "eyes", conflicts: ["odd_eye_right"] },
  odd_eye_right: { id: "odd_eye_right", label: "violet right eye", slot: "eyes", conflicts: ["odd_eye_left"] },
};

export interface WearChange {
  add?: string[];
  remove?: string[];
}

/** Does `b` have to come off when `a` goes on (same slot, or an explicit conflict either way)? */
export function clashes(a: string, b: string, catalog: Record<string, WardrobeItemInfo> = WARDROBE_ITEMS): boolean {
  if (a === b) return false;
  const x = catalog[a];
  const y = catalog[b];
  if (!x || !y) return false;
  return x.slot === y.slot || !!x.conflicts?.includes(b) || !!y.conflicts?.includes(a);
}

/**
 * Apply a change to what she has on. Removals first, then each add in order
 * takes off anything it clashes with (the later add wins). Unknown ids, and ids
 * outside `allowed` (the active model's wardrobe) when given, are dropped.
 * Result is in catalog order so it's stable to compare and persist.
 */
export function applyWear(current: string[], change: WearChange, catalog: Record<string, WardrobeItemInfo> = WARDROBE_ITEMS, allowed?: Iterable<string>): string[] {
  const ok = allowed ? new Set(allowed) : null;
  const valid = (id: string) => !!catalog[id] && (!ok || ok.has(id));
  const remove = new Set(change.remove ?? []);
  let on = current.filter((id) => valid(id) && !remove.has(id));
  for (const id of change.add ?? []) {
    if (!valid(id)) continue;
    on = on.filter((x) => x !== id && !clashes(id, x, catalog));
    on.push(id);
  }
  const order = Object.keys(catalog);
  return [...new Set(on)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** "cat hoodie, sunglasses", or "her usual clothes, nothing extra" when she wears nothing from the wardrobe. */
export function describeOutfit(items: string[], catalog: Record<string, WardrobeItemInfo> = WARDROBE_ITEMS): string {
  const labels = items.map((id) => catalog[id]?.label).filter(Boolean);
  return labels.length ? labels.join(", ") : "her usual clothes, nothing extra";
}
