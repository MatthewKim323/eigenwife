import type { Scene } from "@eigenwife/protocol";
import { appleScriptString } from "../osa";
import type { ActionDef } from "../types";

/** Apps Eve may quit on her own. Anything else needs a human to do it. */
export const QUIT_ALLOWLIST = ["Spotify", "Music", "Podcasts", "TV", "Tinder", "Hinge", "Bumble", "Discord", "Messages"];

export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export const browserOpen: ActionDef = {
  kind: "browser.open",
  permission: "SAFE_ACTION",
  describe: (a) => `open ${String(a.url ?? "a page")}`,
  targets: (a) => [String(a.url ?? "")],
  async run(args, env) {
    const url = safeUrl(args.url);
    if (!url) return { ok: false, observation: `refusing non-web url ${JSON.stringify(args.url ?? null)}` };
    if (args.visible === true && (await env.deps.openVisible(url))) return { ok: true, observation: `opened ${url} in a visible browser I'm driving` };
    const ok = await env.deps.openUrl(url);
    return { ok, observation: ok ? `opened ${url}` : `couldn't open ${url}` };
  },
};

export const QUIT_APP_SCRIPT = (app: string) => {
  const q = appleScriptString(app);
  return `if application ${q} is running then\n  tell application ${q} to quit\n  return "quit"\nelse\n  return "not running"\nend if`;
};

export const appQuit: ActionDef = {
  kind: "app.quit",
  permission: "SAFE_ACTION",
  describe: (a) => `quit ${String(a.app ?? "an app")}`,
  targets: (a) => [String(a.app ?? "")],
  async run(args, env) {
    const want = String(args.app ?? "").trim();
    const app = QUIT_ALLOWLIST.find((x) => x.toLowerCase() === want.toLowerCase());
    if (!app) return { ok: false, observation: `${want || "that app"} isn't on my quit list` };
    const r = await env.deps.osa(QUIT_APP_SCRIPT(app), { timeoutMs: 10_000 });
    if (!r.ok) return { ok: false, observation: `couldn't quit ${app}: ${r.stderr}` };
    return { ok: true, observation: r.stdout === "quit" ? `quit ${app}` : `${app} wasn't running` };
  },
};

const SCENES: Scene[] = ["boot", "calibration", "dating", "convergence", "emergence", "desktop", "swarm", "architecture"];

/** Close whatever the shell is showing (the dating app, usually) and go back to her desktop. */
export const shellCloseApp: ActionDef = {
  kind: "shell.close_app",
  permission: "SAFE_ACTION",
  describe: (a) => `close ${String(a.app ?? "the dating app")}`,
  targets: (a) => [String(a.app ?? "")],
  async run(args, env) {
    // The dating app can be a scene (Act I) or a window on her desktop: close both.
    env.ctx.bus.emit("shell.key", { key: "eigen.close" }, "agency");
    env.ctx.bus.emit("shell.scene", { scene: "desktop" }, "agency");
    return { ok: true, observation: `closed ${String(args.app ?? "the dating app")}` };
  },
};

export const shellOpen: ActionDef = {
  kind: "shell.open",
  permission: "SAFE_ACTION",
  describe: (a) => `switch to ${String(a.scene ?? "desktop")}`,
  async run(args, env) {
    const scene = SCENES.find((s) => s === args.scene);
    if (!scene) return { ok: false, observation: `no scene ${JSON.stringify(args.scene ?? null)}` };
    env.ctx.bus.emit("shell.scene", { scene }, "agency");
    return { ok: true, observation: `showing ${scene}` };
  },
};
