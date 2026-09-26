/** Pure formatting for `eve status`, shared by the CLI and its tests. */

export interface EveStatus {
  online: boolean;
  host: string;
  uptimeMs: number;
  memories: number;
  tasks: number;
  activeTasks?: number;
  lastSyncAt?: number;
  zo?: boolean;
  persona?: { name: string; tagline?: string } | null;
  bornAt?: number | null;
  home: string;
  peers?: string[];
}

export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return d > 0 ? `${d}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

export function formatAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The one-line banner from the spec: EVE  STATUS ONLINE | UPTIME 05:31:14 | MEMORIES 142 | TASKS 3 */
export function statusLine(s: Pick<EveStatus, "online" | "uptimeMs" | "memories" | "tasks">): string {
  return `EVE  STATUS ${s.online ? "ONLINE" : "OFFLINE"} | UPTIME ${s.online ? formatUptime(s.uptimeMs) : "--:--:--"} | MEMORIES ${s.memories} | TASKS ${s.tasks}`;
}

export function formatStatus(s: EveStatus, opts: { color?: boolean; now?: number } = {}): string {
  const c = opts.color ?? false;
  const paint = (code: string, t: string) => (c ? `\x1b[${code}m${t}\x1b[0m` : t);
  const dim = (t: string) => paint("2", t);
  const rows: [string, string][] = [
    ["STATUS", s.online ? paint("32", "ONLINE") : paint("31", "OFFLINE")],
    ["UPTIME", s.online ? formatUptime(s.uptimeMs) : "--:--:--"],
    ["MEMORIES", String(s.memories)],
    ["TASKS", s.activeTasks ? `${s.tasks} (${s.activeTasks} running)` : String(s.tasks)],
    ["HOST", s.host],
    ["ZO", s.zo ? `mirrored, last sync ${formatAgo(s.lastSyncAt, opts.now)}` : dim("not configured (ZO_API_KEY)")],
    ["PERSONA", s.persona ? `${s.persona.name}${s.persona.tagline ? `, ${s.persona.tagline}` : ""}` : dim("not born yet")],
  ];
  if (s.persona && s.bornAt) rows.push(["BORN", formatAgo(s.bornAt, opts.now)]);
  rows.push(["HOME", s.home]);
  const width = Math.max(...rows.map(([k]) => k.length));
  const title = paint("1;35", "EVE");
  const rule = dim("─".repeat(44));
  return [title, rule, ...rows.map(([k, v]) => `${dim(k.padEnd(width))}  ${v}`), rule, dim(statusLine(s))].join("\n");
}
