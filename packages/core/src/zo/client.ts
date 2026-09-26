/**
 * One Zo MCP client for the whole core (home mirror, calendar, places,
 * Spotify). Zo is slow next to speech (1-3s per MCP tool, ~5s for /zo/ask), so
 * this client is built to stay off the speaking path:
 *
 *  - never throws: every call resolves to { ok, text, ms, error }
 *  - every call has its own timeout (AbortController)
 *  - at most 2 calls in flight; background work ("low": home sync, Spotify
 *    poll) may hold only one slot, so a "high" call (booking, maps) always has
 *    a free lane and high calls jump the queue
 *  - the MCP session is warmed at boot and kept alive with a JSON-RPC ping
 *    every 4 minutes, so a real call never pays for initialize
 *  - a session the server forgot (HTTP 404/400) is re-initialized once, then
 *    the call is retried
 *
 * Wire facts (verified against api.zo.computer 2026-09-26): POST /mcp,
 * `Accept: application/json, text/event-stream`, initialize returns an
 * `mcp-session-id` header echoed back as `Mcp-Session-Id`; bodies are JSON or
 * SSE `data:` frames. Tool results are MCP content blocks whose text is often
 * a Python repr (see ./repr.ts). Tool-level failures come back as
 * `isError: true` with text "Error: ...\ncode: ...".
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Priority = "high" | "low";

export interface ZoClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Default per-call timeout. */
  timeoutMs?: number;
  concurrency?: number;
  keepaliveMs?: number;
  log?: (...args: unknown[]) => void;
  now?: () => number;
}

export interface ZoCallResult {
  ok: boolean;
  text: string;
  ms: number;
  error?: string;
  /** Zo's error code ("read_failed", "invalid_path", "timeout", "http_500", ...). */
  code?: string;
}

export interface ZoCallStats {
  n: number;
  errors: number;
  p50: number;
  p95: number;
  lastMs: number;
}

export interface ZoStatus {
  configured: true;
  baseUrl: string;
  /** Session initialized and the last round trip succeeded. */
  connected: boolean;
  session: boolean;
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  inflight: number;
  queued: number;
  calls: Record<string, ZoCallStats>;
}

interface Waiter {
  priority: Priority;
  go: () => void;
}

const SAMPLES = 200;

export class ZoClient {
  readonly baseUrl: string;
  private fetch: FetchLike;
  private timeoutMs: number;
  private concurrency: number;
  private session: string | null = null;
  private initializing: Promise<boolean> | null = null;
  private rpcId = 0;
  private active = 0;
  private activeLow = 0;
  private queue: Waiter[] = [];
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private samples = new Map<string, { ms: number[]; n: number; errors: number; last: number }>();
  private now: () => number;
  lastOkAt: number | undefined;
  lastError: string | undefined;
  lastErrorAt: number | undefined;
  private lastRoundTripOk = false;

  constructor(private opts: ZoClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.zo.computer").replace(/\/$/, "");
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.now = opts.now ?? Date.now;
  }

  /** Open the session in the background and keep it alive. Never blocks the caller. */
  warm(): void {
    void this.connect();
    const every = this.opts.keepaliveMs ?? 240_000;
    if (every > 0 && !this.keepalive) {
      this.keepalive = setInterval(() => void this.ping(), every);
      (this.keepalive as { unref?: () => void }).unref?.();
    }
  }

