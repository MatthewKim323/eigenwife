import { useEffect, useMemo, useRef, useState } from "react";
import { CANDIDATES, TRAIT_KEYS, type RegionStats } from "@eigenwife/protocol";
import { lifts } from "../lib/fallback";
import { useShell } from "../lib/store";
import { useCountUp } from "./fx";
import { rng } from "./GenArt";

export interface ReadoutRow {
  region: string;
  ms: number;
  revisit: boolean;
  live: boolean;
}

/** The right-hand LATENT PARTNER MODEL panel. */
export function LatentPanel({ profileNo, rows, lastSkipMs }: { profileNo: number; rows: ReadoutRow[]; lastSkipMs: number | null }) {
  const pref = useShell((s) => s.pref);
  const signals = useShell((s) => s.signals);
  const progress = pref?.progress ?? 0;
  const pct = useCountUp(progress * 100, 900);
  const traitLifts = useMemo(() => (pref ? lifts(pref.vector, CANDIDATES) : []), [pref]);
  const sig = signals[signals.length - 1];

  return (
    <aside className="latent" aria-label="latent partner model">
      <div>
        <h4>
          <span>LATENT PARTNER MODEL</span>
          <span className="by">
            {pref ? (
              <>
                via <b>{pref.by === "core" ? (sig?.by ?? "core") : "local"}</b>
              </>
            ) : (
              "awaiting signal"
            )}
          </span>
        </h4>
        <div className="pct">
          <b>
            {Math.round(pct)}
            <small>%</small>
          </b>
          <span>
            {pref?.observations ?? 0} OBSERVATIONS
            <br />
            {TRAIT_KEYS.length}-DIM PREFERENCE
          </span>
        </div>
        <div className="bar">
          {Array.from({ length: 32 }, (_, i) => (
            <i key={i} className={i < Math.round(progress * 32) ? "on" : ""} />
          ))}
        </div>
      </div>

      <Constellation progress={progress} lifts={traitLifts} />

      <div className="traits">
        {(traitLifts.length ? traitLifts.slice(0, 6) : PLACEHOLDER).map((t) => (
          <TraitRow key={t.key} name={t.key.replace("_", " ")} lift={t.lift} />
        ))}
      </div>

      <div className="signal">
        <div>
          INTEREST{" "}
          {sig ? (
            <>
              skip <b>{sig.interest.skip.toFixed(2)}</b> | neutral <b>{sig.interest.neutral.toFixed(2)}</b> | inspect <b>{sig.interest.inspect.toFixed(2)}</b> | positive{" "}
              <b>{sig.interest.positive.toFixed(2)}</b>
            </>
          ) : (
            <span>waiting for first profile</span>
          )}
        </div>
        <div className="dist">
          <i style={{ flexGrow: sig?.interest.skip ?? 1, background: "oklch(0.5 0.03 260)" }} />
          <i style={{ flexGrow: sig?.interest.neutral ?? 1, background: "oklch(0.65 0.06 260)" }} />
          <i style={{ flexGrow: sig?.interest.inspect ?? 1, background: "oklch(0.78 0.12 220)" }} />
          <i style={{ flexGrow: sig?.interest.positive ?? 1, background: "oklch(0.82 0.15 340)" }} />
        </div>
        <div>
          SIGNAL_STRENGTH <b>{sig ? sig.strength.toFixed(2) : "--"}</b> · reward <b>{sig ? sig.reward.toFixed(2) : "--"}</b> · by {sig?.by ?? "--"}
        </div>
      </div>

      <div className="readout">
        <div className="h">PROFILE {String(profileNo).padStart(2, "0")}</div>
        {rows.length === 0 && <div className="skip">no fixations yet</div>}
        {rows.slice(0, 5).map((r) => (
          <div key={r.region} className={`r ${r.live ? "live" : ""}`}>
            <span>{r.region}</span>
            <span>{r.revisit ? <em>revisit </em> : null}{(r.ms / 1000).toFixed(1)}s</span>
          </div>
        ))}
        {lastSkipMs !== null && (
          <div className="r skip">
            <span>prev skip latency</span>
            <span>{(lastSkipMs / 1000).toFixed(1)}s</span>
          </div>
        )}
      </div>
    </aside>
  );
}

