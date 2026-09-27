import type { VoiceEngine } from "@eigenwife/protocol";

/**
 * The spoken toggle: "switch to live mode", "go live", "go back to classic",
 * "use your normal voice". Anchored to the whole utterance (with a little
 * lead-in) so talk ABOUT live mode never flips it.
 */
const LEAD = /^(?:(?:yo|hey|ok(?:ay)?|eve|so|alright|aight)[,\s]+)*(?:(?:can|could|would) you\s+|please\s+|let'?s\s+)?/i;
const TAIL = /(?:\s+(?:please|pls|eve|now|rn|for me|real quick))*[\s.!?]*$/i;

const TO_LIVE = [
  /^(?:switch|go|change|flip|move|turn|put)(?:\s+(?:it|us|yourself|over|the voice|your voice|the engine))?\s+(?:to|into|on)\s+(?:the\s+)?live(?:\s+(?:mode|voice|engine))?$/i,
  /^(?:go|turn on|enable|start|try)\s+(?:eve\s+)?live(?:\s+(?:mode|voice))?$/i,
  /^live\s+mode(?:\s+on)?$/i,
];

const TO_CLASSIC = [
  /^(?:switch|go|change|flip|move|turn|put)(?:\s+(?:it|us|yourself|over|the voice|your voice|the engine))?(?:\s+back)?\s+(?:to|into)\s+(?:the\s+|your\s+)?(?:classic|normal|regular|old|usual|original)(?:\s+(?:mode|voice|engine))?$/i,
  /^(?:go back|back to)(?:\s+to)?\s+(?:the\s+|your\s+)?(?:classic|normal|regular|old|usual|original)(?:\s+(?:mode|voice|engine))?$/i,
  /^(?:turn off|disable|stop|exit|leave)\s+(?:eve\s+)?live(?:\s+(?:mode|voice))?$/i,
  /^(?:classic|normal)\s+mode(?:\s+on)?$/i,
  /^use\s+your\s+(?:normal|classic|usual|regular|old)\s+voice$/i,
];

export function readSwitch(text: string): VoiceEngine | null {
  const t = text.trim().replace(LEAD, "").replace(TAIL, "").trim();
  if (!t || t.split(/\s+/).length > 9) return null;
  if (TO_LIVE.some((re) => re.test(t))) return "live";
  if (TO_CLASSIC.some((re) => re.test(t))) return "classic";
  return null;
}
