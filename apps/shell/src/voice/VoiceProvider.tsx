import { useEffect, type ReactNode } from "react";
import { envelope, type SpeechMark } from "@eigenwife/protocol";
import { avatarRuntime, createStore } from "../avatar/store";
import { CORE_HTTP, useBus } from "../lib/bus";
import { wireAudioUnlock } from "./audio";
import { SpeechPlayer } from "./player";
import { Recognizer } from "./recognition";

export interface SubtitleState {
  utteranceId: string;
  /** Text of the segments already spoken in this utterance. */
  before: string;
  text: string;
  startedAt: number;
  durationMs: number;
  /** Chars confirmed spoken by word boundaries (speechSynthesis). Absent: reveal by time. */
  revealTo?: number;
}

export interface VoiceUi {
  subtitle: SubtitleState | null;
  /** Last utterance finished at (for the fade-out). */
  subtitleEndedAt: number;
  mic: { supported: boolean; listening: boolean; ptt: boolean; error?: string };
  /** What the user is saying right now (interim), cleared on commit. */
  heard: string;
  speaking: boolean;
}

export const voiceUi = createStore<VoiceUi>({
  subtitle: null,
  subtitleEndedAt: 0,
  mic: { supported: true, listening: false, ptt: false },
  heard: "",
  speaking: false,
});

type DoneListener = (utteranceId: string, interrupted: boolean) => void;
const doneListeners = new Set<DoneListener>();
const beginListeners = new Set<(utteranceId: string) => void>();
let player: SpeechPlayer | null = null;

/** Imperative handle for scenes (emergence gates her first line until she's out of the card). */
export const voice = {
  gate(on: boolean) {
    player?.gate(on);
  },
  onDone(fn: DoneListener) {
    doneListeners.add(fn);
    return () => void doneListeners.delete(fn);
  },
  onBegin(fn: (utteranceId: string) => void) {
    beginListeners.add(fn);
    return () => void beginListeners.delete(fn);
  },
  speaking() {
    return player?.speaking ?? false;
  },
};

const params = new URLSearchParams(location.search);
const MIC = params.get("mic") !== "0";

function resolveUrl(u: string): string {
  if (/^(https?:|blob:|data:)/.test(u)) return u;
  return `${CORE_HTTP}${u.startsWith("/") ? "" : "/"}${u}`;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

/**
 * Voice: plays Eve's speech.segment queue (with lipsync + marks + subtitles)
 * and listens to the user (voice.partial / voice.final).
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const { client } = useBus();

  useEffect(() => {
    const local = <T extends Parameters<typeof envelope>[0]>(type: T, data: Parameters<typeof envelope<T>>[1]) =>
      client.dispatch(envelope(type, data, "shell") as any);

    const p = new SpeechPlayer(
      {
        played: (utteranceId, seq) => client.emit("speech.played", { utteranceId, seq }),
        mark: (m: SpeechMark) => {
          if (m.mood) local("avatar.mood", { mood: m.mood, intensity: m.intensity ?? 0.8 });
        },
        utteranceDone: (id, interrupted) => {
          voiceUi.set({ subtitleEndedAt: performance.now() });
          doneListeners.forEach((fn) => fn(id, interrupted));
        },
        subtitle: (s) => {
          if (!s) return voiceUi.set({ subtitle: null });
          const cur = voiceUi.get().subtitle;
          // Same segment, new progress (word boundary): keep the clock so words don't re-pop.
          if (cur && cur.utteranceId === s.utteranceId && cur.text === s.text && cur.before === s.before)
            voiceUi.set({ subtitle: { ...cur, revealTo: s.revealTo } });
          else voiceUi.set({ subtitle: s });
        },
        mouth: (value, hold, speaking) => {
          avatarRuntime.mouth = value;
          avatarRuntime.mouthHold = hold;
          avatarRuntime.speaking = speaking;
          voiceUi.set({ speaking });
        },
      },
      resolveUrl,
    );
    player = p;
    p.start();

    const offs = [
      client.on("speech.begin", (e) => {
        p.begin(e.data.utteranceId);
        beginListeners.forEach((fn) => fn(e.data.utteranceId));
      }),
      client.on("speech.segment", (e) => p.segment(e.data)),
      client.on("speech.end", (e) => (e.data.interrupted ? p.stop("interrupted") : p.end(e.data.utteranceId))),
      client.on("speech.stop", (e) => p.stop(e.data.reason)),
    ];

    // --- ears -------------------------------------------------------------
    let rec: Recognizer | null = null;
    if (MIC) {
      rec = new Recognizer({
        partial: (text) => {
          voiceUi.set({ heard: text });
          client.emit("voice.partial", { text });
        },
        final: (text) => {
          voiceUi.set({ heard: "" });
          client.emit("voice.final", { text });
        },
        bargeIn: () => {
          // Stop her right now locally; the core hears the partial and stops too.
          p.stop("barge-in");
          client.emit("speech.stop", { reason: "barge-in" });
        },
        status: (s) => voiceUi.set({ mic: s }),
        eve: () => ({ speaking: p.speaking, msSinceStopped: performance.now() - p.stoppedAt }),
      });
    } else {
      voiceUi.set({ mic: { supported: false, listening: false, ptt: false, error: "mic off (?mic=0)" } });
    }

    // Audio + mic both need a gesture: the first click anywhere does both.
    wireAudioUnlock(() => rec?.start());
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping(e.target)) return;
      e.preventDefault();
      rec?.pttDown();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      rec?.pttUp();
    };
    addEventListener("keydown", onDown);
    addEventListener("keyup", onUp);

    return () => {
      offs.forEach((o) => o());
      removeEventListener("keydown", onDown);
      removeEventListener("keyup", onUp);
      rec?.dispose();
      p.dispose();
      if (player === p) player = null;
    };
  }, [client]);

  return <>{children}</>;
}
