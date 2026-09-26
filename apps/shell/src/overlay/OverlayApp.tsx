import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { AvatarState } from "@eigenwife/protocol";
import { screenToFocus, userFocus } from "../avatar/attention";
import { HEAD_IN_BOX, loadEve, type EveLive2D } from "../avatar/live2d";
import type { RigInput } from "../avatar/rig";
import { avatarRuntime, avatarUi, useStore } from "../avatar/store";
import { Tachie } from "../avatar/Tachie";
import { animateHue } from "../lib/hue";
import { useBus, useEvent, useWorld } from "../lib/bus";
import { micLevel } from "../voice/ears";
import { Subtitles } from "../voice/Subtitles";
import { voice, voiceUi } from "../voice/VoiceProvider";
import { bridge, inElectron } from "./bridge";
import { ClickThroughGate, containRect, fitBox, hitAlpha, TAP_SLOP, type Box } from "./hittest";
import { chipFor, triggerLabel } from "./status";
import "../avatar/avatar.css";
import "./overlay.css";

/** Her logical canvas box, same as the shell's layer. */
const BOX_W = 560;
const BOX_H = 840;
const LIVE2D_TIMEOUT_MS = 4000;
const FLASH_MS = 2800;

interface Flash {
  id: number;
  kind: "memory" | "attention" | "saved";
  text: string;
}

/**
 * ?mode=overlay: Eve alone on a transparent page, for the Electron desktop
 * companion. Her pixels take the mouse (drag to move her); everything else
 * clicks through to the real apps underneath.
 */