const PLACEHOLDER = ["humor", "warmth", "nerdiness", "chaos", "outdoors", "style"].map((key) => ({ key: key as any, lift: 0 }));

function TraitRow({ name, lift }: { name: string; lift: number }) {
  const prev = useRef(lift);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (Math.abs(prev.current - lift) > 0.005) setFlash((f) => f + 1);
    prev.current = lift;
  }, [lift]);
  const v = useCountUp(lift, 700);
  const w = Math.abs(lift) * 50;
  return (
    <div className="trait">
      <span>{name}</span>
      <span className="track">
        <i className={lift >= 0 ? "pos" : "neg"} style={{ width: `${w}%`, left: lift >= 0 ? "50%" : `${50 - w}%` }} />
      </span>
      <span key={flash} className={`v ${flash ? "flash" : ""}`}>
        {v >= 0 ? "+" : ""}
        {v.toFixed(2)}
      </span>
    </div>
  );
}

function Constellation({ progress, lifts: ls }: { progress: number; lifts: { key: string; lift: number }[] }) {
  const W = 360;
  const H = 196;
  const cx = W / 2;
  const cy = H / 2;
  const seeds = useMemo(() => {
    const r = rng("constellation");
    return TRAIT_KEYS.map((k) => ({ key: k, a: r() * Math.PI * 2, d: 0.55 + r() * 0.45, wob: r() * 6 }));
  }, []);
  const liftOf = new Map(ls.map((l) => [l.key, l.lift]));
  const top = new Set(ls.filter((l) => l.lift > 0).slice(0, 3).map((l) => l.key));
  return (
    <div className="constellation" aria-hidden>
      <svg viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <radialGradient id="core-glow">
            <stop offset="0" stopColor="white" stopOpacity="0.9" />
            <stop offset="0.3" style={{ stopColor: "oklch(0.85 0.14 var(--hue))" }} stopOpacity="0.5" />
            <stop offset="1" style={{ stopColor: "oklch(0.7 0.15 var(--hue))" }} stopOpacity="0" />
          </radialGradient>
        </defs>
        {[0.35, 0.65, 0.95].map((f) => (
          <ellipse key={f} cx={cx} cy={cy} rx={170 * f} ry={92 * f} fill="none" stroke="white" strokeOpacity="0.05" strokeDasharray="2 4" />
        ))}
        <circle cx={cx} cy={cy} r={16 + progress * 30} fill="url(#core-glow)" style={{ transition: "r 900ms ease" }} />
        {seeds.map((s) => {
          const lift = liftOf.get(s.key) ?? 0;
          const pull = progress * (0.35 + Math.max(0, lift) * 0.7);
          const rad = s.d * (1 - Math.min(0.88, pull));
          const x = cx + Math.cos(s.a) * 168 * rad;
          const y = cy + Math.sin(s.a) * 90 * rad;
          const size = 2.2 + Math.max(0, lift) * 5;
          const hot = top.has(s.key);
          return (
            <g key={s.key}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="white" strokeOpacity={0.04 + Math.max(0, lift) * progress * 0.5} style={{ transition: "all 900ms cubic-bezier(0.22,1,0.36,1)" }} />
              <g style={{ transform: `translate(${x}px, ${y}px)`, transition: "transform 900ms cubic-bezier(0.22,1,0.36,1)" }}>
                <circle r={size} fill={hot ? "oklch(0.88 0.14 calc(var(--hue) + 70))" : "white"} opacity={0.35 + Math.max(0, lift) * 0.65}>
                  <animate attributeName="r" values={`${size};${size * 1.3};${size}`} dur={`${2.4 + s.wob / 3}s`} repeatCount="indefinite" />
                </circle>
                {hot && (
                  <text x={size + 5} y={3} fontSize="9" fontFamily="DM Mono" fill="white" opacity="0.8" letterSpacing="0.08em">
                    {s.key.replace("_", " ")}
                  </text>
                )}
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function readoutRows(stats: Record<string, RegionStats>, prefix: string, liveKey: string | null): ReadoutRow[] {
  return Object.entries(stats)
    .map(([k, s]) => ({ region: k.slice(prefix.length).replace(/(\d)$/, "_$1"), ms: s.dwellMs, revisit: s.revisits > 0, live: k === liveKey }))
    .filter((r) => r.ms > 150)
    .sort((a, b) => b.ms - a.ms);
}
