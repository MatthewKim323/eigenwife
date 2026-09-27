import { LIVE_PATH, MOODS, parseLive, type AnyEnvelope, type Mood, type AvatarState, type LiveDown, type LiveStatus, type LiveUp, type VoiceEngine } from "@eigenwife/protocol";
import type { CoreContext, SocketPeer } from "../context";
import type { SayOptions, SpeechService } from "../services";
import { conversationFor } from "../brains/module";
import { DEFAULT_EVE, renamePersona } from "../brains/prompt";
import { NO_ACCESS_REASON, providerOrder, type LiveConfig } from "./config";
import { Delegations } from "./delegation";
import { buildInstructions, contextKey, contextUpdate, startupHistory, type LiveContext } from "./instructions";
import { finishedSentences, moodOf } from "./mood";
import { LiveAccessError, gatewayPlan, isAccessProblem, openaiAnswer, sessionConfig, type Fetcher } from "./provider";
import { readSwitch } from "./switch";
import { isBackchannel, realSchedule, Side, type Schedule } from "./transcript";
import { UsageMeter, type UsageFile } from "./usage";

/**
 * Eve Live (docs/LIVE.md): the core half of the gpt-live-1 voice engine.
 *
 *   page (shell/overlay)                 core (this)                     bus
 *   mic + speaker <-> gpt-live-1         mints creds, session config     voice.partial/final/turn
 *   forwards server events ----------->  transcripts -> bus parity  ---> conversation.turn, speech.begin/end
 *   sends what the core asks <---------  delegation -> reflex/agency ---> avatar.state/mood, live.state
 *
 * The speech service is wrapped: while a live session runs, lines other
 * modules would have spoken through TTS go to the voice model instead
 * (commentary), and reflex's direct replies to his live words are dropped
 * because the voice model already answered them. With the classic engine
 * the wrapper is a pass-through.
 */

export interface ControllerOptions {
  fetch?: Fetcher;
  now?: () => number;
  schedule?: Schedule;
  /** Cost/idle/context check interval. */
  tickMs?: number;
  /** His words end after this much transcript silence. */
  userGapMs?: number;
  /** Her line ends after this much transcript silence. */
  eveGapMs?: number;
  /** Wait this long for session.closed after session.close. */
  closeTimeoutMs?: number;
  delegationFallbackMs?: number;
}

interface Owner {
  peer: SocketPeer;
  role: "overlay" | "shell";
  audio: boolean;
}

interface Session {
  key: string;
  provider: "gateway" | "openai";
  started: boolean;
  id?: string;
  closing: boolean;
  config: Record<string, unknown>;
  greet: string | null;
  opened: number;
}

const DIRECT_REPLY_MS = 20_000;

export class LiveController {
  engine: VoiceEngine = "classic";
  status: LiveStatus = "off";
  reason: string | undefined;
  private cfg: LiveConfig;
  private fetch: Fetcher;
  private now: () => number;
  private schedule: Schedule;
  private peers = new Map<string, { peer: SocketPeer; role: "overlay" | "shell"; audio: boolean }>();
  private owner: Owner | null = null;
  private session: Session | null = null;
  private tried: ("gateway" | "openai")[] = [];
  private failures = 0;
  private meter: UsageMeter;
  private warned = false;
  private lastActivity = 0;
  private user: Side;
  private eve: Side;
  private eveUtterance: string | null = null;
  private eveMoodAt = 0;
  private eveSentences = 0;
  private playback = false;
  private avatar: AvatarState | null = null;
  /** voice.final ids he said live (reflex trigger parents), with when. */
  private liveUtterances = new Map<string, number>();
  /** voice.final ids that were engine switches: reflex's reply to them is dropped in both modes. */
  private switchUtterances = new Set<string>();
  private lastUserFinal: { id: string; text: string; at: number } | null = null;
  private waitingReply: ((text: string) => void)[] = [];
  private approvals = new Set<string>();
  private approvalDiag = false;
  private ctxKey = "";
  private ctxAt = 0;
  private delegations: Delegations;
  private inner: SpeechService | null = null;
  private offs: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private closeCancel: (() => void) | null = null;
  private seq = 0;
  private opts: ControllerOptions;

