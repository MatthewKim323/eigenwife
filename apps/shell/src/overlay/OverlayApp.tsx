import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { AvatarState } from "@eigenwife/protocol";
import { userFocus } from "../avatar/attention";
import { resolveFocus, useGazeFeed, useTouchController, useWardrobeSync } from "../avatar/interact";
import { HEAD_IN_BOX, loadEve, type EveLive2D } from "../avatar/live2d";
import type { LookChoice } from "../avatar/look";
import type { RigInput } from "../avatar/rig";
import { avatarRuntime, avatarUi, useStore } from "../avatar/store";
import { Tachie } from "../avatar/Tachie";
import { animateHue } from "../lib/hue";
import { useBus, useEvent, useWorld, CORE_HTTP } from "../lib/bus";
import { micLevel } from "../voice/ears";
import { Subtitles } from "../voice/Subtitles";
import { voice, voiceUi } from "../voice/VoiceProvider";
import { bridge, inElectron } from "./bridge";
import { ClickThroughGate, containRect, fitBox, HIT, hitAlpha, TAP_SLOP, type Box } from "./hittest";
import { chipFor, recallFlash, triggerLabel } from "./status";
import { lookChip, nextLook, NO_LOOK, type LookState } from "./looking";
import { WifeBubbles } from "./WifeBubbles";
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
 * Tell main what she's looking at (things worth wandering her cursor over to:
 * a shared glance, a held target, his real gaze). At most twice a second, and
 * only when it changed.
 */
let lookSent: { key: string; at: number } = { key: "", at: 0 };
function reportLook(choice: LookChoice | undefined, now: number) {
  const worth = choice && choice.point && (choice.kind === "glance" || choice.kind === "hold" || choice.kind === "gaze");
  const key = worth ? `${Math.round(choice!.point!.x / 40)},${Math.round(choice!.point!.y / 40)}` : "";
  if (key === lookSent.key || now - lookSent.at < 500) return;
  lookSent = { key, at: now };
  bridge.reportLook(worth ? choice!.point : null);
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

  // She lives here: never asleep on the desktop. Unborn or offline = idle (the chip says why).
  const raw = world.companion.state;
  const worldState: AvatarState = born && connected && raw !== "sleeping" ? raw : "idle";

  // Never been born (no Act I on this machine)? Wake her with a default persona.
  useEffect(() => {
    if (!connected || born) return;
    const id = setTimeout(() => {
      void fetch(`${CORE_HTTP}/api/preference/wake`, { method: "POST" }).catch(() => {});
    }, 1500);
    return () => clearTimeout(id);
  }, [connected, born]);
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
  useWardrobeSync();
  // gaze.point from a tracker arrives in screen points, the same space as the cursor.
  useGazeFeed();
  const touch = useTouchController("overlay");
  // The global cursor (main polls it ~30Hz while she's visible): she follows it anywhere on screen.
  useEffect(() => bridge.onCursor((p) => avatarRuntime.look.cursor(p, performance.now())), []);
  // Her own cursor (docs/AGENT_CURSOR.md): while she acts, she watches it instead of yours.
  useEvent("agent.cursor", (e) => avatarRuntime.look.agent(e.data, performance.now()));

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
      // Everything in screen points: her window's origin + her head in the page.
      const ox = globalThis.screenX ?? 0;
      const oy = globalThis.screenY ?? 0;
      const head = { x: ox + avatarRuntime.head.x, y: oy + avatarRuntime.head.y };
      const sw = globalThis.screen?.availWidth || innerWidth;
      const sh = globalThis.screen?.availHeight || innerHeight;
      // She sits somewhere on a big screen: at rest she leans toward its middle, where you are.
      const user = () => userFocus(head, sw);
      const r = avatarRuntime;
      const resolved = r.still ? null : resolveFocus(now, { fromPage: (p) => ({ x: ox + p.x, y: oy + p.y }), head, size: { w: sw, h: sh }, user });
      const { focus, headGain } = resolved ?? { focus: user(), headGain: 1 };
      reportLook(resolved?.choice, now);
      return { state: avatarUi.get().state, focus, headGain, mouth: r.mouthOverride ?? r.mouth, mouthHold: r.mouthOverride === null && r.mouthHold, still: r.still, eyesClosed: r.eyesClosed };
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
      if (on) touch.enter();
      if (!logged || on) bridge.log(`interactive ${on ? "on" : "off"}`);
      logged = true;
    });
    let pending: { x: number; y: number } | null = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending) return;
      const { x, y } = pending;
      pending = null;
      const now = performance.now();
      gate.update(alphaAt(x, y), now);
      avatarRuntime.look.cursor({ x: (globalThis.screenX ?? 0) + x, y: (globalThis.screenY ?? 0) + y }, now);
    };
    let press: { x: number; y: number; dragging: boolean } | null = null;
    const onMove = (e: MouseEvent) => {
      if (press) {
        if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > TAP_SLOP) {
          press.dragging = true;
          gate.setDragging(true);
          setCursor("grabbing");
          bridge.dragStart();
          touch.dragStart();
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
        touch.drop();
      } else {
        // A tap: pat on the head, poke on the body (her pixels only: the gate was on).
        const at = { x: e.clientX, y: e.clientY };
        touch.click(at, boxRef.current, alphaAt(at.x, at.y) >= HIT.exit);
      }
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
      <WifeBubbles head={{ x: box.x + box.w * HEAD_IN_BOX.x, y: box.y + box.h * HEAD_IN_BOX.y }} vp={vp} scale={box.w / BOX_W} />
      <Flashes />
      <LookingChip />
      <Subtitles placement="column" />
      <StatusChip connected={connected} born={born} thinking={born && world.companion.state === "thinking"} attentionPaused={attentionPaused} />
    </div>
  );
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

