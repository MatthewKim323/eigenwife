/**
 * Watch Eve use her own browser, cursor and all (docs/AGENT_CURSOR.md).
 * No music, no calendar writes, no form submits: browsing and reading only.
 *
 *   bun run overlay                                   # the cursor layer comes up with the overlay
 *   bun run scripts/agent-cursor-demo.ts              # against the running core (:7777)
 *   bun run scripts/agent-cursor-demo.ts --maps "cheap spicy ramen near Irvine, CA"
 *   bun run scripts/agent-cursor-demo.ts --url https://www.shakeshack.com/
 *   bun run scripts/agent-cursor-demo.ts --native Finder     # glide to an app's window (visual only)
 *   bun run scripts/agent-cursor-demo.ts --standalone --core 127.0.0.1:7788
 *       starts an agency-only core on that port first (its own EVE_HOME in /tmp),
 *       for trying this next to a core you're already using. Pair it with
 *       EVE_OVERLAY_CURSOR_ONLY=1 EVE_OVERLAY_INSTANCE=demo EVE_OVERLAY_URL="http://127.0.0.1:5173/?mode=overlay&core=127.0.0.1:7788" bun run overlay
 *   --close   close her browser at the end
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const core = opt("core") ?? process.env.EIGEN_CORE?.replace(/^https?:\/\//, "") ?? "127.0.0.1:7777";
const http = `http://${core}`;

let stopCore: (() => Promise<void>) | null = null;
if (flag("standalone")) {
  const port = Number(core.split(":")[1] ?? 7788);
  process.env.EIGEN_QUIET ??= "1";
  const { startCore } = await import("../packages/core/src/index");
  const { agencyModule } = await import("../packages/core/src/agency/module");
  const running = await startCore([agencyModule({ watcher: false })], { port, eveHome: mkdtempSync(join(tmpdir(), "eve-cursor-demo-")) });
  stopCore = () => running.stop();
  console.log(`agency-only core on ${http}`);
  // Give the cursor layer a moment to (re)connect and say hello.
  await Bun.sleep(Number(opt("wait") ?? 2500));
}

async function act(kind: string, args: Record<string, unknown>) {
  const r = await fetch(`${http}/api/agency/act`, { method: "POST", body: JSON.stringify({ kind, args }) });
  const j = (await r.json()) as { ok: boolean; observation: string; data?: { trace?: { op: string; ok: boolean; note: string; skipped?: boolean }[] } };
  console.log(`${kind}: ${j.ok ? "ok" : "FAILED"} ${j.observation}`);
  for (const t of j.data?.trace ?? []) console.log(`  ${t.ok ? "✓" : t.skipped ? "·" : "✗"} ${t.op.padEnd(10)} ${t.note}`);
  return j;
}

async function emit(type: string, data: unknown) {
  await fetch(`${http}/emit`, { method: "POST", body: JSON.stringify({ type, ts: Date.now(), source: "demo", id: `demo_${Math.random().toString(36).slice(2)}`, data }) });
}

const native = opt("native");
if (native) {
  // Same lookup the gate uses before a native action: window bounds only.
  const { findNativeTarget } = await import("../packages/core/src/agency/cursor");
  const { realOsa } = await import("../packages/core/src/agency/osa");
  const { agentGlideMs } = await import("../packages/protocol/src/cursor");
  const t = await findNativeTarget(realOsa, native, 2500);
  if (!t) console.log(`couldn't find ${native} on screen`);
  else {
    const ms = agentGlideMs(null, t.point);
    await emit("agent.cursor", { x: Math.round(t.point.x), y: Math.round(t.point.y), space: "screen", action: "move", label: t.kind === "dock" ? `${native} in the Dock` : native, target: native, ms });
    await Bun.sleep(ms + 100);
    await emit("agent.cursor", { x: Math.round(t.point.x), y: Math.round(t.point.y), space: "screen", action: "click", label: native, target: native });
    await Bun.sleep(1200);
    await emit("agent.cursor", { x: Math.round(t.point.x), y: Math.round(t.point.y), space: "screen", action: "idle" });
    console.log(`glided to ${native} (${t.kind}) at ${Math.round(t.point.x)},${Math.round(t.point.y)}`);
  }
} else {
  const maps = opt("maps");
  const url = opt("url") ?? "https://www.shakeshack.com/";
  await act("browser.task", maps ? { query: maps, maps: true, goal: `look up ${maps}` } : { url, goal: `look around ${url}` });
}

if (flag("close")) await act("browser.close", {});
if (stopCore) {
  await Bun.sleep(3000);
  await stopCore();
}
process.exit(0);