  constructor(
    private ctx: CoreContext,
    cfg: LiveConfig,
    opts: ControllerOptions = {},
    savedUsage?: UsageFile | null,
  ) {
    this.cfg = cfg;
    this.opts = opts;
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? realSchedule;
    this.meter = new UsageMeter(this.now, savedUsage);
    this.user = new Side(
      {
        start: () => {
          this.activity();
          this.setAvatar("listening");
        },
        grow: (text) => this.ctx.bus.emit("voice.partial", { text }, "live"),
        end: (text) => this.userDone(text),
      },
      opts.userGapMs ?? 700,
      this.schedule,
      this.now,
    );
    this.eve = new Side(
      {
        start: () => this.eveStart(),
        grow: (text) => this.eveGrow(text),
        end: (text, why) => this.eveDone(text, why),
      },
      opts.eveGapMs ?? 1200,
      this.schedule,
      this.now,
    );
    this.delegations = new Delegations({
      ctx,
      send: (event) => this.send(event),
      now: this.now,
      schedule: this.schedule,
      log: (...a) => this.log(...a),
      conversation: () => conversationFor(ctx).block(this.persona().name),
      approvalPending: () => this.approvals.size > 0 || this.approvalDiag,
      changed: () => this.syncAvatar(),
      fallbackMs: opts.delegationFallbackMs,
    });
  }

  private log(...a: unknown[]) {
    this.ctx.log("live", ...a);
  }

  // --- lifecycle ------------------------------------------------------------------

  start(inner: SpeechService | null, engine: VoiceEngine, by: "env" | "restore") {
    this.inner = inner;
    this.engine = engine;
    this.ctx.provide("speech", this.speechService());
    this.ctx.socket(LIVE_PATH, {
      open: (peer) => this.peers.set(peer.id, { peer, role: "shell", audio: false }),
      message: (peer, data) => {
        const m = parseLive<LiveUp>(typeof data === "string" ? data : new TextDecoder().decode(data));
        if (m) this.onUp(peer, m);
      },
      close: (peer) => this.onPeerClose(peer),
    });
    this.offs.push(this.ctx.bus.on("*", (e: AnyEnvelope) => this.onBus(e)));
    const tickMs = this.opts.tickMs ?? 5000;
    if (tickMs > 0) {
      this.tickTimer = setInterval(() => this.tick(), tickMs);
      (this.tickTimer as { unref?: () => void }).unref?.();
    }
    this.ctx.bus.emit("voice.engine", { engine, by }, "live");
    if (engine === "live") this.gate();
    this.emitState();
  }

  stop() {
    for (const off of this.offs.splice(0)) off();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.endSession("core stopping", true);
    this.user.dispose();
    this.eve.dispose();
  }

  /** Switch engines. Resolves once the switch is decided (sessions open in the background). */
  async setEngine(engine: VoiceEngine, by: "tray" | "voice" | "api" | "fallback" | "cost", reason?: string): Promise<{ engine: VoiceEngine; status: LiveStatus; reason?: string }> {
    if (engine === "live" && this.meter.minutes() >= this.cfg.dailyCapMin) {
      this.reason = `used today's ${this.cfg.dailyCapMin} live minutes`;
      this.status = "capped";
      this.emitState();
      if (by === "voice") void this.innerSay("[mood:sad 0.5] i'm out of live minutes for today. staying on my usual voice.");
      return { engine: this.engine, status: this.status, reason: this.reason };
    }
    if (engine === "live" && !providerOrder(this.cfg).length) {
      this.status = "no_access";
      this.reason = `${NO_ACCESS_REASON} (no AI_GATEWAY_API_KEY or OPENAI_API_KEY)`;
      this.emitState();
      if (by === "voice") void this.innerSay("[mood:sad 0.5] can't go live. i need openai or gateway credits for that.");
      return { engine: this.engine, status: this.status, reason: this.reason };
    }
    const changed = engine !== this.engine;
    this.engine = engine;
    if (changed || by === "fallback" || by === "cost") {
      this.ctx.bus.emit("voice.engine", { engine, by, ...(reason ? { reason } : {}) }, "live");
      void this.persist();
    }
    if (engine === "classic") {
      this.endSession(reason ?? `switched to classic (${by})`, false);
      this.status = this.status === "no_access" || this.status === "capped" ? this.status : "off";
      if (by !== "fallback" && by !== "cost") this.reason = undefined;
      if (by === "voice" && changed) void this.innerSay("[mood:happy 0.6] okay. back to my usual voice.");
    } else {
      this.tried = [];
      this.failures = 0;
      this.warned = false;
      this.reason = undefined;
      if (changed) this.pendingGreet = by === "voice" || by === "tray" ? by : null;
      this.gate();
    }
    this.sendEngine();
    this.emitState();
    return { engine: this.engine, status: this.status, reason: this.reason };
  }

