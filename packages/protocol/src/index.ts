/**
 * The one shared event schema. Every process (the Bun core, the web shell, the
 * Python eye tracker, sponsor adapters) speaks these envelopes over the bus at
 * ws://127.0.0.1:7777/bus. Plain JSON, no codec, so any language can join.
 */

export const BUS_PORT = 7777;
export const BUS_PATH = "/bus";

export interface Envelope<K extends EventType = EventType> {
  type: K;
  /** Epoch ms when the event was created. */
  ts: number;
  /** Which process emitted it: "core", "shell", "eye", "watcher", ... */
  source: string;
  id: string;
  /** Causal parent: a reaction points at the event that caused it. */
  parent?: string;
  data: EventMap[K];
}

export type AnyEnvelope = { [K in EventType]: Envelope<K> }[EventType];

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type Scene = "boot" | "calibration" | "dating" | "convergence" | "emergence" | "desktop" | "swarm" | "architecture";

/** Something on screen a person can look at, tagged with data-gaze in the shell. */
export interface GazeTarget {
  key: string;
  /** Human label, e.g. "Garlic Knockout Ramen, $21, 4.6 stars". */
  label: string;
  kind: "profile-photo" | "profile-prompt" | "profile-meta" | "menu-item" | "restaurant" | "avatar" | "app" | "ui" | "other";
  /** Structured facts the brain can reason over. */
  meta?: Record<string, unknown>;
}

export interface RegionStats {
  dwellMs: number;
  visits: number;
  revisits: number;
  longestMs: number;
}

export type Mood = "neutral" | "happy" | "annoyed" | "thinking" | "surprised" | "smug" | "sad";
export type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "reacting" | "acting" | "sleeping";

export type ReflexDecision = "IGNORE" | "GLANCE" | "REACT" | "COMMENT" | "ASK" | "HELP" | "ACT" | "ESCALATE";
export const REFLEX_DECISIONS: readonly ReflexDecision[] = ["IGNORE", "GLANCE", "REACT", "COMMENT", "ASK", "HELP", "ACT", "ESCALATE"];

export type Urgency = "immediate" | "soon" | "later";

export type PermissionClass = "READ" | "SAFE_ACTION" | "EXTERNAL_SIDE_EFFECT" | "SENSITIVE_ACTION";

/** What matt is doing on screen, as judged from the focused window (docs/SCREEN.md). */
export type ScreenMode = "coding" | "debugging" | "reading" | "writing" | "shopping" | "social" | "video" | "gaming" | "idle";
export const SCREEN_MODES: readonly ScreenMode[] = ["coding", "debugging", "reading", "writing", "shopping", "social", "video", "gaming", "idle"];

export type ExecutionMode ="DO_MYSELF" | "SPAWN_ONE" | "SPAWN_SWARM" | "ASK_USER";
export type SwarmAgentState = "spawning" | "assigned" | "working" | "waiting" | "done" | "failed" | "merging" | "despawned";

/** Named numeric traits. Candidates, preferences and personas all share this shape. */
export type TraitVector = Record<string, number>;

export interface Persona {
  name: string;
  tagline: string;
  description: string;
  personality: string;
  scenario: string;
  /** Behavioral dials in 0..1 derived from the preference vector. */
  dials: {
    humor: number;
    sarcasm: number;
    warmth: number;
    initiative: number;
    verbosity: number;
    chaos: number;
  };
  voice: { provider: string; voiceId: string; style: string };
  palette: { hue: number };
  vector: TraitVector;
}

export interface RelationshipState {
  banter: number;
  warmth: number;
  initiative: number;
  verbosity: number;
  confidence: number;
}

export interface MemoryRecord {
  id: string;
  kind: "episodic" | "preference" | "fact";
  content: string;
  importance: number;
  confidence: number;
  source: string;
  createdAt: number;
  lastRecalledAt?: number;
  tags?: string[];
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
}

