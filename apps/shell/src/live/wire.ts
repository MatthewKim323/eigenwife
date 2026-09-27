import type { BusClient } from "@eigenwife/protocol/client";
import type { LiveStatus, VoiceEngine } from "@eigenwife/protocol";
import { avatarRuntime, createStore } from "../avatar/store";
import { getAudioContext } from "../voice/audio";
import type { MicStatus } from "../voice/recognition";
import { LiveClient } from "./client";

/** Engine + session state for the HUD / mic lamp (from voice.engine and live.state). */
export interface LiveUi {
  engine: VoiceEngine;
  status: LiveStatus;
  reason?: string;
  usedMin?: number;
  capMin?: number;
  voice?: string;
}

export const liveUi = createStore<LiveUi>({ engine: "classic", status: "off" });

/** One line for the mic lamp / tray tooltip. */
export function liveLabel(s: LiveUi): string | null {
  if (s.status === "no_access" || s.status === "capped" || s.status === "error") return s.reason ?? "eve live unavailable";
  if (s.engine !== "live") return null;
  switch (s.status) {
    case "connecting":
      return "eve live: connecting";
    case "idle":
      return "eve live: asleep, talk to wake her";
    case "live":
      return s.capMin ? `eve live (${Math.round(s.usedMin ?? 0)}/${s.capMin} min today)` : "eve live";
    default:
      return null;
  }
}

export interface LiveWiring {
  /** Live owns the mic and her voice right now. */
  active(): boolean;
  setMuted(on: boolean): void;
  dispose(): void;
}

/**
 * Hooks Eve Live into the voice provider: the live client owns the mic while
 * the engine is live (the classic ears stand down: one STT path at a time),
 * drives her mouth from the live output analyser, and mirrors engine state.
 */
export function wireLive(
  bus: BusClient,
  coreHttp: string,
  role: "overlay" | "shell",
  ears: { stop(): void; start(): void; mic(s: MicStatus): void; speaking(on: boolean): void },
): LiveWiring {
  let active = false;
  const live = new LiveClient(
    coreHttp,
    role,
    {
      mouth: (value, speaking) => {
        if (!active) return;
        avatarRuntime.mouth = value;
        avatarRuntime.mouthHold = false;
        avatarRuntime.speaking = speaking;
        ears.speaking(speaking);
      },
      engine: (engine, owner) => {
        const next = engine === "live" && owner;
        if (next === active) return;
        active = next;
        if (active) ears.stop();
        else {
          avatarRuntime.mouth = 0;
          avatarRuntime.speaking = false;
          ears.speaking(false);
          ears.start();
        }
      },
      mic: (s) => ears.mic({ supported: true, listening: s.listening, ptt: false, muted: s.muted, source: "live", error: s.error ?? (s.idle ? "live: asleep, talk to wake her" : undefined) }),
      log: (...a) => console.warn(...a),
    },
    {
      WebSocket,
      RTCPeerConnection: typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : undefined,
      getUserMedia: typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia ? (c) => navigator.mediaDevices.getUserMedia(c) : undefined,
      audio: getAudioContext,
      raf: (fn) => requestAnimationFrame(fn),
      caf: (id) => cancelAnimationFrame(id),
    },
  );
  const offs = [
    bus.on("voice.engine", (e) => liveUi.set({ engine: e.data.engine })),
    bus.on("live.state", (e) => liveUi.set({ status: e.data.status, reason: e.data.reason, usedMin: e.data.usedMin, capMin: e.data.capMin, voice: e.data.voice })),
  ];
  live.start();
  return {
    active: () => active,
    setMuted: (on) => live.setMuted(on),
    dispose() {
      offs.forEach((o) => o());
      live.dispose();
    },
  };
}
