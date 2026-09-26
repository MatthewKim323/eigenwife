import { useEffect, useRef } from "react";
import type { AnyEnvelope, Scene } from "@eigenwife/protocol";
import { useGaze } from "../gaze/GazeProvider";
import { useBus, useEvent, useWorld } from "../lib/bus";
import { KEY_HELP, isOperatorKeyEvent, keyAction, nextHudLevel, toggledGazeUrl } from "../lib/keys";
import { useScene } from "../lib/scene";
import { animateHue } from "../lib/hue";
import { shell, useShell } from "../lib/store";
import { Glitch, Pill, useNow } from "./fx";
import { ShutterHost, shutter } from "./Shutter";
import "../styles/hud.css";

/**
 * Always mounted (App renders it above every scene). Besides the tiny
 * diagnostics it hosts the shell's plumbing: the bus -> store bridge, the
 * operator keys, the shutter, and the gaze reticle.
 */
export function Hud() {
  useBridge();
  useOperatorKeys();
  const level = useShell((s) => s.hud);
  const help = useShell((s) => s.help);
  const { scene } = useScene();
  return (
    <>
      <ShutterHost />
      <Reticle />
      {level !== "off" && <Diagnostics scene={scene} quiet={level === "quiet"} />}
      {level !== "off" && <Approval />}
      {help && <HelpSheet />}
    </>
  );
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function useBridge() {
  const { client } = useBus();
  const { scene, go } = useScene();
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  useEffect(() => client.on("*", (e: AnyEnvelope) => shell.apply(e)), [client]);

  // Whatever is being looked at gets a quiet .looked class (styled per scene).
  useEvent("gaze.fixation", (e) => {
    const key = e.data.target?.key;
    document.querySelectorAll("[data-gaze].looked").forEach((n) => {
      if ((n as HTMLElement).dataset.gaze !== key) n.classList.remove("looked");
    });
    if (key) document.querySelector(`[data-gaze="${CSS.escape(key)}"]`)?.classList.add("looked");
  });

  // Agency: her workspace opens when a task starts, and folds back when it's done.
  useEvent("companion.born", (e) => {
    if (sceneRef.current !== "convergence") void animateHue(e.data.persona.palette.hue, 1400);
  });
  useEvent("bus.welcome", (e) => {
    const p = e.data.world.companion.persona;
    if (p && e.data.world.companion.born) {
      shell.set({ persona: p });
      if (sceneRef.current !== "boot" && sceneRef.current !== "dating") void animateHue(p.palette.hue, 900);
    }
  });

  const switching = useRef(false);
  const toSwarm = () => {
    const s = sceneRef.current;
    if (switching.current) return;
    // Never yank the audience out of Act I or the architecture slide.
    if (s === "swarm" || s === "boot" || s === "calibration" || s === "dating" || s === "convergence" || s === "architecture") return;
    shell.set({ eigenOpen: false });
    switching.current = true;
    void shutter(() => go("swarm"), 1300).then(() => (switching.current = false));
  };
  useEvent("task.start", toSwarm);
  // The harem can run without agency's task.start (CLI, late join).
  useEvent("swarm.plan", toSwarm);
  useEvent("swarm.spawn", toSwarm);
  useEvent("task.done", () => {
    setTimeout(() => {
      if (sceneRef.current === "swarm") void shutter(() => go("desktop"), 1300);
    }, 3200);
  });
}

function useOperatorKeys() {
  const { emit } = useBus();
  const { scene, go } = useScene();
  const sceneRef = useRef<Scene>(scene);
  sceneRef.current = scene;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.repeat || !isOperatorKeyEvent(ev)) return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      ev.preventDefault();
      emit("shell.key", { key: ev.key });
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [emit]);

  // Handled off the bus, so a remote operator (POST /emit shell.key) drives the same actions.
  useEvent("shell.key", (e) => {
    const a = keyAction(e.data.key);
    if (!a) return;
    switch (a.type) {
      case "scene":
        go(a.scene);
        break;
      case "open-eigen":
        if (sceneRef.current !== "desktop") go("desktop");
        shell.set({ eigenOpen: true });
        emit("app.opened", { app: "Eigen" });
        break;
      case "close-eigen":
        shell.set({ eigenOpen: false });
        break;
      case "toggle-hud":
        shell.set((s) => ({ hud: nextHudLevel(s.hud) }));
        break;
      case "toggle-reticle":
        shell.set((s) => ({ reticle: !s.reticle }));
        break;
      case "toggle-mouse":
        location.href = toggledGazeUrl(location.href, sceneRef.current);
        break;
      case "help":
        shell.set((s) => ({ help: !s.help }));
        break;
      case "escape":
        shell.set({ help: false, eigenOpen: false });
        break;
      default:
        break; // next / prev belong to the scenes
    }
  });
}