  private pendingGreet: "voice" | "tray" | null = null;

  private async persist() {
    try {
      await this.ctx.tryUse("home")?.write("voice", { engine: this.engine, updatedAt: this.now() });
    } catch {}
  }

  snapshot() {
    return {
      engine: this.engine,
      status: this.status,
      reason: this.reason,
      provider: this.session?.provider,
      sessionId: this.session?.id,
      voice: this.cfg.voice,
      model: this.cfg.model,
      providers: providerOrder(this.cfg),
      usedMin: Math.round(this.meter.minutes() * 10) / 10,
      capMin: this.cfg.dailyCapMin,
      owner: this.owner ? this.owner.role : null,
      delegations: this.delegations.list().map((d) => ({ id: d.id, userText: d.userText, decision: d.decision, taskId: d.taskId })),
    };
  }

  private emitState() {
    this.ctx.bus.emit(
      "live.state",
      {
        status: this.status,
        ...(this.session ? { provider: this.session.provider } : {}),
        voice: this.cfg.voice,
        ...(this.reason ? { reason: this.reason } : {}),
        usedMin: Math.round(this.meter.minutes() * 10) / 10,
        capMin: this.cfg.dailyCapMin,
        ...(this.session?.id ? { sessionId: this.session.id } : {}),
      },
      "live",
    );
  }

  // --- page relay -----------------------------------------------------------------

  private down(m: LiveDown, to: SocketPeer | null = this.owner?.peer ?? null) {
    try {
      to?.send(JSON.stringify(m));
    } catch {}
  }

  private send(event: Record<string, unknown>) {
    const s = this.session;
    if (!s || !s.started || s.closing) return;
    this.down({ type: "send", key: s.key, event });
  }

  private sendEngine() {
    for (const p of this.peers.values()) this.down({ type: "engine", engine: this.engine, owner: this.owner?.peer.id === p.peer.id }, p.peer);
  }

  private pickOwner() {
    const cands = [...this.peers.values()].filter((p) => p.audio);
    const next = cands.find((p) => p.role === "overlay") ?? cands[0] ?? null;
    if (next?.peer.id === this.owner?.peer.id) return;
    const hadSession = !!this.session;
    if (hadSession) this.endSession("audio owner changed", true);
    this.owner = next ? { peer: next.peer, role: next.role, audio: next.audio } : null;
    this.sendEngine();
    if (this.engine === "live") this.gate();
  }

  private onUp(peer: SocketPeer, m: LiveUp) {
    if (m.type === "hello") {
      this.peers.set(peer.id, { peer, role: m.role === "overlay" ? "overlay" : "shell", audio: !!m.audio });
      this.pickOwner();
      this.down({ type: "engine", engine: this.engine, owner: this.owner?.peer.id === peer.id }, peer);
      if (this.status === "idle" && this.owner?.peer.id === peer.id) this.down({ type: "idle", idle: true }, peer);
      return;
    }
    if (peer.id !== this.owner?.peer.id) return;
    const s = this.session;
    switch (m.type) {
      case "activity":
        if (this.engine === "live" && !this.session && this.status === "idle") {
          this.log("voice activity: reopening");
          this.gate();
        }
        return;
      case "playback":
        this.playback = m.speaking;
        return;
      case "offer":
        if (s && m.key === s.key) void this.answer(s, m.sdp);
        return;
      case "opened":
        return;
      case "event":
        if (s && m.key === s.key) this.onEvent(s, m.event);
        return;
      case "fail":
        if (s && m.key === s.key) this.onFail(s, m.message);
        return;
      case "closed":
        if (s && m.key === s.key) this.onTransportClosed(s, m.code, m.reason);
        return;
    }
  }

