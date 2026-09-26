import { animate, motion, useMotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { envelope, type AvatarState, type Mood } from "@eigenwife/protocol";
import { useBus, useEvent, useWorld } from "../lib/bus";
import { useScene } from "../lib/scene";
import { MicIndicator } from "../voice/MicIndicator";
import { Subtitles } from "../voice/Subtitles";
import { screenToFocus, userFocus } from "./attention";
import { loadModel, type EveLive2D } from "./live2d";
import type { FramingSlot } from "./models";
import type { RigInput } from "./rig";
import { activeModel, avatarRuntime, avatarUi, useStore, type Dock } from "./store";
import { Tachie } from "./Tachie";
import "./avatar.css";

/** Logical canvas box. She is moved/scaled with a transform, never re-laid out. */
export const BOX_W = 560;
export const BOX_H = 840;
/** Desktop: she lives in the right column. */
export const COLUMN_W = 420;
const LIVE2D_TIMEOUT_MS = 4000;

const COLUMN_SCENES = new Set(["desktop", "swarm", "architecture"]);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where her box goes for each dock, in viewport px. Width follows the box aspect. */
export function dockRect(dock: Dock, vw: number, vh: number, card: Rect | null): Rect {
  const aspect = BOX_W / BOX_H;
  if (dock === "card" && card) return card;
  if (dock === "stage") {
    const h = Math.min(vh * 0.9, 980);
    const w = h * aspect;
    return { x: (vw - w) / 2, y: vh * 0.04, w, h };
  }
  // column (also the resting place while hidden)
  const w = Math.min(COLUMN_W + 20, vw * 0.4);
  const h = w / aspect;
  return { x: vw - w + 6, y: Math.max(24, vh - h - 70), w, h };
}

function elementCenter(key: string): { x: number; y: number } | null {
  const el = document.querySelector(`[data-gaze="${CSS.escape(key)}"]`);
  if (!el || el.closest(".eve-layer")) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function swarmPoint(): { x: number; y: number } {
  const el = document.querySelector('[data-eve-look="swarm"]') ?? document.querySelector('[data-gaze^="swarm"]');
  if (el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: innerWidth * 0.35, y: innerHeight * 0.5 };
}

function useDockMotion(dock: Dock, card: Rect | null, bounce: number) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const s = useMotionValue(1);
  const first = useRef(true);
  const [vp, setVp] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: innerWidth, h: innerHeight });
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    const r = dockRect(dock, vp.w, vp.h, card);
    const target = { x: r.x, y: r.y, s: r.w / BOX_W };
    if (first.current || dock === "hidden") {
      first.current = false;
      if (dock !== "hidden" || s.get() === 1) {
        x.set(target.x);
        y.set(target.y);
        s.set(target.s);
      }
      return;
    }
    // Moving between docks: one spring for all three, critically damped
    // unless she's stepping out of the card (a little momentum reads as life).
    const opts = { type: "spring" as const, bounce, duration: 0.9 };
    const a = [animate(x, target.x, opts), animate(y, target.y, opts), animate(s, target.s, opts)];
    return () => a.forEach((c) => c.stop());
  }, [dock, card?.x, card?.y, card?.w, card?.h, vp.w, vp.h, bounce]);
  return { x, y, s };
}

/** Out of the card she still fades out at the bottom of her box, never a hard canvas edge. */
const BOTTOM_FADE = "linear-gradient(to bottom, #000 76%, transparent 98%)";

function maskFor(reveal: number): string {
  if (reveal >= 1) return BOTTOM_FADE;
  const r = Math.max(0, reveal);
  // 11deg linear: her lower body fades into the card; radial softens the edges.
  const a = 34 * (1 - r);
  const b = 58 * (1 - r) + 1;
  const e = 62 + 140 * r;
  return `linear-gradient(11deg, transparent ${a}%, #000 ${b}%), radial-gradient(ellipse ${e}% ${e * 0.85}% at 50% 32%, #000 58%, transparent 100%)`;
}

