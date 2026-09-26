import { useEffect, useMemo, useState } from "react";
import { useStore } from "../avatar/store";
import { revealCount } from "./queue";
import { voiceUi } from "./VoiceProvider";

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
const graphemes = (s: string) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

const FADE_AFTER_MS = 2200;
/** Keep the caption to roughly two lines: older spoken text drops off the front. */
const MAX_BEFORE = 70;

/**
 * Anime-style streaming subtitles: graphemes pop in as she says them. White
 * fill, thick dark stroke (paint-order: stroke), Quicksand.
 */
export function Subtitles({ placement }: { placement: "stage" | "column" | "hidden" }) {
  const sub = useStore(voiceUi, (s) => s.subtitle);
  const endedAt = useStore(voiceUi, (s) => s.subtitleEndedAt);
  const [shown, setShown] = useState(0);
  const [faded, setFaded] = useState(false);

  const before = useMemo(() => {
    const b = (sub?.before ?? "").trim();
    return b.length > MAX_BEFORE ? "…" + b.slice(b.length - MAX_BEFORE).replace(/^\S*\s/, "") : b;
  }, [sub?.before]);
  const chars = useMemo(() => graphemes(sub?.text ?? ""), [sub?.text]);
  // Group graphemes into words so lines only ever break between words.
  const words = useMemo(() => {
    const out: { start: number; g: string[] }[] = [];
    let i = 0;
    for (const w of (sub?.text ?? "").split(/(\s+)/)) {
      if (!w) continue;
      const g = graphemes(w);
      out.push({ start: i, g });
      i += g.length;
    }
    return out;
  }, [sub?.text]);

  useEffect(() => {
    if (!sub) return;
    setFaded(false);
    if (sub.revealTo !== undefined) {
      setShown(Math.min(chars.length, graphemes(sub.text.slice(0, sub.revealTo)).length));
      return;
    }
    let raf = 0;
    let last = -1;
    const loop = () => {
      const p = (performance.now() - sub.startedAt) / Math.max(1, sub.durationMs);
      const n = revealCount(chars.length, p);
      if (n !== last) {
        last = n;
        setShown(n);
      }
      if (n < chars.length) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sub, chars]);

  useEffect(() => {
    if (!endedAt) return;
    const t = setTimeout(() => {
      const s = voiceUi.get();
      if (!s.speaking && (!s.subtitle || s.subtitle.startedAt <= endedAt)) setFaded(true);
    }, FADE_AFTER_MS);
    return () => clearTimeout(t);
  }, [endedAt]);

  if (!sub || placement === "hidden") return null;
  return (
    <div className="eve-subs" data-placement={placement} data-faded={faded} aria-live="polite">
      <p>
        {before && <span className="eve-subs-before">{before} </span>}
        {words.map((w) =>
          w.start >= shown ? null : /^\s+$/.test(w.g.join("")) ? (
            <span key={`${sub.startedAt}-${w.start}`}> </span>
          ) : (
            <span key={`${sub.startedAt}-${w.start}`} className="eve-w">
              {w.g.slice(0, shown - w.start).map((c, i) => (
                <span key={i} className="eve-g">
                  {c}
                </span>
              ))}
            </span>
          ),
        )}
      </p>
    </div>
  );
}
