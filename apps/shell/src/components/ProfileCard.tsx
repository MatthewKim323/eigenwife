import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { regionKey, type Candidate } from "@eigenwife/protocol";
import { gazeProps } from "../gaze/tracker";
import { useBus } from "../lib/bus";
import { ArtImage, PortraitArt, SceneArt } from "./GenArt";
import "../styles/dating.css";

/**
 * One Eigen profile. Every region is a gaze target (regionKey(id, region)).
 * The card leans toward wherever the eyes are and a foil sheen follows them:
 * it physically reacts to being looked at.
 */
export const ProfileCard = forwardRef<HTMLDivElement, { c: Candidate; index: number; total: number; compact?: boolean }>(function ProfileCard(
  { c, index, total, compact },
  outer,
) {
  const ref = useRef<HTMLDivElement>(null);
  useImperativeHandle(outer, () => ref.current!, []);
  useHoloTilt(ref);
  const g = (region: string, label: string, kind: "profile-photo" | "profile-prompt" | "profile-meta") =>
    gazeProps(regionKey(c.id, region), label, kind, { candidate: c.id, region, name: c.name });
  const [p1, p2, p3] = c.prompts;
  const [ph1, ph2] = c.photos;

  return (
    <div className={`pcard ${compact ? "compact" : ""}`} ref={ref}>
      <div className="pcard-tilt">
        <div className="pcard-bg" />
        <div className="pcard-photo1" {...g("photo1", `${c.name}'s photo: ${ph1!.caption}`, "profile-photo")}>
          <div className="bleed">
            <ArtImage src={ph1!.src} alt={ph1!.caption} className="art" fallback={<PortraitArt id={c.id} name={c.name} className="art" />} />
          </div>
          <div className="caption mono">{ph1!.caption}</div>
        </div>
        <header className="pcard-meta" {...g("meta", `${c.name}, ${c.age}, ${c.job}, ${c.location}`, "profile-meta")}>
          <div className="row1">
            <h2>
              {c.name}
              <span>{c.age}</span>
            </h2>
            <span className="idx mono">
              {String(index + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}
            </span>
          </div>
          <div className="facts mono">
            {c.job} · {c.location}
          </div>
          <div className="tagline">"{c.tagline}"</div>
        </header>
        <Prompt cls="p1" q={p1!.question} a={p1!.answer} props={g("prompt1", `${c.name}'s prompt: ${p1!.question}. ${p1!.answer}`, "profile-prompt")} />
        <Prompt cls="p2" q={p2!.question} a={p2!.answer} props={g("prompt2", `${c.name}'s prompt: ${p2!.question}. ${p2!.answer}`, "profile-prompt")} />
        <div className="pcard-photo2" {...g("photo2", `${c.name}'s photo: ${ph2!.caption}`, "profile-photo")}>
          <ArtImage src={ph2!.src} alt={ph2!.caption} className="art" fallback={<SceneArt id={c.id} className="art" />} />
          <div className="caption mono">{ph2!.caption}</div>
        </div>
        <Prompt cls="p3" q={p3!.question} a={p3!.answer} props={g("prompt3", `${c.name}'s prompt: ${p3!.question}. ${p3!.answer}`, "profile-prompt")} />
        <div className="foil f1" />
        <div className="foil f2" />
        <div className="pcard-edge" />
      </div>
    </div>
  );
});

function Prompt({ cls, q, a, props }: { cls: string; q: string; a: string; props: Record<string, string> }) {
  return (
    <div className={`pcard-prompt ${cls}`} {...props}>
      <div className="q mono">{q}</div>
      <div className="a">{a}</div>
    </div>
  );
}

/** Spring-ish tilt toward the live gaze point, written straight to style (no React renders). */
export function useHoloTilt(ref: React.RefObject<HTMLElement | null>, maxDeg = 7) {
  const { client } = useBus();
  const target = useRef({ rx: 0, ry: 0, mx: 50, my: 50, on: 0 });
  useEffect(
    () =>
      client.on("gaze.point", (e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = (e.data.x - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.data.y - (r.top + r.height / 2)) / (r.height / 2);
        const inside = Math.abs(dx) <= 1.1 && Math.abs(dy) <= 1.1;
        const cx = Math.max(-1, Math.min(1, dx));
        const cy = Math.max(-1, Math.min(1, dy));
        target.current = {
          ry: inside ? -cx * maxDeg : 0,
          rx: inside ? cy * maxDeg * 0.75 : 0,
          mx: 50 + cx * 50,
          my: 50 + cy * 50,
          on: inside ? 1 : 0,
        };
      }),
    [client, ref, maxDeg],
  );
  useEffect(() => {
    let raf = 0;
    const cur = { rx: 0, ry: 0, mx: 50, my: 50, on: 0 };
    const step = () => {
      const t = target.current;
      const k = 0.09;
      cur.rx += (t.rx - cur.rx) * k;
      cur.ry += (t.ry - cur.ry) * k;
      cur.mx += (t.mx - cur.mx) * k;
      cur.my += (t.my - cur.my) * k;
      cur.on += (t.on - cur.on) * 0.06;
      const el = ref.current;
      if (el) {
        el.style.setProperty("--rx", `${cur.rx.toFixed(2)}deg`);
        el.style.setProperty("--ry", `${cur.ry.toFixed(2)}deg`);
        el.style.setProperty("--mx", `${cur.mx.toFixed(1)}%`);
        el.style.setProperty("--my", `${cur.my.toFixed(1)}%`);
        el.style.setProperty("--foil", cur.on.toFixed(3));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ref]);
}
