import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CANDIDATES, envelope, type AnyEnvelope } from "@eigenwife/protocol";
import { Ambient } from "../components/fx";
import { LatentPanel, readoutRows, type ReadoutRow } from "../components/LatentPanel";
import { ProfileCard } from "../components/ProfileCard";
import { useGaze } from "../gaze/GazeProvider";
import { DEFAULT_ADVANCE, advanceReason, pointInRect, type AdvanceReason } from "../lib/advance";
import { useBus, useEvent } from "../lib/bus";
import { LocalPreference, localPersona } from "../lib/fallback";
import { useScene } from "../lib/scene";
import { shell } from "../lib/store";
import "../styles/dating.css";

/** How long to wait for the core's preference module before computing locally. */
const CORE_GRACE_MS = 900;

/**
 * Act I. Profiles advance on their own (look away 1.5s, ~7s budget, or
 * ArrowRight from the operator). Gaze is only ever attention here.
 */
export function DatingScene() {
  const { client, emit } = useBus();
  const gaze = useGaze();
  const { go } = useScene();
  const total = CANDIDATES.length;
  const [index, setIndex] = useState(0);
  const [rows, setRows] = useState<ReadoutRow[]>([]);
  const [lastSkip, setLastSkip] = useState<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const shownAt = useRef(Date.now());
  const lastOn = useRef<number | null>(null);
  const liveKey = useRef<string | null>(null);
  const leaving = useRef(false);
  const done = useRef(false);
  const coreHeard = useRef(false);
  const local = useMemo(() => new LocalPreference(CANDIDATES), []);
  const c = CANDIDATES[Math.min(index, total - 1)]!;
  const prefix = `cand_${c.id}_`;

  // Fresh model for a fresh run.
  useEffect(() => {
    shell.set({ pref: null, signals: [] });
  }, []);

  const converge = useCallback(
    (why: string) => {
      if (done.current) return;
      done.current = true;
      console.info("[dating] converged:", why);
      go("convergence");
    },
    [go],
  );

  useEvent("preference.update", (e) => {
    if (e.source !== "shell") coreHeard.current = true;
    if (e.data.progress >= 0.98) setTimeout(() => converge("progress"), 900);
  });
  useEvent("preference.converged", () => setTimeout(() => converge("core"), 700));

  // Show a card (guarded: StrictMode runs effects twice in dev).
  const viewed = useRef(-1);
  useEffect(() => {
    if (index >= total || viewed.current === index) return;
    viewed.current = index;
    shownAt.current = Date.now();
    lastOn.current = null;
    leaving.current = false;
    gaze?.reset(prefix);
    emit("dating.view", { candidateId: c.id, index, total });
    setRows([]);
  }, [index, gaze]); // eslint-disable-line react-hooks/exhaustive-deps

  const leave = useCallback(
    (reason: AdvanceReason) => {
      if (leaving.current || done.current || index >= total) return;
      const now = Date.now();
      // An operator tap right after an auto-advance shouldn't skip the fresh card.
      if (reason === "operator" && now - shownAt.current < 700) return;
      leaving.current = true;
      const regions = gaze?.stats(prefix) ?? {};
      const totalMs = now - shownAt.current;
      emit("dating.leave", { candidateId: c.id, regions, totalMs, skipLatencyMs: totalMs });
      gaze?.reset(prefix);
      setLastSkip(totalMs);
      console.info(`[dating] leave ${c.id} (${reason}) ${totalMs}ms`);

      // Local fallback: the same math the core runs, used only if the core stays quiet.
      const { signal, update } = local.observe(c, regions, totalMs);
      const observed = local.observations;
      setTimeout(() => {
        if (coreHeard.current) return;
        client.dispatch(envelope("dating.signal", signal, "shell") as AnyEnvelope);
        client.dispatch(envelope("preference.update", update, "shell") as AnyEnvelope);
        if (update.progress >= 0.98 || observed >= total) {
          const persona = localPersona(update.vector, CANDIDATES);
          // Over the wire: the avatar and core need a persona even when the preference module is down.
          emit("preference.converged", { vector: update.vector, persona });
        }
      }, CORE_GRACE_MS);

      if (index + 1 >= total) {
        // Out of profiles: give the core a moment to converge, then force it.
        setTimeout(() => converge("last card"), CORE_GRACE_MS + 1600);
      }
      setIndex((i) => i + 1);
    },
    [c, client, converge, emit, gaze, index, local, prefix, total],
  );

  // Gaze-on-card bookkeeping + auto-advance tick.
  useEffect(() => {
    const t = setInterval(() => {
      const el = cardRef.current;
      const now = Date.now();
      if (el && pointInRect(gaze?.point() ?? null, el.getBoundingClientRect(), 16)) lastOn.current = now;
      const reason = advanceReason({ now, shownAt: shownAt.current, lastOnCardAt: lastOn.current });
      if (reason) leave(reason);
      if (gaze) setRows(readoutRows(gaze.stats(prefix), prefix, liveKey.current));
    }, 150);
    return () => clearInterval(t);
  }, [gaze, leave, prefix]);

  useEvent("gaze.fixation", (e) => {
    liveKey.current = e.data.target?.key ?? null;
  });

  useEvent("shell.key", (e) => {
    if (e.data.key === "ArrowRight") leave("operator");
  });

  const profileNo = Math.min(index, total - 1) + 1;
  return (
    <div className="dating">
      <Ambient />
      <div className="dating-top">
        <div className="eigen-mark">
          <span className="glyph">e</span>
          Eigen
        </div>
        <span className="sub">no swiping. just look.</span>
        <span className="spacer" />
        <span className="count">
          PROFILE <b>{String(profileNo).padStart(2, "0")}</b> / {total}
        </span>
      </div>
      <div className="dating-stage">
        <AnimatePresence mode="wait">
          {index < total && (
            <motion.div
              key={c.id}
              style={{ width: "100%", height: "100%", display: "grid", placeItems: "center" }}
              initial={{ opacity: 0, x: 70, scale: 0.97, filter: "blur(10px)" }}
              animate={{ opacity: 1, x: 0, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, x: -90, rotate: -2.5, scale: 0.98, filter: "blur(8px)", transition: { duration: 0.28, ease: [0.4, 0, 1, 1] } }}
              transition={{ type: "spring", duration: 0.6, bounce: 0 }}
            >
              <ProfileCard ref={cardRef} c={c} index={index} total={total} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="dating-progress" style={{ ["--budget" as string]: `${DEFAULT_ADVANCE.budgetMs}ms` }}>
        {CANDIDATES.map((x, i) => (
          <i key={i < index ? x.id : `${x.id}-${index}`} className={i < index ? "done" : i === index ? "cur" : ""} />
        ))}
      </div>
      <LatentPanel profileNo={profileNo} rows={rows} lastSkipMs={lastSkip} />
    </div>
  );
}
