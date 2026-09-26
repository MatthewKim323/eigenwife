import { useStore } from "../avatar/store";
import { voiceUi } from "./VoiceProvider";

/** Tiny mic lamp + what she's hearing. Space = push-to-talk. */
export function MicIndicator({ placement }: { placement: "stage" | "column" | "hidden" }) {
  const mic = useStore(voiceUi, (s) => s.mic);
  const heard = useStore(voiceUi, (s) => s.heard);
  if (placement === "hidden") return null;
  const state = mic.muted ? "off" : !mic.supported || mic.error ? "off" : mic.ptt ? "ptt" : mic.listening ? "on" : "idle";
  const label =
    state === "off"
      ? mic.muted ? "mic muted" : (mic.error ?? "no speech recognition (use chrome)")
      : state === "ptt"
        ? "listening (space)"
        : state === "on"
          ? "listening"
          : "click to wake mic";
  return (
    <div className="eve-mic mono" data-state={state} data-placement={placement}>
      <span className="eve-mic-dot" />
      <span className="eve-mic-label">{heard ? `“${heard}”` : label}</span>
    </div>
  );
}