export interface SpeechMark {
  /** Character offset in the segment text where the mark fires. */
  at: number;
  mood?: Mood;
  intensity?: number;
  pauseS?: number;
}

// ---------------------------------------------------------------------------
// Event map: type string -> payload
// ---------------------------------------------------------------------------

export interface EventMap {
  // --- system -------------------------------------------------------------
  "bus.hello": { client: string; role: "core" | "shell" | "sensor" | "adapter" | "observer"; version: string };
  "bus.welcome": { clientId: string; peers: string[]; world: WorldSnapshot };
  "timer.tick": { n: number };
  diag: { label: string; value: string; ttlMs?: number };
  "error": { where: string; message: string };

  // --- perception: eyes (attention only, never clicks) -----------------------
  "eye.status": { connected: boolean; calibrated: boolean; accuracyDeg?: number; facePresent?: boolean };
  /** Raw-ish gaze point in viewport css px, ~30Hz, only forwarded when someone subscribes. */
  "gaze.point": { x: number; y: number; nx: number; ny: number };
  "gaze.fixation": { target: GazeTarget | null; x: number; y: number };
  "gaze.fixation_end": { target: GazeTarget | null; ms: number };
  /** Stable attention target: same element on consecutive fixations. The "this" in "what about this". */
  "gaze.target": { target: GazeTarget; dwellMs: number; confidence: number };
  "gaze.lost": { reason: "away" | "no_face" | "offscreen" };

  // --- perception: ears, desktop, pages --------------------------------------
  "voice.partial": { text: string };
  "voice.final": { text: string; confidence?: number };
  /** One conversational turn: voice.final pieces merged across short pauses ("talk, pause, keep talking"). */
  "voice.turn": { text: string; parts: number };
  /** A line of the conversation she's having with him (his addressed turns, her spoken lines). */
  "conversation.turn": { role: "user" | "eve"; text: string };
  "app.opened": { app: string; bundleId?: string };
  "app.focused": { app: string; bundleId?: string; title?: string };
  "page.context": { url: string; title: string; targets: GazeTarget[]; markdown?: string };
  "media.play": { track: string; artist?: string };
  "shell.scene": { scene: Scene };
  "shell.ready": { width: number; height: number; audioUnlocked: boolean };
  "shell.key": { key: string };
  /** Pause / resume ambient attention (screen watching, unprompted remarks). Direct speech still works. */
  "attention.pause": { paused: boolean; by?: string };

  // --- act I: eigenvector -------------------------------------------------------
  "dating.view": { candidateId: string; index: number; total: number };
  "dating.leave": { candidateId: string; regions: Record<string, RegionStats>; totalMs: number; skipLatencyMs: number };
  "dating.signal": {
    candidateId: string;
    interest: { skip: number; neutral: number; inspect: number; positive: number };
    strength: number;
    reward: number;
    by: string;
  };
  "preference.update": { vector: TraitVector; deltas: TraitVector; progress: number; observations: number };
  "preference.converged": { vector: TraitVector; persona: Persona };