  private onPeerClose(peer: SocketPeer) {
    this.peers.delete(peer.id);
    if (this.owner?.peer.id === peer.id) {
      if (this.session) this.sessionGone("the page closed");
      this.owner = null;
      this.pickOwner();
    }
  }

  // --- sessions -------------------------------------------------------------------

  /** Open a session if everything lines up: live engine, an audio page, under the cap, not already open. */
  private gate() {
    if (this.engine !== "live" || this.session) return;
    if (this.meter.minutes() >= this.cfg.dailyCapMin) {
      void this.capped();
      return;
    }
    if (!this.owner) {
      this.status = "connecting";
      this.reason = "waiting for the overlay or shell (it plays her live voice)";
      this.emitState();
      return;
    }
    void this.open();
  }

  private liveContext(): LiveContext {
    let relationship = null;
    let user = null;
    try {
      relationship = this.ctx.tryUse("relationship")?.get() ?? this.ctx.world().companion.relationship;
    } catch {}
    try {
      user = this.ctx.tryUse("user")?.profile() ?? null;
    } catch {}
    return { persona: this.persona(), relationship, user, summary: conversationFor(this.ctx).summary, world: this.ctx.contextBlock() };
  }

  private persona() {
    let p = null;
    try {
      p = this.ctx.tryUse("preference")?.persona() ?? this.ctx.world().companion.persona ?? null;
    } catch {
      p = this.ctx.world().companion.persona ?? null;
    }
    let her: string | null = null;
    try {
      her = this.ctx.tryUse("user")?.herName() ?? null;
    } catch {}
    return renamePersona(p ?? DEFAULT_EVE, her);
  }

  /** The session config: persona card + dials + profile + summary + world, recent turns as history. */
  buildSession(provider: "gateway" | "openai"): Record<string, unknown> {
    const c = this.liveContext();
    this.ctxKey = contextKey(c);
    this.ctxAt = this.now();
    return sessionConfig(this.cfg, provider, { instructions: buildInstructions(c), input: startupHistory(conversationFor(this.ctx).turns) });
  }

  /**
   * The cascade talker (packages/core/src/talker) streams an LLM reply in
   * parallel with Jev the moment he speaks. While the voice model owns her
   * voice that would be a wasted call per turn, so it reports itself
   * unavailable (reflex then takes its lazy persona path, which the speech
   * wrapper drops without pulling). Wrapped on the first live session, when
   * every module is up; a pass-through otherwise.
   */
  private talkerWrapped = false;
  private wrapTalker() {
    if (this.talkerWrapped) return;
    const inner = this.ctx.tryUse("talker");
    if (!inner) return;
    this.talkerWrapped = true;
    this.ctx.provide("talker", {
      available: () => !this.running() && inner.available(),
      start: (req) => inner.start(req),
    });
  }

  private async open() {
    this.wrapTalker();
    const order = providerOrder(this.cfg).filter((p) => !this.tried.includes(p));
    const provider = order[0];
    if (!provider) return this.noAccess(this.reason ?? NO_ACCESS_REASON);
    const key = `live_${this.now().toString(36)}_${(this.seq++).toString(36)}`;
    const config = this.buildSession(provider);
    const s: Session = { key, provider, started: false, closing: false, config, greet: this.pendingGreet, opened: this.now() };
    this.pendingGreet = null;
    this.session = s;
    this.status = "connecting";
    this.reason = undefined;
    this.emitState();
    this.down({ type: "idle", idle: false });
    this.log(`connecting via ${provider} (voice ${this.cfg.voice})`);
    if (provider === "openai") {
      this.down({ type: "connect", key, plan: { kind: "webrtc", provider: "openai" } });
      return;
    }
    try {
      const plan = await gatewayPlan(this.cfg, this.fetch, config);
      if (this.session !== s) return;
      this.down({ type: "connect", key, plan });
    } catch (err) {
      if (this.session !== s) return;
      this.openFailed(s, err);
    }
  }

  private async answer(s: Session, sdp: string) {
    try {
      const r = await openaiAnswer(this.cfg, this.fetch, s.config, sdp);
      if (this.session !== s) return;
      s.id = r.sessionId;
      this.down({ type: "answer", key: s.key, sdp: r.sdp, ...(r.sessionId ? { sessionId: r.sessionId } : {}) });
    } catch (err) {
      if (this.session !== s) return;
      this.openFailed(s, err);
    }
  }