export function OverlayApp() {
  const { world, connected } = useWorld();
  const born = world.companion.born;
  const [vp, setVp] = useState({ w: innerWidth, h: innerHeight });
  const box = fitBox(vp.w, vp.h, BOX_W, BOX_H);
  const boxRef = useRef<Box>(box);
  boxRef.current = box;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | WebGL2RenderingContext | null>(null);
  const tachieRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<"loading" | "live2d" | "tachie">("loading");
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const state = useStore(avatarUi, (s) => s.state);
  const [cursor, setCursor] = useState<"none" | "grab" | "grabbing">("none");
  const [attentionPaused, setAttentionPaused] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.mode = "overlay";
    const on = () => setVp({ w: innerWidth, h: innerHeight });
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);

  // Her color, restored from the core on welcome / birth.
  const hue = world.companion.persona?.palette.hue;
  useEffect(() => {
    if (hue !== undefined) void animateHue(hue, 900);
  }, [hue]);

  // Effective state: speaking beats the world; unborn or offline = asleep.
  const worldState: AvatarState = born && connected ? world.companion.state : "sleeping";
  useEffect(() => {
    const upd = () => avatarUi.set({ state: avatarRuntime.speaking ? "speaking" : worldState });
    upd();
    const id = setInterval(upd, 100);
    return () => clearInterval(id);
  }, [worldState]);

  // Head position for look-at, in page px.
  useEffect(() => {
    avatarRuntime.head = { x: box.x + box.w * HEAD_IN_BOX.x, y: box.y + box.h * HEAD_IN_BOX.y };
  }, [box.x, box.y, box.w, box.h]);

  useEvent("avatar.mood", (e) => avatarRuntime.rig.setMood(e.data.mood, e.data.intensity ?? 0.8, performance.now(), e.data.holdMs));
  useEvent("attention.pause", (e) => setAttentionPaused(e.data.paused));

  // --- renderer: Live2D with a readable drawing buffer, tachie fallback ---------
  useEffect(() => {
    if (new URLSearchParams(location.search).get("eve") === "tachie") {
      setRenderer("tachie");
      return;
    }
    const canvas = canvasRef.current!;
    // Claim the context first with preserveDrawingBuffer so hit tests can read
    // her pixels between frames. Pixi's later getContext returns this one.
    const attrs = { alpha: true, antialias: true, premultipliedAlpha: true, stencil: true, preserveDrawingBuffer: true, powerPreference: "high-performance" as const };
    glRef.current = (canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null) ?? (canvas.getContext("webgl", attrs) as WebGLRenderingContext | null);
    let eve: EveLive2D | null = null;
    let dead = false;
    const fallback = (why: unknown) => {
      if (dead || (why === "timeout" && eve)) return;
      console.warn("[overlay] live2d unavailable, tachie fallback:", why);
      bridge.log(`live2d unavailable (${String(why)}), tachie fallback`);
      setRenderer("tachie");
    };
    const timer = setTimeout(() => fallback("timeout"), LIVE2D_TIMEOUT_MS);
    const getInput = (): RigInput => {
      const now = performance.now();
      const look = avatarRuntime.attention.current(now);
      const head = avatarRuntime.head;
      let focus;
      if (look.kind === "user") {
        // She sits somewhere on a big screen: lean toward its middle, where you are.
        const sx = (globalThis.screenX ?? 0) + head.x;
        focus = userFocus({ x: sx, y: head.y }, globalThis.screen?.availWidth || innerWidth);
      } else focus = screenToFocus(look, head, innerWidth, innerHeight);
      const r = avatarRuntime;
      return { state: avatarUi.get().state, focus, mouth: r.mouthOverride ?? r.mouth, mouthHold: r.mouthOverride === null && r.mouthHold, still: r.still, eyesClosed: r.eyesClosed };
    };
    loadEve(canvas, { width: BOX_W, height: BOX_H }, getInput, fallback)
      .then((e) => {
        if (dead) return e.destroy();
        clearTimeout(timer);
        eve = e;
        setRenderer("live2d");
        bridge.log("live2d up");
      })
      .catch(fallback);
    return () => {
      dead = true;
      clearTimeout(timer);
      eve?.destroy();
    };
  }, []);
  useEffect(() => avatarUi.set({ renderer }), [renderer]);

  // --- click-through: alpha under the pointer -> interactive or not ------------
  useEffect(() => {
    const px = new Uint8Array(4);
    const still = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    let stillSrc = "";
    const liveSample = (cx: number, cy: number) => {
      const gl = glRef.current;
      const c = canvasRef.current;
      if (!gl || !c) return 0;
      try {
        gl.readPixels(cx, c.height - cy - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px[3]!;
      } catch {
        return 255;
      }
    };
    // Tachie: sample the visible still (same-origin, so readable).
    const tachieSample = (lx: number, ly: number) => {
      const img = [...(tachieRef.current?.querySelectorAll("img") ?? [])].find((i) => i.style.opacity === "1" && i.naturalWidth);
      if (!img) return 0;
      if (img.src !== stillSrc) {
        still.canvas.width = img.naturalWidth;
        still.canvas.height = img.naturalHeight;
        still.clearRect(0, 0, img.naturalWidth, img.naturalHeight);
        still.drawImage(img, 0, 0);
        stillSrc = img.src;
      }
      const r = containRect(BOX_W, BOX_H, img.naturalWidth, img.naturalHeight);
      const ix = Math.floor(((lx - r.x) / r.w) * img.naturalWidth);
      const iy = Math.floor(((ly - r.y) / r.h) * img.naturalHeight);
      if (ix < 0 || iy < 0 || ix >= img.naturalWidth || iy >= img.naturalHeight) return 0;
      return still.getImageData(ix, iy, 1, 1).data[3]!;
    };
    const alphaAt = (x: number, y: number) => {
      const b = boxRef.current;
      if (rendererRef.current === "live2d") {
        const c = canvasRef.current!;
        return hitAlpha(x, y, b, c.width, c.height, liveSample);
      }
      if (rendererRef.current === "tachie") return hitAlpha(x, y, b, BOX_W, BOX_H, tachieSample);
      return 0;
    };

    let logged = false;
    const gate = new ClickThroughGate((on) => {
      bridge.setInteractive(on);
      setCursor(on ? "grab" : "none");
      if (!logged || on) bridge.log(`interactive ${on ? "on" : "off"}`);
      logged = true;
    });
    let pending: { x: number; y: number } | null = null;
    let raf = 0;
    let lastGlance = 0;
    const flush = () => {
      raf = 0;
      if (!pending) return;
      const { x, y } = pending;
      pending = null;
      const now = performance.now();
      gate.update(alphaAt(x, y), now);
      // She notices the cursor near her, now and then.
      const head = avatarRuntime.head;
      if (Math.hypot(x - head.x, y - head.y) < 260 && now - lastGlance > 2400 && avatarUi.get().state !== "sleeping") {
        lastGlance = now;
        avatarRuntime.attention.look({ x, y }, 700, now);
      }
    };
    let press: { x: number; y: number; dragging: boolean } | null = null;
    const onMove = (e: MouseEvent) => {
      if (press) {
        if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > TAP_SLOP) {
          press.dragging = true;
          gate.setDragging(true);
          setCursor("grabbing");
          bridge.dragStart();
        }
        return;
      }
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !gate.interactive) return;
      press = { x: e.screenX, y: e.screenY, dragging: false };
    };
    const onUp = (e: MouseEvent) => {
      if (!press) return;
      const p = press;
      press = null;
      if (p.dragging) {
        bridge.dragEnd();
        gate.setDragging(false);
        setCursor("grab");
      } else poke(e.clientX, e.clientY);
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onLeave = () => {
      if (press?.dragging) return;
      gate.update(-1, performance.now());
    };
    const tick = setInterval(() => gate.tick(performance.now()), 60);
    addEventListener("mousemove", onMove);
    addEventListener("mousedown", onDown);
    addEventListener("mouseup", onUp);
    document.documentElement.addEventListener("mouseleave", onLeave);
    const offVisible = bridge.on("visible", (v) => {
      if (!v) gate.release();
    });
    return () => {
      clearInterval(tick);
      cancelAnimationFrame(raf);
      removeEventListener("mousemove", onMove);
      removeEventListener("mousedown", onDown);
      removeEventListener("mouseup", onUp);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      offVisible();
      gate.release();
    };
  }, []);

  // --- tray / hotkeys from the main process ----------------------------------------
  useEffect(() => {
    const offs = [bridge.on("mute", (m) => voice.mute(m)), bridge.on("attention", (p) => setAttentionPaused(p))];
    bridge.ready();
    return () => offs.forEach((o) => o());
  }, []);

  return (
    <div className="ov-root" data-cursor={cursor} data-electron={inElectron}>
      <div
        className="eve-box ov-eve"
        data-state={state}
        data-offline={!connected}
        style={{ transform: `translate(${box.x}px, ${box.y}px) scale(${box.w / BOX_W})`, width: BOX_W, height: BOX_H }}
      >
        <div className="eve-aura" />
        <div className="eve-ear" />
        <canvas ref={canvasRef} className="eve-canvas" data-renderer={renderer} style={{ opacity: renderer === "live2d" ? 1 : 0 }} />
        {renderer === "tachie" && (
          <div ref={tachieRef} style={{ position: "absolute", inset: 0 }}>
            <Tachie />
          </div>
        )}
        <div className="eve-thinking" aria-hidden>
          <i />
          <i />
          <i />
        </div>
      </div>
      <Flashes />
      <Subtitles placement="column" />
      <StatusChip connected={connected} born={born} thinking={born && world.companion.state === "thinking"} attentionPaused={attentionPaused} />
    </div>
  );
}