  close(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  /** initialize + notifications/initialized. Concurrent callers share one attempt. */
  connect(timeoutMs = 10_000): Promise<boolean> {
    if (this.session) return Promise.resolve(true);
    this.initializing ??= (async () => {
      try {
        const r = await this.post(
          { jsonrpc: "2.0", id: ++this.rpcId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eigenwife-eve", version: "0.2.0" } } },
          timeoutMs,
        );
        if (!r.ok) throw new Error(r.error);
        // Some servers run sessionless and send no header; any non-empty marker works.
        this.session ??= "sessionless";
        await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, timeoutMs).catch(() => {});
        return true;
      } catch (e) {
        this.fail(String((e as Error).message ?? e));
        return false;
      } finally {
        this.initializing = null;
      }
    })();
    return this.initializing;
  }

  /** Cheap liveness check (JSON-RPC ping, ~150ms). Bypasses the concurrency limit. */
  async ping(timeoutMs = 5000): Promise<{ ok: boolean; ms: number; error?: string }> {
    const t0 = this.now();
    if (!(await this.connect(timeoutMs))) return { ok: false, ms: this.now() - t0, error: this.lastError };
    const r = await this.rpc("ping", {}, timeoutMs);
    const ms = this.now() - t0;
    this.record("ping", ms, r.ok);
    return r.ok ? { ok: true, ms } : { ok: false, ms, error: r.error };
  }

  async listTools(timeoutMs = 15_000): Promise<string[]> {
    if (!(await this.connect(timeoutMs))) return [];
    const r = await this.rpc("tools/list", {}, timeoutMs);
    const tools = (r.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    return tools.map((t) => t.name);
  }

  /** tools/call. Resolves with the joined text content; ok=false on transport, timeout or isError. */
  async call(name: string, args: Record<string, unknown>, o: { timeoutMs?: number; priority?: Priority; statKey?: string } = {}): Promise<ZoCallResult> {
    const key = o.statKey ?? statKeyFor(name, args);
    const t0 = this.now();
    const release = await this.acquire(o.priority ?? "high");
    try {
      const timeoutMs = o.timeoutMs ?? this.timeoutMs;
      if (!(await this.connect(Math.min(timeoutMs, 10_000)))) {
        return this.done(key, t0, { ok: false, text: "", ms: 0, error: `connect failed: ${this.lastError ?? "?"}`, code: "connect" });
      }
      const r = await this.rpc("tools/call", { name, arguments: args }, Math.max(1, timeoutMs - (this.now() - t0)));
      if (!r.ok) return this.done(key, t0, { ok: false, text: "", ms: 0, error: r.error, code: r.code });
      const res = r.result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
      const text = (res?.content ?? []).map((c) => c?.text ?? "").join("\n");
      if (res?.isError) {
        const code = text.match(/\ncode:\s*(\S+)/)?.[1];
        return this.done(key, t0, { ok: false, text, ms: 0, error: text.replace(/^Error:\s*/, "").split("\ncode:")[0]!.slice(0, 300), code: code ?? "tool_error" }, true);
      }
      return this.done(key, t0, { ok: true, text, ms: 0 });
    } finally {
      release();
    }
  }

  /** POST /zo/ask: the Zo agent itself. Slow (~5s+); only for fallbacks. */
  async ask(input: string, o: { timeoutMs?: number; priority?: Priority } = {}): Promise<{ ok: boolean; output: string; ms: number; error?: string }> {
    const t0 = this.now();
    const release = await this.acquire(o.priority ?? "low");
    try {
      const res = await this.timed(`${this.baseUrl}/zo/ask`, { method: "POST", headers: this.headers(), body: JSON.stringify({ input }) }, o.timeoutMs ?? 60_000);
      const j = (await res.json().catch(() => ({}))) as { output?: unknown; error?: string };
      const ms = this.now() - t0;
      const ok = res.ok && !j.error;
      this.record("ask", ms, ok);
      if (ok) this.okNow();
      else this.fail(`ask: ${j.error ?? `http ${res.status}`}`);
      return ok ? { ok, output: typeof j.output === "string" ? j.output : JSON.stringify(j.output ?? ""), ms } : { ok, output: "", ms, error: j.error ?? `http ${res.status}` };
    } catch (e) {
      const ms = this.now() - t0;
      const error = isAbort(e) ? "timeout" : String((e as Error).message ?? e);
      this.record("ask", ms, false);
      this.fail(`ask: ${error}`);
      return { ok: false, output: "", ms, error };
    } finally {
      release();
    }
  }

  status(): ZoStatus {
    return {
      configured: true,
      baseUrl: this.baseUrl,
      connected: !!this.session && this.lastRoundTripOk,
      session: !!this.session,
      ...(this.lastOkAt ? { lastOkAt: this.lastOkAt } : {}),
      ...(this.lastError ? { lastError: this.lastError, lastErrorAt: this.lastErrorAt } : {}),
      inflight: this.active,
      queued: this.queue.length,
      calls: this.stats(),
    };
  }

  stats(): Record<string, ZoCallStats> {
    const out: Record<string, ZoCallStats> = {};
    for (const [k, s] of this.samples) {
      const sorted = [...s.ms].sort((a, b) => a - b);
      out[k] = { n: s.n, errors: s.errors, p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), lastMs: s.last };
    }
    return out;
  }

  // --- internals ---------------------------------------------------------------

  private done(key: string, t0: number, r: ZoCallResult, reached = false): ZoCallResult {
    r.ms = this.now() - t0;
    this.record(key, r.ms, r.ok);
    // A tool-level error still proves the round trip works.
    if (r.ok || reached) this.okNow();
    else this.fail(r.error ?? "error");
    return r;
  }

  private okNow() {
    this.lastOkAt = this.now();
    this.lastRoundTripOk = true;
  }

  private fail(msg: string) {
    this.lastError = msg.slice(0, 300);
    this.lastErrorAt = this.now();
    this.lastRoundTripOk = false;
    this.opts.log?.("zo:", this.lastError);
  }

  private record(key: string, ms: number, ok: boolean) {
    let s = this.samples.get(key);
    if (!s) this.samples.set(key, (s = { ms: [], n: 0, errors: 0, last: 0 }));
    s.n++;
    s.last = ms;
    if (!ok) s.errors++;
    s.ms.push(ms);
    if (s.ms.length > SAMPLES) s.ms.shift();
  }

  private acquire(priority: Priority): Promise<() => void> {
    const can = () => this.active < this.concurrency && (priority === "high" || this.activeLow < Math.max(1, this.concurrency - 1));
    const take = () => {
      this.active++;
      if (priority === "low") this.activeLow++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active--;
        if (priority === "low") this.activeLow--;
        this.pump();
      };
    };
    const ahead = priority === "high" ? this.queue.some((w) => w.priority === "high") : this.queue.length > 0;
    if (can() && !ahead) return Promise.resolve(take());
    return new Promise((resolve) => {
      const w: Waiter = { priority, go: () => resolve(take()) };
      if (priority === "high") {
        const firstLow = this.queue.findIndex((q) => q.priority === "low");
        if (firstLow === -1) this.queue.push(w);
        else this.queue.splice(firstLow, 0, w);
      } else this.queue.push(w);
    });
  }