  private openFailed(s: Session, err: unknown) {
    const e = err instanceof LiveAccessError ? err : new LiveAccessError("error", err instanceof Error ? err.message : String(err));
    this.log(`${s.provider} failed: ${e.message}`);
    this.down({ type: "teardown", key: s.key });
    this.session = null;
    this.tried.push(s.provider);
    if (e.kind === "no_credits" || e.kind === "no_key") {
      this.reason = `${NO_ACCESS_REASON} (${s.provider}: ${e.message.slice(0, 120)})`;
      if (providerOrder(this.cfg).some((p) => !this.tried.includes(p))) return void this.open();
      return this.noAccess(this.reason);
    }
    this.retryLater(e.message);
  }

  private retryLater(message: string) {
    this.failures += 1;
    this.tried = [];
    if (this.failures >= 3) {
      this.status = "error";
      this.reason = `live kept failing: ${message.slice(0, 160)}`;
      this.emitState();
      void this.setEngine("classic", "fallback", this.reason);
      return;
    }
    this.status = "error";
    this.reason = message.slice(0, 200);
    this.emitState();
    this.schedule(() => this.gate(), 1500 * this.failures);
  }

  private noAccess(reason: string) {
    this.session = null;
    this.status = "no_access";
    this.reason = reason.startsWith(NO_ACCESS_REASON) ? reason : `${NO_ACCESS_REASON} (${reason})`;
    this.log(this.reason);
    this.emitState();
    // Classic keeps her talking; the tray shows why live is off.
    void this.setEngine("classic", "fallback", this.reason);
    void this.innerSay("[mood:sad 0.5] live mode needs credits i don't have. using my usual voice.");
  }

  private onFail(s: Session, message: string) {
    if (s.started) return this.sessionGone(message);
    this.openFailed(s, isAccessProblem(undefined, message) ? new LiveAccessError("no_credits", message) : new LiveAccessError("error", message));
  }

  private onTransportClosed(s: Session, code?: number, reason?: string) {
    if (s.closing) return this.finish(s, undefined);
    if (!s.started) return this.onFail(s, `closed before start${code ? ` (${code})` : ""}${reason ? `: ${reason}` : ""}`);
    this.sessionGone(`connection lost${reason ? `: ${reason}` : ""}`);
  }

  /** The transport died under a running session: count usage, reconnect if still live. */
  private sessionGone(why: string) {
    const s = this.session;
    if (!s) return;
    this.log(`session gone: ${why}`);
    this.finish(s, undefined);
    if (this.engine === "live") this.retryLater(why);
  }

  private finish(s: Session, seconds: number | undefined) {
    if (this.session !== s) return;
    this.closeCancel?.();
    this.closeCancel = null;
    this.meter.end(seconds);
    void this.saveUsage();
    this.session = null;
    this.user.flush();
    this.eve.flush();
    this.delegations.closeAll();
    this.playback = false;
    this.setAvatar("idle");
    if (this.status !== "no_access" && this.status !== "capped" && this.status !== "idle") this.status = this.engine === "live" ? "connecting" : "off";
    this.emitState();
  }

  /** Graceful close: session.close, wait for session.closed (usage), then drop. hard: drop now. */
  private endSession(reason: string, hard: boolean) {
    const s = this.session;
    if (!s) return;
    if (hard || !s.started) {
      this.down({ type: "teardown", key: s.key });
      this.finish(s, undefined);
      return;
    }
    if (s.closing) return;
    s.closing = true;
    this.log(`closing session (${reason})`);
    this.down({ type: "close", key: s.key, reason });
    this.closeCancel = this.schedule(() => {
      this.down({ type: "teardown", key: s.key });
      this.finish(s, undefined);
    }, this.opts.closeTimeoutMs ?? 6000);
  }

  // --- provider events ------------------------------------------------------------