/** Tap (no drag): she notices. Local only, nothing goes on the bus. */
function poke(x: number, y: number) {
  const now = performance.now();
  if (avatarUi.get().state === "sleeping") return;
  avatarRuntime.rig.blink.trigger(now);
  avatarRuntime.attention.look({ x, y }, 900, now);
  avatarRuntime.rig.setMood("happy", 0.55, now, 1400);
}

function useApproval(): string | null {
  const [pending, setPending] = useState<Map<string, string>>(new Map());
  const drop = (id: string) =>
    setPending((m) => {
      if (!m.has(id)) return m;
      const n = new Map(m);
      n.delete(id);
      return n;
    });
  useEvent("action.request", (e) => {
    if (e.data.needsApproval) setPending((m) => new Map(m).set(e.data.actionId, e.data.description));
  });
  useEvent("action.approval", (e) => drop(e.data.actionId));
  useEvent("action.result", (e) => drop(e.data.actionId));
  const last = [...pending.values()].pop();
  return last ?? null;
}

function StatusChip({ connected, born, thinking, attentionPaused }: { connected: boolean; born: boolean; thinking: boolean; attentionPaused: boolean }) {
  const mic = useStore(voiceUi, (s) => s.mic);
  const heard = useStore(voiceUi, (s) => s.heard);
  const speaking = useStore(voiceUi, (s) => s.speaking);
  const approval = useApproval();
  const chip = chipFor({
    connected,
    born,
    approval,
    muted: !!mic.muted,
    thinking,
    heard,
    listening: mic.listening,
    micError: mic.error,
    speaking,
    attentionPaused,
  });
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (dot.current) dot.current.style.transform = `scale(${1 + Math.min(1, micLevel.value) * 0.9})`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const hidden = chip.kind === "speaking";
  return (
    <div className="ov-chip" data-kind={chip.kind} data-hidden={hidden} aria-live="polite">
      <span className="ov-dot" ref={dot} />
      <span className="ov-chip-text">{chip.text}</span>
      {chip.sub && <span className="ov-chip-sub">{chip.sub}</span>}
    </div>
  );
}

/** Memory and attention flashes: a line each, gone in ~3s. */
function Flashes() {
  const [items, setItems] = useState<Flash[]>([]);
  const seq = useRef(0);
  const push = (kind: Flash["kind"], text: string) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-1), { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), FLASH_MS);
  };
  useEvent("memory.recall", (e) => {
    const top = e.data.hits[0]?.record.content;
    if (top && e.data.hits.length) push("memory", `remembered · ${Math.max(1, Math.round(e.data.ms))}ms · ${top}`);
  });
  useEvent("memory.write", (e) => {
    if (e.data.policy === "STORE_LONG_TERM" || e.data.policy === "UPDATE_PREFERENCE") push("saved", `noted · ${e.data.record.content}`);
  });
  useEvent("reflex.decision", (e) => {
    // Replies to what you said aren't news; things she noticed on her own are.
    if (e.data.decision === "IGNORE" || e.data.decision === "GLANCE" || /^(utterance|voice|user)/.test(e.data.trigger)) return;
    push("attention", `${e.data.decision.toLowerCase()} · ${triggerLabel(e.data.trigger)}`);
  });
  return (
    <div className="ov-flashes">
      <AnimatePresence initial={false}>
        {items.map((f) => (
          <motion.div
            key={f.id}
            className="ov-flash mono"
            data-kind={f.kind}
            layout
            initial={{ opacity: 0, y: -6, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.22, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.16, ease: [0.23, 1, 0.32, 1] } }}
          >
            {f.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