  private pump() {
    for (let i = 0; i < this.queue.length; i++) {
      const w = this.queue[i]!;
      const lowOk = this.activeLow < Math.max(1, this.concurrency - 1);
      if (this.active >= this.concurrency) return;
      if (w.priority === "low" && !lowOk) continue;
      this.queue.splice(i, 1);
      i--;
      w.go();
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json", ...extra };
  }

  private async timed(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Raw POST to /mcp. Returns the parsed JSON-RPC message (or ok for notifications). */
  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; status: number; msg?: any; error?: string; code?: string }> {
    try {
      const res = await this.timed(
        `${this.baseUrl}/mcp`,
        {
          method: "POST",
          headers: this.headers({ Accept: "application/json, text/event-stream", ...(this.session && this.session !== "sessionless" ? { "Mcp-Session-Id": this.session } : {}) }),
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.session = sid;
      const raw = await res.text();
      if (!res.ok) return { ok: false, status: res.status, error: `http ${res.status}${raw ? `: ${raw.slice(0, 120)}` : ""}`, code: `http_${res.status}` };
      if (body.id === undefined) return { ok: true, status: res.status };
      const msgs = parseMcpBody(raw, res.headers.get("content-type") ?? "");
      const msg = msgs.find((m) => m && m.id === body.id) ?? msgs.find((m) => m && ("result" in m || "error" in m));
      if (!msg) return { ok: false, status: res.status, error: "empty response", code: "empty" };
      if (msg.error) return { ok: false, status: res.status, msg, error: String(msg.error.message ?? JSON.stringify(msg.error)), code: `rpc_${msg.error.code ?? "error"}` };
      return { ok: true, status: res.status, msg };
    } catch (e) {
      return { ok: false, status: 0, error: isAbort(e) ? "timeout" : String((e as Error).message ?? e), code: isAbort(e) ? "timeout" : "network" };
    }
  }

  /** JSON-RPC request with one re-initialize on a forgotten session. */
  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }> {
    const send = () => this.post({ jsonrpc: "2.0", id: ++this.rpcId, method, params }, timeoutMs);
    let r = await send();
    const sessionGone = !r.ok && (r.status === 404 || r.status === 400 || /session/i.test(r.error ?? ""));
    if (sessionGone && this.session) {
      this.opts.log?.(`zo: session rejected (${r.error}), re-initializing`);
      this.session = null;
      if (await this.connect(Math.min(timeoutMs, 10_000))) r = await send();
    }
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    return { ok: true, result: r.msg?.result };
  }
}

/** JSON body, JSON array (batch), or SSE frames (`data:` lines, multi-line data joined). */
export function parseMcpBody(raw: string, contentType: string): any[] {
  const out: any[] = [];
  const looksSse = contentType.includes("text/event-stream") || /^(event|data|id):/m.test(raw.slice(0, 200));
  if (looksSse) {
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data.trim()) continue;
      try {
        out.push(JSON.parse(data));
      } catch {}
    }
    return out;
  }
  if (!raw.trim()) return out;
  try {
    const j = JSON.parse(raw);
    out.push(...(Array.isArray(j) ? j : [j]));
  } catch {}
  return out;
}

function statKeyFor(name: string, args: Record<string, unknown>): string {
  return name.startsWith("use_app_") && typeof args.tool_name === "string" ? args.tool_name : name;
}

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && ((e as { name?: string }).name === "AbortError" || (e as { name?: string }).name === "TimeoutError");
}