  // --- act II/III: companion ----------------------------------------------------
  /** restored: she was already born before a core restart; skip the emergence animation. */
  "companion.born": { persona: Persona; restored?: boolean; /** Woken with a default persona (no Act I), e.g. by the desktop overlay. */ woken?: boolean };
  "reflex.decision": {
    trigger: string;
    decision: ReflexDecision;
    scores: Partial<Record<ReflexDecision, number>>;
    urgency: Urgency;
    by: string;
    latencyMs: number;
    reason?: string;
  };
  "speech.begin": { utteranceId: string; text: string; brain: string };
  /** One speakable chunk. audioUrl is fetched from core over http, marks fire as it plays. */
  "speech.segment": { utteranceId: string; seq: number; text: string; marks: SpeechMark[]; audioUrl?: string };
  "speech.end": { utteranceId: string; interrupted: boolean };
  "speech.stop": { reason: string };
  "speech.played": { utteranceId: string; seq: number };
  "avatar.mood": { mood: Mood; intensity: number; holdMs?: number };
  "avatar.state": { state: AvatarState };
  "avatar.look": { targetKey: string | null; ms: number };
  /** What she has on now (wardrobe item ids, see wardrobe.ts). Full state, not a delta. */
  "avatar.outfit": { items: string[]; by: "user" | "agent" | "restore" };
  /** The shell loaded an avatar model; `wardrobe` = the item ids that model can show. */
  "avatar.model": { id: string; wardrobe: string[] };
  /** The user clicked her (desktop overlay / shell column). count = pokes in the last few seconds. */
  "avatar.poke": { region: "head" | "body"; count: number };
  /** Every touch reaction in the overlay / shell column (she answers each with a short line). */
  "avatar.touch": {
    kind: "pat" | "poke" | "annoyed" | "drag" | "drop" | "boop" | "ears" | "chest" | "tickle";
    region?: "head" | "face" | "ears" | "chest" | "belly" | "body";
    count?: number;
  };
  /** Matt named her (onboarding, or "call you X"). The world persona name follows; "Eve" is the default. */
  "companion.rename": { name: string; by: "onboarding" | "user" | "restore" };
  /** Spoken first-run onboarding (docs/KNOW_ME.md): which question she's on, for a progress chip. */
  "onboarding.state": {
    status: "active" | "paused" | "done" | "idle";
    /** Step id she's asking right now ("name", "herName", "work", "interests", "birthday", "boundaries"), null when not asking. */
    step: string | null;
    /** 0-based index of the current step. */
    index: number;
    total: number;
    /** Steps answered (not skipped) so far. */
    answered: number;
  };
  "memory.recall": { query: string; hits: MemoryHit[]; ms: number; by: string };
  "memory.write": { record: MemoryRecord; policy: MemoryWritePolicy };
  "relationship.update": { state: RelationshipState; delta: Partial<RelationshipState>; reason: string };

  // --- act IV: agency ---------------------------------------------------------------
  "task.start": { taskId: string; goal: string; brain: string };
  "task.done": { taskId: string; ok: boolean; summary: string; ms: number };
  "swarm.spawn": {
    taskId: string;
    agentId: string;
    role: string;
    label: string;
    parentId?: string;
    /** Harem wife display name and glyph, e.g. "Miso", "🍜". */
    name?: string;
    emoji?: string;
    goal?: string;
    /** Which Act I candidate she is (candidates.ts id), for her portrait. */
    candidateId?: string;
  };
  "swarm.progress": { taskId: string; agentId: string; text: string };
  "swarm.done": { taskId: string; agentId: string; ok: boolean; result: string };
  /** Eve's routing call before any wife exists. */
  "swarm.plan": { taskId: string; mode: ExecutionMode; confidence: number; workers: { role: string; goal: string }[] };
  /** Card lifecycle: drives the harem room animations. */
  "swarm.status": { taskId: string; agentId: string; state: SwarmAgentState; tool?: string; confidence?: number };
  /** Two wives' structured results disagree. lines are one short in-character quip each. */
  "swarm.conflict": { taskId: string; conflictId: string; topic: string; a: string; b: string; lines: { agentId: string; text: string }[] };
  /** winner: the agentId whose side Eve took, when there was one. */
  "swarm.resolve": { taskId: string; conflictId: string; text: string; winner?: string };
  /** Wives fold back into Eve. retained is what goes to memory, discarded counts dropped raw scrape/tool chatter. */
  "swarm.merge": { taskId: string; agentIds: string[]; retained: string[]; discarded: number };
  "action.request": {
    actionId: string;
    taskId?: string;
    kind: string;
    permission: PermissionClass;
    description: string;
    args: Record<string, unknown>;
    needsApproval: boolean;
  };
  "action.approval": { actionId: string; approved: boolean; by: "voice" | "key" | "policy" };
  "action.result": { actionId: string; ok: boolean; observation: string };
  "home.status": { online: boolean; host: string; uptimeMs: number; memories: number; tasks: number; lastSyncAt?: number };

