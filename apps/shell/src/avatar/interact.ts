import { useEffect, useRef } from "react";
import { useBus, useEvent, useWorld } from "../lib/bus";
import type { FramingSlot } from "./models";
import { activeModel, avatarRuntime, avatarUi } from "./store";
import { bodyRect, CursorWatch, distToRect, headEllipse, HoverLimiter, playTouch, PokeCounter, regionAt, TOUCH, type Box, type Pt, type TouchEvent } from "./touch";

/**
 * Glue between the bus / pointer and the rig for outfits (wardrobe.ts) and
 * touch (touch.ts). Used by both the shell's AvatarLayer and the OverlayApp.
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
    /** Local only (capture / debug): put these items on her. The core's avatar.outfit still wins on the next change. */
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

export interface TouchController {
  /** Pointer moved (page px). painted = her pixels are under it. */
  move(p: Pt | null, box: Box, painted: boolean): void;
  /** Pointer went onto her pixels. */
  enter(): void;
  /** A click (not a drag). Returns the region it hit, or null. */
  click(p: Pt, box: Box, painted: boolean): "head" | "body" | null;
  dragStart(): void;
  drop(): void;
}

/** Everything is rate limited and subtle; asleep, she doesn't react at all. */
export function createTouchController(slot: FramingSlot, emitPoke: (region: "head" | "body", count: number) => void): TouchController {
  const watch = new CursorWatch();
  const hover = new HoverLimiter();
  const pokes = new PokeCounter();
  const f = () => activeModel.framing[slot];
  const asleep = () => avatarUi.get().state === "sleeping";
  const head = (box: Box) => headEllipse(box, f().head, f().scale, activeModel.headShape);
  const look = (p: Pt) => (ms: number) => avatarRuntime.attention.look(p, ms, performance.now());
  let followTimer: ReturnType<typeof setInterval> | null = null;
  const sync = () => {
    const pt = asleep() ? null : watch.follow(performance.now());
    avatarRuntime.attention.follow(pt);
    if (!pt && followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
  };
  return {
    move(p, box, painted) {
      const now = performance.now();
      if (p) {
        const h = head(box);
        const near = painted || distToRect(p, bodyRect(h, box)) <= TOUCH.nearPx;
        watch.update(p, near, now);
      }
      sync();
      // Keep checking so she lets go ~1s after the cursor leaves, without more moves.
      followTimer ??= setInterval(sync, 200);
    },
    enter() {
      if (asleep()) return;
      const r = hover.enter(performance.now());
      if (r) playTouch({ kind: "hover", reaction: r }, avatarRuntime.rig, performance.now(), look(watch.follow(performance.now()) ?? avatarRuntime.head));
    },
    click(p, box, painted) {
      if (asleep()) return null;
      const region = regionAt(p, head(box), painted);
      if (!region) return null;
      const now = performance.now();
      const r = pokes.click(region, now);
      if (!r) return region;
      playTouch(r, avatarRuntime.rig, now, look(p));
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