// ---------------------------------------------------------------------------
// reticle: a soft blurred dot where attention is
// ---------------------------------------------------------------------------

function Reticle() {
  const on = useShell((s) => s.reticle);
  const ref = useRef<HTMLDivElement>(null);
  const target = useRef<{ x: number; y: number } | null>(null);
  useEvent("gaze.point", (e) => {
    target.current = { x: e.data.x, y: e.data.y };
  });
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const pos = { x: innerWidth / 2, y: innerHeight / 2 };
    let shown = false;
    const step = () => {
      const t = target.current;
      const el = ref.current;
      if (t && el) {
        pos.x += (t.x - pos.x) * 0.22;
        pos.y += (t.y - pos.y) * 0.22;
        el.style.transform = `translate3d(${pos.x - 30}px, ${pos.y - 30}px, 0)`;
        if (!shown) {
          el.style.opacity = "1";
          shown = true;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  if (!on) return null;
  return (
    <div ref={ref} className="reticle" aria-hidden>
      <i />
    </div>
  );
}

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

const TOP_RIGHT: Scene[] = ["desktop", "emergence", "swarm"];

function Diagnostics({ scene, quiet }: { scene: Scene; quiet: boolean }) {
  const now = useNow(250);
  const { world, connected } = useWorld();
  const gaze = useGaze();
  const target = world.user.gazeTarget;
  const targetFresh = !!target && now - (world.user.gazeTargetAt ?? 0) < 12_000;
  const recall = useShell((s) => s.recall);
  const reflex = useShell((s) => s.reflex);
  const avatarState = useShell((s) => s.avatarState);
  const eye = useShell((s) => s.eye);
  const home = useShell((s) => s.home);
  const mode = gaze?.mode() ?? "none";
  const recallFresh = !!recall && now - recall.ts < 7000;
  const hide = scene === "boot" || scene === "convergence" || scene === "architecture";

  return (
    <>
      {!hide && (
        <div className={`hud-stack ${TOP_RIGHT.includes(scene) ? "tr" : "bl"}`}>
          <Pill show={targetFresh} key={target?.key ?? "none"}>
            attention target: <b>{shortLabel(target?.label ?? "")}</b>
          </Pill>
          {!quiet && (
            <>
              <Pill show={avatarState === "thinking"} delay={300}>
                <Glitch text="EVE IS THINKING..." />
              </Pill>
              {recallFresh && (
                <div className="hud-recall" key={recall!.ts}>
                  <Pill delay={0} tone="ok">
                    remembered · <b>{Math.max(1, Math.round(recall!.ms))}ms</b>
                  </Pill>
                  {recall!.hits.slice(0, 3).map((h, i) => (
                    <div className="hud-recall-line" key={h.record.id} style={{ animationDelay: `${120 + i * 70}ms` }}>
                      <span>{h.record.content}</span>
                      <em>{h.score.toFixed(2)}</em>
                    </div>
                  ))}
                </div>
              )}
              <div className="hud-chips">
                {reflex
                  .filter((c) => now - c.ts < 2800)
                  .map((c) => (
                    <span key={c.id} className={`hud-chip ${c.decision === "IGNORE" ? "ignore" : "act"}`}>
                      {c.decision} {c.score.toFixed(2)}
                    </span>
                  ))}
              </div>
            </>
          )}
        </div>
      )}
      {scene !== "architecture" && (
        <div className="hud-conn">
          <span className={connected ? "on" : ""}>core</span>
          <span className={mode === "eye" ? "on" : mode === "mouse" ? "half" : ""}>
            {mode === "eye" ? `eye${eye?.accuracyDeg ? ` ${eye.accuracyDeg.toFixed(1)}°` : ""}` : mode === "mouse" ? "mouse gaze" : "gaze"}
          </span>
          {home && <span className={home.online ? "on" : ""}>home</span>}
        </div>
      )}
    </>
  );
}

function Approval() {
  const approval = useShell((s) => s.approval);
  const { scene } = useScene();
  if (!approval || scene === "swarm") return null;
  return (
    <div className="hud-approval" key={approval.actionId}>
      <div className="mono tiny">{approval.permission.replace(/_/g, " ")} · approval</div>
      <div className="desc">{approval.description}</div>
      <div className="say">
        say <b>"yeah"</b> to approve · <b>"nah"</b> to cancel
      </div>
    </div>
  );
}

function HelpSheet() {
  return (
    <div className="sheet" role="dialog" aria-label="operator keys">
      <h3>OPERATOR KEYS</h3>
      {KEY_HELP.map(([k, v]) => (
        <div className="row" key={k}>
          <kbd>{k}</kbd>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

function shortLabel(label: string): string {
  const first = label.split(",")[0] ?? label;
  return first.length > 42 ? `${first.slice(0, 40)}...` : first;
}