  // --- work: Eve as a coworker (docs/WORK.md) ------------------------------------
  /**
   * What matt is working on, coarse and app-level: the frontmost app, its window
   * title, and the git repo behind it. Never screen contents. private: a
   * denylisted app (password manager, Messages, banking): title and repo are omitted.
   */
  "work.context": {
    app: string;
    bundleId?: string;
    title?: string;
    repo?: string;
    repoPath?: string;
    branch?: string;
    dirty?: number;
    lastCommit?: string;
    private?: boolean;
  };
  /** A Claude Code session (watcher/claude-hook.ts) did something. cwd is where it runs. */
  "work.claude": { event: "prompt" | "tool" | "test" | "stop"; cwd?: string; sessionId?: string; tool?: string; ok?: boolean };
  // --- screen: what's on matt's screen (docs/SCREEN.md) ---------------------------
  /**
   * Level 2: a compact, locally summarized and redacted read of the focused
   * window (never raw text). private: denylisted app/domain or judged sensitive,
   * so title and summary are omitted. stuckMs: how long the same error has been
   * on screen.
   */
  "screen.observation": {
    app: string;
    title?: string;
    summary: string;
    scores: { mode: ScreenMode; stuck: boolean; interesting: number; sensitive: boolean };
    by: "jev" | "local";
    private?: boolean;
    error?: string;
    stuckMs?: number;
    /** Typing in a code/writing app right now: stay quiet. */
    focus?: boolean;
    /** Site host for browsers (never the full URL). */
    host?: string;
  };
  /** Level 3: a one-off look at the focused window, described by a vision model. The image is never stored. */
  "screen.vision": { app: string; title?: string; reason: "deictic" | "stuck" | "auto"; description: string; by: string; ms: number; ok: boolean };
  /** She is reading the screen right now: drives the "looking" chip. level 2 = accessibility text flash, 3 = window capture. */
  "screen.looking": { level: 2 | 3; active: boolean; reason?: string };
  /** Pause / resume screen awareness only (tray "Pause screen", cmd+shift+P). Persisted in ~/.eve/screen.json. */
  "screen.pause": { paused: boolean; by?: string };
  /** macOS permissions the screen sense needs (Accessibility for level 2, Screen Recording for level 3). */
  "screen.permission": { accessibility: boolean; screenRecording: boolean | null };

  /** Eve's own coding task lifecycle: drives the "working on" chip. */
  "work.task": {
    taskId: string;
    title: string;
    state: "starting" | "working" | "testing" | "review" | "merging" | "done" | "failed" | "kept";
    repo?: string;
    branch?: string;
    detail?: string;
  };

  // --- agent cursor: Eve's own pointer on the desktop (docs/AGENT_CURSOR.md) --------
  /**
   * Where Eve's own cursor goes and what it does there, in macOS screen points
   * (top-left origin, same space as Electron's screen API). Purely visual: the
   * real work happens in her browser or through AppleScript. matt's cursor is never moved.
   * ms: glide duration hint for "move" (agentGlideMs when absent).
   */
  "agent.cursor": { x: number; y: number; space: "screen"; action: AgentCursorAction; label?: string; target?: string; ms?: number };
  /** Her visible browser window (Playwright Chromium) opened, moved, or closed. bounds in screen points. */
  "agent.browser": { status: "open" | "closed"; bounds?: ScreenRect; url?: string };

  // --- voice engine: classic cascade vs Eve Live (docs/LIVE.md) ----------------------
  /**
   * Which voice path owns the mic and her voice. classic = ears (STT) + brains +
   * speech (TTS). live = one full-duplex gpt-live-1 session. Only one STT path
   * is active at a time: ears stand down while live, and the other way round.
   * Persisted in ~/.eve/voice.json.
   */
  "voice.engine": { engine: VoiceEngine; by: "tray" | "voice" | "env" | "api" | "restore" | "fallback" | "cost"; reason?: string };
  /** Eve Live session lifecycle, for the tray / HUD chip. usedMin / capMin: today's live minutes vs the daily cap. */
  "live.state": {
    status: LiveStatus;
    provider?: "gateway" | "openai";
    voice?: string;
    /** Human readable: why it's off, what's missing ("Eve Live needs OpenAI or gateway credits"). */
    reason?: string;
    usedMin?: number;
    capMin?: number;
    sessionId?: string;
  };
}