/** The coding task she's running (work.task), for the "working on" chip. */
function useWorking(): string | null {
  const [task, setTask] = useState<{ id: string; label: string } | null>(null);
  useEvent("work.task", (e) => {
    const d = e.data;
    if (d.state === "done" || d.state === "failed" || d.state === "kept") setTask((t) => (t?.id === d.taskId ? null : t));
    else setTask({ id: d.taskId, label: `${d.title}${d.repo ? ` (${d.repo})` : ""}` });
  });
  return task?.label ?? null;
}

function StatusChip({ connected, born, thinking, attentionPaused }: { connected: boolean; born: boolean; thinking: boolean; attentionPaused: boolean }) {
  const mic = useStore(voiceUi, (s) => s.mic);
  const heard = useStore(voiceUi, (s) => s.heard);
  const speaking = useStore(voiceUi, (s) => s.speaking);
  const approval = useApproval();
  const working = useWorking();
  const chip = chipFor({
    working,
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

/**
 * "👀 looking" on her whenever the core reads the screen (screen.looking):
 * a flash for an accessibility read, a held chip for a window capture.
 * Never hidden by speech or other chips (docs/SCREEN.md guardrail).
 */
function LookingChip() {
  const [look, setLook] = useState<LookState>(NO_LOOK);
  const [now, setNow] = useState(() => performance.now());
  useEvent("screen.looking", (e) => {
    const t = performance.now();
    setLook((s) => nextLook(s, e.data, t));
    setNow(t);
  });
  useEffect(() => {
    if (!look.level) return;
    const id = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(id);
  }, [look]);
  const chip = lookChip(look, now);
  return (
    <div className="ov-look mono" data-kind={chip?.kind ?? "none"} data-hidden={!chip} aria-live="polite">
      <span>{chip?.text ?? "👀 looking"}</span>
      {chip?.sub && <span className="ov-look-sub">{chip.sub}</span>}
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
    const text = recallFlash(e.data.hits, e.data.ms);
    if (text) push("memory", text);
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