  private onEvent(s: Session, ev: Record<string, unknown>) {
    const type = String(ev.type ?? "");
    switch (type) {
      case "session.started": {
        s.started = true;
        s.id = String((ev.session as { id?: string } | undefined)?.id ?? s.id ?? "") || undefined;
        this.failures = 0;
        this.status = "live";
        this.reason = undefined;
        this.meter.begin();
        this.activity();
        this.log(`live via ${s.provider}${s.id ? ` (${s.id})` : ""}`);
        this.emitState();
        this.setAvatar("idle");
        if (s.greet) {
          this.send({
            type: "session.instructions.append",
            event_id: "greet",
            delegation_id: null,
            content: "He just switched you to live mode. Say one short playful line about it (like you can finally talk over each other now), then listen.",
          });
        }
        return;
      }
      case "session.input_transcript.delta":
        return this.user.push(String(ev.delta ?? ""));
      case "session.output_transcript.delta": {
        const delta = String(ev.delta ?? "");
        // He was talking and she took the turn: his words are done.
        if (this.user.active && !this.eve.active && this.now() - this.user.lastAt > 250) this.user.flush();
        return this.eve.push(delta);
      }
      case "session.delegation.created": {
        const d = ev.delegation as { id?: string } | undefined;
        if (!d?.id) return;
        this.activity();
        this.user.flush();
        const recent = this.lastUserFinal && this.now() - this.lastUserFinal.at < 30_000 ? this.lastUserFinal : null;
        this.delegations.open(d.id, recent?.text ?? "", recent?.id ?? null);
        return;
      }
      case "session.usage.updated": {
        const secs = Number((ev.usage as { seconds?: number } | undefined)?.seconds);
        if (Number.isFinite(secs)) this.meter.report(secs);
        return;
      }
      case "session.closed": {
        const secs = Number((ev.usage as { seconds?: number } | undefined)?.seconds);
        this.log(`session closed (${String(ev.reason ?? "?")}${Number.isFinite(secs) ? `, ${secs}s` : ""})`);
        const wasClosing = s.closing;
        this.down({ type: "teardown", key: s.key });
        this.finish(s, Number.isFinite(secs) ? secs : undefined);
        if (!wasClosing && this.engine === "live") {
          if (ev.reason === "expired") this.gate();
          else this.retryLater(`session closed: ${String(ev.reason ?? "unknown")}`);
        }
        return;
      }
      case "error": {
        const err = (ev.error ?? {}) as { message?: string; code?: string; type?: string };
        const msg = `${err.code ?? err.type ?? "error"}: ${err.message ?? ""}`;
        this.log(`provider error ${msg}`);
        this.ctx.bus.emit("diag", { label: "live", value: msg.slice(0, 160), ttlMs: 8000 }, "live");
        if (!s.started) return this.onFail(s, msg);
        if (isAccessProblem(undefined, msg) && /credit|quota|billing|insufficient|payment|balance/i.test(msg)) {
          this.endSession("out of credits", true);
          this.noAccess(msg);
        }
        return;
      }
      default:
        return;
    }
  }

  // --- his side ---------------------------------------------------------------------

  private userDone(text: string) {
    if (!text) return;
    this.activity();
    const e = this.ctx.bus.emit("voice.final", { text }, "live");
    this.lastUserFinal = { id: e.id, text, at: this.now() };
    this.liveUtterances.set(e.id, this.now());
    for (const [id, at] of this.liveUtterances) if (this.now() - at > 120_000) this.liveUtterances.delete(id);
    this.syncAvatar();
  }

  // --- her side ---------------------------------------------------------------------

  private eveStart() {
    this.activity();
    this.eveUtterance = `live_${this.now().toString(36)}${(this.seq++).toString(36)}`;
    this.eveSentences = 0;
    this.ctx.bus.emit("speech.begin", { utteranceId: this.eveUtterance, text: "", brain: "live" }, "live");
    this.setAvatar("speaking");
  }

  private eveGrow(text: string) {
    this.activity();
    const sentences = finishedSentences(text);
    for (let i = this.eveSentences; i < sentences.length; i++) this.moodFrom(sentences[i]!);
    this.eveSentences = sentences.length;
  }

  private moodFrom(sentence: string) {
    const m = moodOf(sentence);
    if (!m || this.now() - this.eveMoodAt < 600) return;
    this.eveMoodAt = this.now();
    this.ctx.bus.emit("avatar.mood", { mood: m.mood, intensity: m.intensity, holdMs: 2500 }, "live");
  }

