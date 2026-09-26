import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "../styles/base.css";

/** Drifting aurora + grain + vignette. Put it first inside a scene. */
export function Ambient({ scanlines = false, children }: { scanlines?: boolean; children?: ReactNode }) {
  return (
    <div className="ambient" aria-hidden>
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
      {children}
      <div className="grain" />
      {scanlines && <div className="scanlines" />}
      <div className="vignette" />
    </div>
  );
}

/** RGB-split glitch text (two ::before/::after copies off data-text). */
export function Glitch({ text, hard, className = "", style }: { text: string; hard?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <span className={`glitch ${hard ? "hard" : ""} ${className}`} data-text={text} style={style}>
      {text}
    </span>
  );
}

/** True once `on` has held for `ms`. Status chips use this so short states never flash. */
export function useHeld(on: boolean, ms = 400): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const t = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return held;
}

/** Delayed status pill with a lamp-flicker entrance. */
export function Pill({
  show = true,
  delay = 400,
  tone,
  children,
  style,
}: {
  show?: boolean;
  delay?: number;
  tone?: "ok" | "warn" | "off";
  children: ReactNode;
  style?: CSSProperties;
}) {
  const held = useHeld(show, delay);
  if (!held) return null;
  return (
    <span className={`pill ${tone ?? ""}`} style={style}>
      <span className="lamp" />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
    </span>
  );
}

/** Types text out character by character. */
export function useTypewriter(text: string, cps = 60, start = true): string {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
  }, [text]);
  useEffect(() => {
    if (!start || n >= text.length) return;
    const t = setTimeout(() => setN((x) => Math.min(text.length, x + 1 + (Math.random() < 0.15 ? 1 : 0))), 1000 / cps);
    return () => clearTimeout(t);
  }, [n, text, cps, start]);
  return text.slice(0, n);
}

/** Smoothly count toward a number. */
export function useCountUp(target: number, ms = 600): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      const val = a + (target - a) * e;
      setV(val);
      from.current = val;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
