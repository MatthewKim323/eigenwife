import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Conflict, HaremAgent, HaremMirror } from "./types";

/**
 * Mirrors harem wives into Open Swarm as agent cards. Open Swarm is the
 * harem room (cards, canvas, streaming); jabby/harem owns the actual work.
 * Needs the puppet route from packages/harem/openswarm/apply.sh.
 *
 * The rest of eigenwife never talks to Open Swarm directly, only through this.
 */
export class OpenSwarmClient {
  constructor(
    readonly base: string,
    private token: string,
  ) {}

  static async discover(base = process.env.OPENSWARM_URL ?? "http://127.0.0.1:8324"): Promise<OpenSwarmClient> {
    let token = process.env.OPENSWARM_TOKEN ?? "";
    const file = join(process.env.OPENSWARM_DIR ?? join(homedir(), "dev", "openswarm"), "backend", "data", "auth.token");
    if (!token && existsSync(file)) token = readFileSync(file, "utf8").trim();
    if (!token) {
      const r = await fetch(`${base}/api/dev/token`).catch(() => null);
      if (r?.ok) token = String(((await r.json()) as any).token ?? "");
    }
    if (!token) throw new Error(`no Open Swarm token (is the backend up at ${base}?)`);
    return new OpenSwarmClient(base, token);
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`open swarm ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }

  async ensureDashboard(name: string): Promise<string> {
    const list = await this.call<any>("GET", "/dashboards/list").catch(() => null);
    const items: any[] = Array.isArray(list) ? list : (list?.dashboards ?? []);
    const hit = items.find((d) => d.name === name);
    if (hit) return hit.id;
    const made = await this.call<any>("POST", "/dashboards/create", { name });
    return made.id ?? made.dashboard?.id;
  }

  async createWife(opts: { name: string; systemPrompt: string; dashboardId: string }): Promise<string> {
    const r = await this.call<{ session_id: string }>("POST", "/agents/launch", {
      name: opts.name,
      mode: "agent",
      system_prompt: opts.systemPrompt,
      dashboard_id: opts.dashboardId,
      read_only: true,
    });
    return r.session_id;
  }

  puppet(sid: string, body: { status?: string; name?: string; message?: { role: string; content: unknown }; place?: { x: number; y: number } }) {
    return this.call("POST", `/agents/sessions/${sid}/puppet`, body);
  }

  say(sid: string, text: string) {
    return this.puppet(sid, { message: { role: "assistant", content: text } });
  }

  tool(sid: string, tool: string, detail?: string) {
    return this.puppet(sid, { message: { role: "tool_call", content: { tool, input: detail ? { query: detail } : {} } } });
  }

  close(sid: string) {
    return this.call("POST", `/agents/sessions/${sid}/close`);
  }
}

const STATUS: Record<string, string> = {
  spawning: "running",
  assigned: "running",
  working: "running",
  waiting: "running",
  merging: "running",
  done: "completed",
  failed: "error",
};

/** HaremMirror backed by Open Swarm. Every call per wife is serialized so cards never see events out of order. */
export class OpenSwarmMirror implements HaremMirror {
  private sids = new Map<string, Promise<string | null>>();
  private chains = new Map<string, Promise<unknown>>();
  private slot = 0;

  constructor(
    private osw: OpenSwarmClient,
    private dashboardId: string,
    private center = { x: 900, y: 520 },
  ) {}

  static async connect(dashboard = "Eve's Harem"): Promise<OpenSwarmMirror> {
    const osw = await OpenSwarmClient.discover();
    return new OpenSwarmMirror(osw, await osw.ensureDashboard(dashboard));
  }

  private run(a: HaremAgent, fn: (sid: string) => Promise<unknown>) {
    const sid = this.sids.get(a.id);
    if (!sid) return;
    const prev = this.chains.get(a.id) ?? Promise.resolve();
    const next = prev
      .then(() => sid)
      .then((s) => (s ? fn(s) : undefined))
      .catch((err) => console.error(`[openswarm] ${a.name}:`, (err as Error).message));
    this.chains.set(a.id, next);
    return next;
  }

  spawn(a: HaremAgent) {
    const i = this.slot++;
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 4 + Math.PI / 4;
    const place = { x: Math.round(this.center.x + 560 * Math.cos(angle) - 210), y: Math.round(this.center.y + 360 * Math.sin(angle) - 140) };
    const sid = this.osw
      .createWife({ name: `${a.emoji} ${a.name.toUpperCase()} · ${a.role} wife`, systemPrompt: a.goal, dashboardId: this.dashboardId })
      .then(async (s) => {
        await this.osw.puppet(s, { status: "running", place, message: { role: "user", content: a.goal } });
        return s;
      })
      .catch((err) => {
        console.error(`[openswarm] spawn ${a.name}:`, (err as Error).message);
        return null;
      });
    this.sids.set(a.id, sid);
  }

  status(a: HaremAgent) {
    const s = STATUS[a.state];
    if (s) this.run(a, (sid) => this.osw.puppet(sid, { status: s }));
  }

  progress(a: HaremAgent, text: string) {
    if (a.tool && text.startsWith(`${a.tool}:`)) this.run(a, (sid) => this.osw.tool(sid, a.tool!, text.slice(a.tool!.length + 1).trim()));
    else this.run(a, (sid) => this.osw.say(sid, text));
  }

  done(a: HaremAgent) {
    const body = a.result ? "```json\n" + JSON.stringify(a.result, null, 2) + "\n```" : `failed: ${a.error}`;
    this.run(a, (sid) => this.osw.say(sid, body));
  }

  conflict(c: Conflict, a: HaremAgent, b: HaremAgent) {
    for (const line of c.lines) {
      const who = line.agentId === a.id ? a : b;
      this.run(who, (sid) => this.osw.say(sid, `⚡ ${line.text}`));
    }
  }

  despawn(a: HaremAgent) {
    this.run(a, (sid) => this.osw.close(sid));
  }

  /** Wait for every queued card update, e.g. before the CLI exits. */
  async flush() {
    await Promise.all([...this.chains.values()]);
  }
}