  private eveDone(text: string, why: "gap" | "flush") {
    const id = this.eveUtterance;
    this.eveUtterance = null;
    if (!id) return;
    const tail = text.slice(finishedSentences(text).join(" ").length).trim();
    if (tail) this.moodFrom(tail);
    this.ctx.bus.emit("speech.end", { utteranceId: id, interrupted: why === "flush" && this.user.active }, "live");
    // A backchannel ("mhm") while he talks isn't a line of hers.
    if (text && !(isBackchannel(text) && this.user.active)) {
      this.ctx.bus.emit("conversation.turn", { role: "eve", text }, "live");
      for (const w of this.waitingReply.splice(0)) w(text);
    }
    this.syncAvatar();
  }

  private setAvatar(state: AvatarState) {
    if (this.avatar === state) return;
    this.avatar = state;
    this.ctx.bus.emit("avatar.state", { state }, "live");
  }

  private syncAvatar() {
    if (!this.session) return;
    if (this.eve.active) return this.setAvatar("speaking");
    if (this.user.active) return this.setAvatar("listening");
    if (this.delegations.any()) return this.setAvatar("thinking");
    this.setAvatar("idle");
  }

  private activity() {
    this.lastActivity = this.now();
  }

  // --- bus --------------------------------------------------------------------------

  private onBus(e: AnyEnvelope) {
    switch (e.type) {
      case "voice.final": {
        // The spoken toggle works from either engine's ears.
        const want = readSwitch(e.data.text);
        if (want) {
          this.switchUtterances.add(e.id);
          if (this.switchUtterances.size > 20) this.switchUtterances.delete(this.switchUtterances.values().next().value!);
          this.log(`heard "${e.data.text}": ${want}`);
          void this.setEngine(want, "voice");
        }
        break;
      }
      case "action.request":
        if (e.data.needsApproval) this.approvals.add(e.data.actionId);
        break;
      case "action.approval":
      case "action.result":
        this.approvals.delete(e.data.actionId);
        break;
      case "diag":
        if (e.data.label === "approval") this.approvalDiag = e.data.value.startsWith("waiting");
        break;
      case "relationship.update":
      case "companion.rename":
      case "companion.born":
        this.ctxAt = 0;
        break;
    }
    if (this.session?.started) this.delegations.onBus(e);
  }

  // --- periodic: cost guard, idle close, context refresh ----------------------------

  tick() {
    const s = this.session;
    if (!s?.started || s.closing) return;
    void this.saveUsage();
    const used = this.meter.minutes();
    const cap = this.cfg.dailyCapMin;
    if (used >= cap) return void this.capped();
    if (!this.warned && used >= cap - this.cfg.warnMin) {
      this.warned = true;
      this.send({
        type: "session.instructions.append",
        event_id: "cap_warning",
        delegation_id: null,
        content: `In one short sentence, tell him you're almost out of live minutes for today (about ${Math.max(1, Math.round(cap - used))} left) and you'll switch back to your usual voice soon. Then carry on.`,
      });
      this.emitState();
    }
    const idleMs = this.cfg.idleMin * 60_000;
    if (idleMs > 0 && this.now() - this.lastActivity > idleMs && !this.eve.active && !this.user.active && !this.delegations.any() && !this.playback) {
      this.log(`idle ${this.cfg.idleMin} min: closing until he talks`);
      this.endSession("idle", false);
      this.status = "idle";
      this.reason = "quiet for a while: session closed until he talks (saves live minutes)";
      this.down({ type: "idle", idle: true });
      this.emitState();
      return;
    }
    this.refreshContext();
  }

  private refreshContext() {
    const c = this.liveContext();
    const key = contextKey(c);
    const stale = this.now() - this.ctxAt > 120_000;
    if (key === this.ctxKey && !stale) return;
    this.ctxKey = key;
    this.ctxAt = this.now();
    this.send({ type: "session.thinking.append", event_id: `ctx_${this.now().toString(36)}`, delegation_id: null, content: contextUpdate(c) });
  }

  private async capped() {
    this.log(`daily cap reached (${this.cfg.dailyCapMin} min)`);
    this.reason = `used today's ${this.cfg.dailyCapMin} live minutes`;
    await this.setEngine("classic", "cost", this.reason);
    this.status = "capped";
    this.emitState();
    void this.innerSay("[mood:sad 0.5] that's all my live minutes for today. back to my usual voice.");
  }

  private async saveUsage() {
    try {
      await this.ctx.tryUse("home")?.write("live-usage", this.meter.toJSON());
    } catch {}
  }

