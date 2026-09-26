import type { CursorPt } from "@eigenwife/protocol";
import type { CoreContext } from "../context";
import { findNativeTarget, type AgentCursor } from "./cursor";
import type { OsaRunner } from "./osa";

/**
 * Shared attention with her cursor (docs/AGENT_CURSOR.md). When she starts
 * talking about something that has a known place on screen, her cursor glides
 * there and does a small "point" wiggle while she talks, then lets go when she
 * stops (the layer walks it back home).
 *
 * Known places, in order:
 *   1. what he's looking at right now (a fresh gaze.point from the eye tracker)
 *   2. her own browser, when she was just using it and she's talking about the page
 *   3. an app she names (or the one he's in, when she says "this"): its window
 *      bounds, else its Dock spot. Bounds only, never contents.
 * Nothing known = no point. Rate limited, and never while she's busy with a task.
 */

export const POINTER = {
  /** At most one point per this long. */
  everyMs: 12_000,
  /** A task step this recent means she's busy: don't hijack the cursor. */
  busyMs: 3000,
  gazeFreshMs: 2500,
  browserFreshMs: 30_000,
  /** Let go even if speech.end never comes. */
  maxMs: 15_000,
};

/** Apps worth pointing at by name. Matched as whole words, case-insensitive. */
export const POINTABLE_APPS = [
  "Spotify",
  "Music",
  "Calendar",
  "Messages",
  "Discord",
  "Slack",
  "Notes",
  "Mail",
  "Safari",
  "Chrome",
  "Google Chrome",
  "Arc",
  "Finder",
  "Cursor",
  "Xcode",
  "Figma",
  "Notion",
  "Linear",
  "Zoom",
  "ChatGPT",
];

const BROWSER_TALK = /\b(?:this (?:page|place|site|menu)|the (?:menu|hours|page|site|reviews?|price)|here|right here|look(?: at)? (?:this|that))\b/i;
const DEICTIC = /\b(?:this|that|over there|right there|this one|that one)\b/i;

/** Which app a line is about: an app it names, else "this" = the app he's in. */
export function appMentioned(text: string, activeApp?: string): string | null {
  for (const app of [...POINTABLE_APPS].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return app === "Chrome" ? "Google Chrome" : app;
  }
  if (activeApp && DEICTIC.test(text) && !/^(?:electron|eigen)/i.test(activeApp)) return activeApp;
  return null;
}

export interface PointerDeps {
  osa: OsaRunner;
  now(): number;
  /** Is her browser open (the last place her cursor was is on her page)? */
  browserOpen(): boolean;
}

export function startPointer(ctx: CoreContext, cursor: AgentCursor, deps: PointerDeps): () => void {
  let gaze: { p: CursorPt; at: number } | null = null;
  let lastPointAt = -Infinity;
  let active: { utteranceId: string; timer: ReturnType<typeof setTimeout> } | null = null;

  const release = () => {
    if (!active) return;
    clearTimeout(active.timer);
    active = null;
    cursor.settle();
  };

  const offs = [
    ctx.bus.on("gaze.point", (e) => {
      gaze = { p: { x: e.data.x, y: e.data.y }, at: deps.now() };
    }),
    ctx.bus.on("gaze.lost", () => {
      gaze = null;
    }),
    ctx.bus.on("speech.begin", (e) => {
      void pointFor(e.data.utteranceId, e.data.text);
    }),
    ctx.bus.on("speech.end", (e) => {
      if (active?.utteranceId === e.data.utteranceId) release();
    }),
    ctx.bus.on("speech.stop", () => release()),
  ];

  async function pointFor(utteranceId: string, text: string) {
    const now = deps.now();
    if (!cursor.watching() || active) return;
    if (now - lastPointAt < POINTER.everyMs) return;
    if (now - cursor.lastActionAt() < POINTER.busyMs) return;
    const target = await where(text, now).catch(() => null);
    if (!target) return;
    // Re-check: a task may have grabbed the cursor while we looked the window up.
    if (active || deps.now() - cursor.lastActionAt() < 400) return;
    lastPointAt = deps.now();
    active = { utteranceId, timer: setTimeout(release, POINTER.maxMs) };
    await cursor.move(target.p, { label: target.label, target: target.label });
    if (active?.utteranceId === utteranceId) cursor.point({ label: target.label, target: target.label });
  }

  async function where(text: string, now: number): Promise<{ p: CursorPt; label: string } | null> {
    if (gaze && now - gaze.at <= POINTER.gazeFreshMs) return { p: gaze.p, label: "this" };
    const last = cursor.position();
    if (last && deps.browserOpen() && now - cursor.lastActionAt() <= POINTER.browserFreshMs && BROWSER_TALK.test(text)) return { p: last, label: "here" };
    const app = appMentioned(text, ctx.world().desktop.activeApp);
    if (app) {
      const t = await findNativeTarget(deps.osa, app, 1000);
      if (t) return { p: t.point, label: app };
    }
    return null;
  }

  return () => {
    for (const off of offs) off();
    if (active) clearTimeout(active.timer);
  };
}