/**
 * Eve's persistent layer, above every scene. Center stage on emergence, the
 * right ~420px column on the desktop. One WebGL canvas for her whole life.
 */
export function AvatarLayer() {
  const { world } = useWorld();
  const { scene } = useScene();
  const { client } = useBus();
  const ui = useStore(avatarUi, (s) => s);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eveRef = useRef<EveLive2D | null>(null);
  const [renderer, setRenderer] = useState<"loading" | "live2d" | "tachie">("loading");

  const born = world.companion.born;
  // Dock: emergence owns it while mounted; otherwise she sits in the column once born.
  const dock: Dock = scene === "emergence" ? (ui.dock === "hidden" ? "stage" : ui.dock) : born && COLUMN_SCENES.has(scene) ? "column" : "hidden";
  const visible = dock !== "hidden";
  const placement: "stage" | "column" | "hidden" = !visible ? "hidden" : dock === "column" ? "column" : "stage";
  // How the model is framed inside the box (the overlay window uses the "overlay" slot via OverlayApp).
  // Card + stage share one so the emergence spring never reframes.
  const slot: FramingSlot = dock === "card" || dock === "stage" ? "stage" : "column";
  const { x, y, s } = useDockMotion(dock, ui.cardRect, dock === "stage" ? 0.22 : 0);

  // Effective visual state: choreography override > speaking > world state.
  const worldState: AvatarState = born ? world.companion.state : "sleeping";
  useEffect(() => {
    const upd = () => avatarUi.set({ state: avatarUi.get().stateOverride ?? (avatarRuntime.speaking ? "speaking" : worldState) });
    upd();
    const id = setInterval(upd, 100);
    return () => clearInterval(id);
  }, [worldState, ui.stateOverride]);

  // Head position on screen, for look-at mapping.
  useEffect(() => {
    avatarRuntime.slot = slot;
    eveRef.current?.setFraming(slot);
    const head = activeModel.framing[slot].head;
    const upd = () => {
      const sc = s.get();
      avatarRuntime.head = { x: x.get() + BOX_W * sc * head.x, y: y.get() + BOX_H * sc * head.y };
    };
    upd();
    const offs = [x.on("change", upd), y.on("change", upd), s.on("change", upd)];
    return () => offs.forEach((o) => o());
  }, [x, y, s, slot]);

  // Acting: eyes on the swarm.
  useEffect(() => {
    avatarRuntime.attention.hold(ui.state === "acting" ? swarmPoint() : null);
  }, [ui.state, scene]);

  // --- bus ---------------------------------------------------------------------
  useEvent("avatar.mood", (e) => avatarRuntime.rig.setMood(e.data.mood, e.data.intensity ?? 0.8, performance.now(), e.data.holdMs));
  useEvent("avatar.look", (e) => {
    const p = e.data.targetKey ? elementCenter(e.data.targetKey) : null;
    avatarRuntime.attention.look(p, e.data.ms, performance.now());
  });
  useEvent("gaze.target", (e) => {
    const t = e.data.target;
    if (!t || t.kind === "avatar") return;
    avatarRuntime.attention.onUserTarget(t.key, elementCenter(t.key), performance.now());
  });

  // --- renderer: Live2D, or the tachie fallback after 4s -------------------------
  useEffect(() => {
    if (new URLSearchParams(location.search).get("eve") === "tachie") {
      setRenderer("tachie");
      return;
    }
    let eve: EveLive2D | null = null;
    let dead = false;
    const fallback = (why: unknown) => {
      if (dead || (why === "timeout" && eve)) return;
      console.warn("[avatar] live2d unavailable, using tachie fallback:", why);
      setRenderer("tachie");
    };
    const timer = setTimeout(() => fallback("timeout"), LIVE2D_TIMEOUT_MS);
    const getInput = (): RigInput => {
      const now = performance.now();
      const look = avatarRuntime.attention.current(now);
      const head = avatarRuntime.head;
      const focus = look.kind === "user" ? userFocus(head, innerWidth) : screenToFocus(look, head, innerWidth, innerHeight);
      const r = avatarRuntime;
      return {
        state: avatarUi.get().state,
        focus,
        mouth: r.mouthOverride ?? r.mouth,
        mouthHold: r.mouthOverride === null && r.mouthHold,
        still: r.still,
        eyesClosed: r.eyesClosed,
      };
    };
    loadModel(activeModel, canvasRef.current!, { width: BOX_W, height: BOX_H }, getInput, fallback, avatarRuntime.slot)
      .then((e) => {
        if (dead) return e.destroy();
        clearTimeout(timer);
        eve = e;
        eveRef.current = e;
        e.setFraming(avatarRuntime.slot, true);
        // Even if the tachie already covered a slow load, upgrade to the real thing.
        setRenderer("live2d");
      })
      .catch(fallback);
    return () => {
      dead = true;
      clearTimeout(timer);
      eve?.destroy();
      eveRef.current = null;
    };
  }, []);
  useEffect(() => avatarUi.set({ renderer }), [renderer]);

  // Debug / capture handle: window.__eve.
  useEffect(() => {
    (globalThis as any).__eve = {
      mood: (m: Mood, i = 1, holdMs = 60_000) => avatarRuntime.rig.setMood(m, i, performance.now(), holdMs),
      state: (st: AvatarState | null) => avatarUi.set({ stateOverride: st }),
      look: (px: number, py: number, ms = 800) => avatarRuntime.attention.look({ x: px, y: py }, ms, performance.now()),
      blink: () => avatarRuntime.rig.blink.trigger(performance.now()),
      say: (text: string, mood?: Mood) => {
        const id = `dbg_${Date.now()}`;
        const d = (t: any, data: any) => client.dispatch(envelope(t, data, "shell") as any);
        d("speech.begin", { utteranceId: id, text, brain: "debug" });
        d("speech.segment", { utteranceId: id, seq: 0, text, marks: mood ? [{ at: 0, mood, intensity: 0.9 }] : [] });
        d("speech.end", { utteranceId: id, interrupted: false });
      },
      /** Stop whatever she's saying (local only). */
      hush: () => client.dispatch(envelope("speech.stop", { reason: "debug" }, "shell")),
      /** Freeze saccades/sway/blinks, optionally shut eyes / hold the mouth open. For tachie capture. */
      still: (on = true, eyesClosed = false, mouth: number | null = null) => {
        avatarRuntime.still = on;
        avatarRuntime.eyesClosed = eyesClosed;
        avatarRuntime.mouthOverride = mouth;
      },
      runtime: avatarRuntime,
      model: activeModel.id,
      /** Reframe her inside the box (capture): "column" | "stage" | "overlay". */
      frame: (slot: FramingSlot) => eveRef.current?.setFraming(slot, true),
    };
  }, [client]);

  const mask = maskFor(ui.reveal);
  return (
    <div className="eve-layer" aria-hidden={!visible}>
      <motion.div
        className="eve-box"
        data-state={ui.state}
        data-dock={dock}
        data-glitch={ui.glitch}
        style={{
          x,
          y,
          scale: s,
          width: BOX_W,
          height: BOX_H,
          opacity: visible ? 1 : 0,
          maskImage: mask,
          WebkitMaskImage: mask,
          maskComposite: ui.reveal < 1 ? "intersect" : undefined,
          WebkitMaskComposite: ui.reveal < 1 ? "source-in" : undefined,
        } as any}
      >
        <div className="eve-aura" />
        <div className="eve-ear" />
        <canvas ref={canvasRef} className="eve-canvas" data-renderer={renderer} style={{ opacity: renderer === "live2d" ? 1 : 0 }} />
        {renderer === "tachie" && <Tachie />}
        <ThinkingDots />
      </motion.div>
      <Subtitles placement={placement} />
      <MicIndicator placement={placement} />
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="eve-thinking" aria-hidden>
      <i />
      <i />
      <i />
    </div>
  );
}
