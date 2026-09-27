import { useEffect, useState } from "react";
import { CANDIDATES } from "@eigenwife/protocol";
import { Ambient, Glitch, useTypewriter } from "../components/fx";
import { shutter } from "../components/Shutter";
import { useGaze } from "../gaze/GazeProvider";
import { blip, unlockAudio } from "../lib/audio";
import { useBus, useWorld } from "../lib/bus";
import { useScene } from "../lib/scene";
import "../styles/scenes.css";

type Status = "wait" | "ok" | "skip";
interface Line {
  text: string;
  status: Status;
  note?: string;
}

/** Black screen, self-typing boot log, one "begin" button: the only click in the demo. */
export function BootScene() {
  const { emit } = useBus();
  const { connected } = useWorld();
  const gaze = useGaze();
  const { go } = useScene();
  const [lines, setLines] = useState<Line[]>([]);
  const [ready, setReady] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let alive = true;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const push = (l: Line) => alive && setLines((ls) => [...ls, l]);
    const settle = (i: number, status: Status, note?: string) =>
      alive && setLines((ls) => ls.map((l, j) => (j === i ? { ...l, status, ...(note ? { note } : {}) } : l)));
    (async () => {
      await wait(500);
      push({ text: "mounting /eve", status: "ok" });
      await wait(260);
      push({ text: "loading attention model", status: "wait" });
      await wait(900);
      settle(1, "ok");
      push({ text: "linking core bus", status: "wait", note: "ws://127.0.0.1:7777" });
      await wait(700);
      push({ text: "eye tracker", status: "wait" });
      await wait(1100);
      push({ text: `${CANDIDATES.length} synthetic candidates`, status: "ok" });
      await wait(240);
      push({ text: "latent partner model", status: "ok", note: "empty" });
      await wait(600);
      alive && setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Live statuses: flip as soon as the core / eye actually answer.
  useEffect(() => {
    setLines((ls) =>
      ls.map((l) =>
        l.text === "linking core bus" && l.status !== "ok" ? { ...l, status: connected ? "ok" : ready ? "skip" : "wait", note: connected ? "ws://127.0.0.1:7777" : ready ? "offline, local fallback" : l.note } : l,
      ),
    );
  }, [connected, ready, lines.length]);
  const mode = gaze?.mode() ?? "none";
  useEffect(() => {
    setLines((ls) =>
      ls.map((l) =>
        l.text === "eye tracker" && l.status === "wait" && (mode !== "none" || ready)
          ? { ...l, status: mode === "eye" ? "ok" : "skip", note: mode === "eye" ? "eye serve :8765" : "mouse proxy" }
          : l,
      ),
    );
  }, [mode, ready, lines.length]);

  const begin = async () => {
    if (leaving) return;
    setLeaving(true);
    // First, while the click still counts as a gesture: eye gaze only maps in real fullscreen.
    if (gaze?.mode() === "eye") void gaze.enterFullscreen();
    const audioUnlocked = await unlockAudio();
    blip(660, 90);
    setTimeout(() => blip(990, 120), 90);
    emit("shell.ready", { width: innerWidth, height: innerHeight, audioUnlocked });
    void shutter(() => go("calibration"));
  };

  return (
    <div className="boot">
      <Ambient scanlines />
      <div className="boot-dim" />
      <div className="boot-col">
        <div className="boot-brand mono">
          <Glitch text="EIGEN OS" /> <span className="dim">0.9.26 · build 2026.09.26</span>
        </div>
        <div className="boot-log mono">
          {lines.map((l, i) => (
            <LogLine key={i} line={l} />
          ))}
          {!ready && <span className="caret" />}
        </div>
        <div className={`boot-cta ${ready ? "on" : ""}`}>
          <h1>
            <Glitch text="LET'S FIGURE OUT YOUR TYPE." />
          </h1>
          <p className="mono">DON'T TOUCH ANYTHING.</p>
          <button className="btn-begin" onClick={begin} disabled={!ready} tabIndex={ready ? 0 : -1}>
            begin
          </button>
          <div className="boot-fine mono">one click. after this, your eyes do the talking.</div>
        </div>
      </div>
    </div>
  );
}

function LogLine({ line }: { line: Line }) {
  const typed = useTypewriter(line.text, 70);
  const tag = line.status === "ok" ? "OK" : line.status === "skip" ? "--" : "..";
  return (
    <div className={`log-line ${line.status}`}>
      <span className="tag">[ {tag.padEnd(2, " ")} ]</span> <span>{typed}</span>
      {line.note && typed.length === line.text.length && <span className="note"> {line.note}</span>}
    </div>
  );
}