export type VoiceEngine = "classic" | "live";
/** off: classic engine. idle: live engine, session closed until he talks. no_access: missing key or credits. */
export type LiveStatus = "off" | "connecting" | "live" | "idle" | "closing" | "no_access" | "capped" | "error";

/** point: shared attention, a small wiggle at something she is talking about. */
export type AgentCursorAction = "move" | "click" | "type" | "scroll" | "hover" | "point" | "idle";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type EventType = keyof EventMap;

export type MemoryWritePolicy = "IGNORE_EVENT" | "STORE_SHORT_TERM" | "STORE_LONG_TERM" | "UPDATE_PREFERENCE" | "UPDATE_RELATIONSHIP";

// ---------------------------------------------------------------------------
// World state: the single object every brain reads from.
// ---------------------------------------------------------------------------

export interface WorldSnapshot {
  scene: Scene;
  user: {
    speaking: boolean;
    lastUtterance?: string;
    lastUtteranceAt?: number;
    gazeTarget: GazeTarget | null;
    gazeTargetAt?: number;
    attentionConfidence: number;
    facePresent: boolean;
  };
  desktop: {
    activeApp?: string;
    page?: { url: string; title: string; targets: GazeTarget[] };
  };
  companion: {
    born: boolean;
    persona?: Persona;
    state: AvatarState;
    mood: Mood;
    lastSpokeAt?: number;
    relationship: RelationshipState;
  };
  preference: { vector: TraitVector; progress: number; observations: number };
  tasks: { active: number; done: number };
  /** Free-form named context slots, rendered as bullets into prompts. */
  slots: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
export function newId(prefix = "e"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function envelope<K extends EventType>(type: K, data: EventMap[K], source: string, parent?: string): Envelope<K> {
  return { type, ts: Date.now(), source, id: newId(), ...(parent ? { parent } : {}), data };
}

/** Structural check for anything arriving off the wire. Payload shape is trusted per type. */
export function isEnvelope(x: unknown): x is AnyEnvelope {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.type === "string" &&
    typeof e.ts === "number" &&
    typeof e.source === "string" &&
    typeof e.id === "string" &&
    typeof e.data === "object" &&
    e.data !== null
  );
}

export function parseEnvelope(raw: string): AnyEnvelope | null {
  try {
    const x = JSON.parse(raw);
    return isEnvelope(x) ? x : null;
  } catch {
    return null;
  }
}

/** Glob-ish type match: "gaze.*" matches "gaze.target", "*" matches everything. */
export function matchesType(pattern: string, type: string): boolean {
  if (pattern === "*" || pattern === type) return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return false;
}

export const MOODS: readonly Mood[] = ["neutral", "happy", "annoyed", "thinking", "surprised", "smug", "sad"];

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export const DEFAULT_RELATIONSHIP: RelationshipState = {
  banter: 0.6,
  warmth: 0.55,
  initiative: 0.6,
  verbosity: 0.3,
  confidence: 0.5,
};

export function emptyWorld(): WorldSnapshot {
  return {
    scene: "boot",
    user: { speaking: false, gazeTarget: null, attentionConfidence: 0, facePresent: false },
    desktop: {},
    companion: { born: false, state: "sleeping", mood: "neutral", relationship: { ...DEFAULT_RELATIONSHIP } },
    preference: { vector: {}, progress: 0, observations: 0 },
    tasks: { active: 0, done: 0 },
    slots: {},
  };
}
export * from "./world";
export * from "./wardrobe";
export * from "./candidates";
export * from "./cursor";
export * from "./live";
