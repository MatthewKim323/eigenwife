/**
 * Zo mirror: Eve's state files are copied onto her Zo computer so "she has her
 * own computer" is literally true. Writes are debounced and coalesced: many
 * local writes in a burst become one sync carrying the latest bytes of every
 * dirty file.
 *
 * Transport, in order:
 *  1. Zo MCP (https://api.zo.computer/mcp, Streamable HTTP): tools/list, then
 *     tools/call on the file-writing tool. Argument names are read from the
 *     tool's input schema, so a renamed parameter does not break us.
 *  2. Ask Zo (POST https://api.zo.computer/zo/ask): one instruction asking the
 *     Zo agent to write the files verbatim. Slower, but it is the documented
 *     fallback when MCP is unavailable.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ZoMirrorOptions {
  apiKey: string;
  baseUrl?: string;
  /** Directory on the Zo machine. */
  remoteDir?: string;
  debounceMs?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  log?: (...args: unknown[]) => void;
  onSync?: (r: ZoSyncResult) => void;
}

export interface ZoSyncResult {
  ok: boolean;
  files: string[];
  via: "mcp" | "ask" | "none";
  at: number;
  error?: string;
}

interface McpTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

const PATH_KEYS = ["path", "file_path", "filepath", "target_file", "filename", "file", "target_path"];
const CONTENT_KEYS = ["content", "contents", "text", "data", "body", "file_content"];

export class ZoMirror {
  readonly baseUrl: string;
  readonly remoteDir: string;
  private debounceMs: number;
  private fetch: FetchLike;
  private timeoutMs: number;
  private pending = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<ZoSyncResult> | null = null;
  private session: string | null = null;
  private writeTool: { name: string; pathKey: string; contentKey: string } | null | undefined;
  private rpcId = 0;
  lastSyncAt: number | undefined;
  lastResult: ZoSyncResult | undefined;
  syncs = 0;

  constructor(private opts: ZoMirrorOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.zo.computer").replace(/\/$/, "");
    this.remoteDir = (opts.remoteDir ?? "/home/workspace/eve").replace(/\/$/, "");
    this.debounceMs = opts.debounceMs ?? 1500;
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Mark a file dirty with its latest bytes. The sync fires debounceMs after the last call. */
  enqueue(file: string, content: string): void {
    this.pending.set(file, content);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  dirty(): string[] {
    return [...this.pending.keys()];
  }

  /** Sync everything dirty now. Concurrent calls chain, so no file is dropped. */
  async flush(): Promise<ZoSyncResult> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight.catch(() => {});
    if (this.pending.size === 0) return this.lastResult ?? { ok: true, files: [], via: "none", at: Date.now() };
    const batch = new Map(this.pending);
    this.pending.clear();
    this.inflight = this.push(batch).finally(() => {
      this.inflight = null;
    });
    const r = await this.inflight;
    if (!r.ok) {
      // Keep the failed files dirty unless a newer write already replaced them.
      for (const [f, c] of batch) if (!this.pending.has(f)) this.pending.set(f, c);
    }
    return r;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async push(batch: Map<string, string>): Promise<ZoSyncResult> {
    const files = [...batch.keys()];
    let result: ZoSyncResult;
    try {
      await this.viaMcp(batch);
      result = { ok: true, files, via: "mcp", at: Date.now() };
    } catch (mcpErr) {
      this.opts.log?.("zo mcp failed, falling back to /zo/ask:", String(mcpErr));
      try {
        await this.viaAsk(batch);
        result = { ok: true, files, via: "ask", at: Date.now() };
      } catch (askErr) {
        result = { ok: false, files, via: "none", at: Date.now(), error: String(askErr) };
      }
    }
    this.syncs++;
    this.lastResult = result;
    if (result.ok) this.lastSyncAt = result.at;
    this.opts.onSync?.(result);
    return result;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async timed(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** One JSON-RPC call over MCP Streamable HTTP. Handles JSON and SSE response bodies. */
  private async rpc(method: string, params: unknown, notify = false): Promise<any> {
    const id = notify ? undefined : ++this.rpcId;
    const res = await this.timed(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: this.headers({
        Accept: "application/json, text/event-stream",
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      }),
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notify ? {} : { id }) }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (!res.ok) throw new Error(`mcp ${method}: http ${res.status}`);
    if (notify) return null;
    const type = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const messages: any[] = [];
    if (type.includes("text/event-stream")) {
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          messages.push(JSON.parse(line.slice(5).trim()));
        } catch {}
      }
    } else if (raw.trim()) {
      const j = JSON.parse(raw);
      messages.push(...(Array.isArray(j) ? j : [j]));
    }
    const msg = messages.find((m) => m && m.id === id) ?? messages[0];
    if (!msg) throw new Error(`mcp ${method}: empty response`);
    if (msg.error) throw new Error(`mcp ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  }

  private async ensureMcp(): Promise<{ name: string; pathKey: string; contentKey: string }> {
    if (this.writeTool) return this.writeTool;
    if (this.writeTool === null) throw new Error("zo mcp has no file write tool");
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "eigenwife-eve", version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", {}, true).catch(() => {});
    const listed = await this.rpc("tools/list", {});
    const tools: McpTool[] = listed?.tools ?? [];
    const tool = pickWriteTool(tools);
    if (!tool) {
      this.writeTool = null;
      throw new Error("zo mcp has no file write tool");
    }
    this.writeTool = tool;
    return tool;
  }

  private async viaMcp(batch: Map<string, string>): Promise<void> {
    const tool = await this.ensureMcp();
    for (const [file, content] of batch) {
      const result = await this.rpc("tools/call", {
        name: tool.name,
        arguments: { [tool.pathKey]: `${this.remoteDir}/${file}`, [tool.contentKey]: content },
      });
      if (result?.isError) {
        const text = (result.content ?? []).map((c: any) => c?.text ?? "").join(" ");
        throw new Error(`zo ${tool.name} ${file}: ${text || "error"}`);
      }
    }
  }

  private async viaAsk(batch: Map<string, string>): Promise<void> {
    const parts = [...batch].map(([f, c]) => `=== ${this.remoteDir}/${f} ===\n${c}`);
    const input =
      `You are Eve's home computer. Create the directory ${this.remoteDir} if needed and write each file below ` +
      `verbatim (overwrite, no edits, no commentary). Reply with just OK when done.\n\n${parts.join("\n\n")}`;
    const res = await this.timed(`${this.baseUrl}/zo/ask`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ input, stream: false, memory_mode: "off" }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; output?: unknown };
    if (!res.ok || j.error) throw new Error(`zo ask: ${j.error ?? `http ${res.status}`}`);
  }
}

export function pickWriteTool(tools: McpTool[]): { name: string; pathKey: string; contentKey: string } | null {
  const ranked = [...tools].sort((a, b) => score(b.name) - score(a.name));
  for (const t of ranked) {
    if (score(t.name) <= 0) break;
    const props = Object.keys(t.inputSchema?.properties ?? {});
    const pathKey = PATH_KEYS.find((k) => props.includes(k));
    const contentKey = CONTENT_KEYS.find((k) => props.includes(k));
    if (pathKey && contentKey) return { name: t.name, pathKey, contentKey };
    if (props.length === 0 && t.name === "write_file") return { name: t.name, pathKey: "path", contentKey: "content" };
  }
  return null;
}

function score(name: string): number {
  if (name === "write_file") return 3;
  if (/write.?file|create.?file|save.?file/i.test(name)) return 2;
  return 0;
}
