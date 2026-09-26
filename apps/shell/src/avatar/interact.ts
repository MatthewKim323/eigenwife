import { useEffect, useRef } from "react";
import { useBus, useEvent, useWorld } from "../lib/bus";
import { screenToFocus } from "./attention";
import { clampFocus, type LookChoice } from "./look";
import type { FramingSlot } from "./models";
import type { Focus } from "./rig";
import { activeModel, avatarRuntime, avatarUi } from "./store";
import { headEllipse, HoverLimiter, playTouch, PokeCounter, regionAt, type Box, type Pt, type TouchEvent } from "./touch";

/**
 * Glue between the bus / pointer and the rig for outfits (wardrobe.ts), where
 * she looks (look.ts) and touch (touch.ts). Used by both the shell's
 * AvatarLayer and the OverlayApp.
 */

/** Outfit from the core: the world snapshot on connect, then avatar.outfit. Tells the core which items this model can show. */
export function useWardrobeSync() {
  const { world, connected } = useWorld();
  const { client } = useBus();
  const items = world.slots.wardrobe?.items;
  useEffect(() => {
    if (items !== undefined) avatarRuntime.rig.setOutfit(items ? items.split(",") : [], performance.now());
  }, [items]);
  useEvent("avatar.outfit", (e) => avatarRuntime.rig.setOutfit(e.data.items, performance.now()));
  useEffect(() => {
    if (connected) client.emit("avatar.model", { id: activeModel.id, wardrobe: Object.keys(activeModel.wardrobe) });
  }, [connected, client]);
  useEffect(() => {
    const g = globalThis as any;
    g.__eve ??= {};
    /** Local only (capture / debug): put these items on her. The core's next avatar.outfit still wins. */
    g.__eve.wear = (list: string[] | string = []) => avatarRuntime.rig.setOutfit(typeof list === "string" ? list.split(",").filter(Boolean) : list, performance.now());
    g.__eve.wearing = () => avatarRuntime.rig.wardrobe.wearing();
    /** Play a touch reaction locally (capture): "pat" | "poke" | "annoyed" | "smile" | "hm" | "drag-start" | "drop". */
    g.__eve.touch = (kind: string) => {
      const now = performance.now();
      const ev: TouchEvent =
        kind === "smile" || kind === "hm"
          ? { kind: "hover", reaction: kind }
          : kind === "drag-start" || kind === "drop"
            ? { kind }
            : { kind: kind as "pat" | "poke" | "annoyed", region: kind === "pat" ? "head" : "body", count: 1, emit: false };
      playTouch(ev, avatarRuntime.rig, now, (ms) => avatarRuntime.attention.look(avatarRuntime.head, ms, now));
    };
  }, []);
}

/** Real gaze points from the bus (eye serve / a tracker) feed the look arbiter. `toSpace` maps them into its space. */
export function useGazeFeed(toSpace: (p: Pt) => Pt = (p) => p) {
  useEvent("gaze.point", (e) => avatarRuntime.look.gaze(toSpace({ x: e.data.x, y: e.data.y }), performance.now()));
  useEvent("gaze.lost", () => avatarRuntime.look.clearGaze());
}

export interface LookSpace {
  /** Page (client) px -> the arbiter's space (identity in the shell, + window origin in the overlay). */
  fromPage(p: Pt): Pt;
  /** Her head in the arbiter's space. */
  head: Pt;
  /** Extent of the space (a half extent away = a full turn). */
  size: { w: number; h: number };
  /** Looking at the user (out of the screen toward the camera). */
  user(): Focus;
}

/** Arbitrate this frame's look target and map it into focus space. */
export function resolveFocus(now: number, space: LookSpace): { focus: Focus; headGain: number; choice: LookChoice } {
  const att = avatarRuntime.attention.current(now);
  const choice = avatarRuntime.look.resolve(now, {
    glance: att.kind === "point" ? space.fromPage(att) : null,
    head: space.head,
    spread: { x: space.size.w * 0.2, y: space.size.h * 0.15 },
  });
  if (!choice.point) return { focus: space.user(), headGain: choice.headGain, choice };
  const f = screenToFocus(choice.point, space.head, space.size.w, space.size.h);
  const tracked = choice.kind === "cursor" || choice.kind === "gaze" || choice.kind === "idle-glance";
  return { focus: tracked ? clampFocus(f) : f, headGain: choice.headGain, choice };
}

export interface TouchController {
  /** Pointer went onto her pixels. */
  enter(): void;
  /** A click (not a drag). Returns the region it hit, or null. */
  click(p: Pt, box: Box, painted: boolean): "head" | "body" | null;
  dragStart(): void;
  drop(): void;
}

/** Everything is rate limited and subtle; asleep, she doesn't react at all. */
export function createTouchController(slot: FramingSlot, emitPoke: (region: "head" | "body", count: number) => void): TouchController {
  const hover = new HoverLimiter();
  const pokes = new PokeCounter();
  const f = () => activeModel.framing[slot];
  const asleep = () => avatarUi.get().state === "sleeping";
  const head = (box: Box) => headEllipse(box, f().head, f().scale, activeModel.headShape);
  const lookAt = (p: Pt) => (ms: number) => avatarRuntime.attention.look(p, ms, performance.now());
  return {
    enter() {
      if (asleep()) return;
      const now = performance.now();
      const r = hover.enter(now);
      if (r) playTouch({ kind: "hover", reaction: r }, avatarRuntime.rig, now, () => {});
    },
    click(p, box, painted) {
      if (asleep()) return null;
      const region = regionAt(p, head(box), painted);
      if (!region) return null;
      const now = performance.now();
      const r = pokes.click(region, now);
      if (!r) return region;
      playTouch(r, avatarRuntime.rig, now, lookAt(p));
      if (r.emit) emitPoke(r.region, r.count);
      return region;
    },
    dragStart() {
      if (!asleep()) playTouch({ kind: "drag-start" }, avatarRuntime.rig, performance.now(), () => {});
    },
    drop() {
      if (!asleep()) playTouch({ kind: "drop" }, avatarRuntime.rig, performance.now(), () => {});
    },
  };
}

/** A stable touch controller for a component, emitting avatar.poke on the bus. */
export function useTouchController(slot: FramingSlot): TouchController {
  const { client } = useBus();
  const ref = useRef<TouchController | null>(null);
  ref.current ??= createTouchController(slot, (region, count) => client.emit("avatar.poke", { region, count }));
  return ref.current;
}
