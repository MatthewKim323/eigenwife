import { useEffect, type ReactNode } from "react";
import { envelope, type SpeechMark } from "@eigenwife/protocol";
import { avatarRuntime, createStore } from "../avatar/store";
import { CORE_HTTP, useBus } from "../lib/bus";
import { SpeechPlayer } from "./player";
import { OVERLAY } from "../overlay/mode";
import { unlockAudio, wireAudioUnlock } from "./audio";
import { EarsClient } from "./ears";
import { Recognizer, type MicStatus } from "./recognition";
import { chooseStt, earsAvailable, earsUrl, sttPref } from "./stt";
import { wireLive, type LiveWiring } from "../live/wire";

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
  mic: MicStatus;
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
let ears: { setMuted(on: boolean): void } | null = null;
let mutedWanted = false;
/** Eve Live (docs/LIVE.md): while it owns the mic, the classic ears and player stand down. */
let live: LiveWiring | null = null;

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
  /** Mute / unmute the mic (overlay tray, Cmd+Shift+M). */
  mute(on: boolean) {
    mutedWanted = on;
    ears?.setMuted(on);
    live?.setMuted(on);
    if (!ears) voiceUi.set({ mic: { ...voiceUi.get().mic, muted: on } });
  },
  muted() {
    return mutedWanted;
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
          // Live drives her mouth from its own output analyser.
          if (live?.active()) return;
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
        // Live lines play from the gpt-live-1 stream, not the segment player.
        if (e.data.brain === "live") return beginListeners.forEach((fn) => fn(e.data.utteranceId));
        p.begin(e.data.utteranceId);
        beginListeners.forEach((fn) => fn(e.data.utteranceId));
      }),
      client.on("speech.segment", (e) => p.segment(e.data)),
      client.on("speech.end", (e) => {
        if (e.source === "live") {
          voiceUi.set({ subtitleEndedAt: performance.now() });
          return doneListeners.forEach((fn) => fn(e.data.utteranceId, e.data.interrupted));
        }
        if (e.data.interrupted) p.stop("interrupted");
        else p.end(e.data.utteranceId);
      }),
      // What he's saying, as the live session hears it (the core publishes voice.* for live).
      client.on("voice.partial", (e) => {
        if (e.source === "live" && live?.active()) voiceUi.set({ heard: e.data.text });
      }),
      client.on("voice.final", (e) => {
        if (e.source === "live" && live?.active()) voiceUi.set({ heard: "" });
      }),
      client.on("speech.stop", (e) => p.stop(e.data.reason)),
    ];

    // --- ears: Web Speech in a browser tab, Deepgram via core ws /ears in the overlay ---
    type Ears = { start(): void | Promise<void>; pttDown(): void; pttUp(): void; dispose(): void; setMuted(on: boolean): void };
    let rec: Ears | null = null;
    let disposed = false;
    const eve = () => ({ speaking: p.speaking, msSinceStopped: performance.now() - p.stoppedAt });
    const status = (s: MicStatus) => voiceUi.set({ mic: s });
    const stopHer = () => {
      // Stop her right now locally; the core hears the partial and stops too.
      p.stop("barge-in");
      client.emit("speech.stop", { reason: "barge-in" });
    };
    const useBrowser = () =>
      new Recognizer({
        partial: (text) => {
          voiceUi.set({ heard: text });
          client.emit("voice.partial", { text });
        },
        final: (text) => {
          voiceUi.set({ heard: "" });
          client.emit("voice.final", { text });
        },
        bargeIn: stopHer,
        status,
        eve,
      });
    // The core publishes voice.* itself for Deepgram: these only drive the UI.
    const useDeepgram = () =>
      new EarsClient(
        {
          partial: (text) => voiceUi.set({ heard: text }),
          final: () => voiceUi.set({ heard: "" }),
          bargeIn: () => p.stop("barge-in"),
          status,
          eve,
        },
        earsUrl(CORE_HTTP, OVERLAY ? "overlay" : "shell"),
      );
    const attach = (r: Ears, startNow: boolean) => {
      // Disposed, or Eve Live took the mic while the stt probe was in flight.
      if (disposed || live?.active()) return r.dispose();
      rec = r;
      ears = r;
      if (mutedWanted) r.setMuted(true);
      if (startNow) void r.start();
    };

    const startEars = () => {
      if (rec || disposed) return;
      if (MIC) {
        const pref = sttPref(location.search, OVERLAY);
        const browserOk = !!((globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition);
        if (pref === "auto") {
          void earsAvailable(CORE_HTTP).then((avail) => {
            const src = chooseStt(pref, avail, browserOk);
            attach(src === "deepgram" ? useDeepgram() : useBrowser(), src === "deepgram");
          });
        } else if (pref === "deepgram") attach(useDeepgram(), true);
        else attach(useBrowser(), false);
      } else {
        voiceUi.set({ mic: { supported: false, listening: false, ptt: false, error: "mic off (?mic=0)" } });
      }
    };
    startEars();

    // Eve Live: one STT path at a time. On live the classic ears are disposed (mic released),
    // on classic they come back exactly as at boot.
    const lw = MIC
      ? wireLive(client, CORE_HTTP, OVERLAY ? "overlay" : "shell", {
          stop: () => {
            p.stop("voice engine: live");
            rec?.dispose();
            if (ears === rec) ears = null;
            rec = null;
            voiceUi.set({ heard: "" });
          },
          start: startEars,
          mic: (m) => voiceUi.set({ mic: m }),
          speaking: (on) => voiceUi.set({ speaking: on }),
        })
      : null;
    live = lw;

    // Audio + mic both need a gesture in a browser: the first click anywhere does both.
    // Electron's overlay runs with autoplay allowed, so it unlocks right away.
    wireAudioUnlock(() => rec?.start());
    if (OVERLAY) void unlockAudio();
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
      disposed = true;
      lw?.dispose();
      if (live === lw) live = null;
      rec?.dispose();
      if (ears === rec) ears = null;
      p.dispose();
      if (player === p) player = null;
    };
  }, [client]);

  return <>{children}</>;
}