  // --- the speech service while live --------------------------------------------------

  private async innerSay(text: string) {
    try {
      await this.inner?.say(text, { priority: "high", brain: "live" });
    } catch {}
  }

  private running(): boolean {
    return this.engine === "live" && !!this.session?.started && !this.session.closing;
  }

  speaking(): boolean {
    return this.eve.active || this.playback;
  }

  private speechService(): SpeechService {
    const none = { utteranceId: "", text: "" };
    return {
      say: async (text, opts = {}) => {
        // "switch to live" / "go back to classic": the switch is the reply, not a persona line.
        if (opts.parent && this.switchUtterances.has(opts.parent) && opts.brain === "persona") {
          if (typeof text !== "string") void drain(text);
          return none;
        }
        if (!this.running()) return this.inner ? this.inner.say(text, opts) : none;
        return this.liveSay(text, opts);
      },
      stop: (reason) => {
        // The voice model hears "stop" itself and stops; barge-in is its job.
        if (!this.running()) this.inner?.stop(reason);
      },
      speaking: () => (this.running() ? this.speaking() : (this.inner?.speaking() ?? false)),
    };
  }

  /** A line another module wants her to say, while the voice model owns her voice. */
  private async liveSay(text: string | AsyncIterable<string>, opts: SayOptions): Promise<{ utteranceId: string; text: string }> {
    this.activity();
    const target = this.delegations.target(opts);
    const pendingApproval = this.approvals.size > 0 || this.approvalDiag;
    if (!target && this.isDirectReply(opts) && !pendingApproval) {
      // Reflex's own answer to his live words: the voice model is already answering.
      // Never pull the persona stream (no LLM call); report her actual words back.
      const heard = await this.nextEveLine(3000);
      return { utteranceId: "", text: heard };
    }
    const raw = typeof text === "string" ? text : await drain(text);
    const line = cleanLine(raw);
    if (!line) return { utteranceId: "", text: "" };
    // Her classic face marks still steer the avatar; the words go to the voice model clean.
    const mark = /\[mood:(\w+)(?:\s+([\d.]+))?\]/i.exec(raw);
    const mood = (mark?.[1]?.toLowerCase() ?? opts.mood) as Mood | undefined;
    if (mood && (MOODS as readonly string[]).includes(mood)) this.ctx.bus.emit("avatar.mood", { mood, intensity: Number(mark?.[2] ?? 0.7) || 0.7, holdMs: 2500 }, "live");
    if (target) {
      const how = this.delegations.deliver(target, line, opts);
      this.log(`line -> delegation ${target.id} (${how}): "${line}"`);
    } else {
      this.delegations.commentary(null, pendingApproval ? `ask him this and wait for his yes or no: ${line}` : line);
      this.log(`line -> commentary: "${line}"`);
    }
    return { utteranceId: "", text: line };
  }

  private isDirectReply(opts: SayOptions): boolean {
    // Reflex's persona reply, or the cascade talker's streamed reply (brain "talker:<run>").
    const brain = opts.brain ?? "";
    if ((brain !== "persona" && !brain.startsWith("talker")) || opts.priority !== "high" || !opts.parent) return false;
    const at = this.liveUtterances.get(opts.parent);
    return at !== undefined && this.now() - at < DIRECT_REPLY_MS;
  }

  private nextEveLine(ms: number): Promise<string> {
    if (!this.eve.active && ms <= 0) return Promise.resolve("");
    return new Promise((resolve) => {
      let done = false;
      const fn = (t: string) => {
        if (done) return;
        done = true;
        cancel();
        resolve(t);
      };
      const cancel = this.schedule(() => {
        const i = this.waitingReply.indexOf(fn);
        if (i >= 0) this.waitingReply.splice(i, 1);
        if (!done) {
          done = true;
          resolve(this.eve.current);
        }
      }, ms);
      this.waitingReply.push(fn);
    });
  }
}

async function drain(src: AsyncIterable<string>): Promise<string> {
  let out = "";
  try {
    for await (const c of src) out += c;
  } catch {}
  return out;
}

/** Marks are for her face in classic mode; the voice model would read them out. */
export function cleanLine(s: string): string {
  return s
    .replace(/\[(?:mood|pause):[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
