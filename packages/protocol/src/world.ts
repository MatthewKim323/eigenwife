import { clamp01, emptyWorld, type AnyEnvelope, type WorldSnapshot } from "./index";

/**
 * Pure reducer: folds bus events into the WorldState snapshot. Shared by the
 * core (authoritative) and the shell (for rendering), so both agree exactly.
 */
export function reduceWorld(w: WorldSnapshot, e: AnyEnvelope): WorldSnapshot {
  switch (e.type) {
    case "bus.welcome":
      return structuredClone(e.data.world);
    case "shell.scene":
      return { ...w, scene: e.data.scene };
    case "eye.status":
      return { ...w, user: { ...w.user, facePresent: e.data.facePresent ?? w.user.facePresent } };
    case "gaze.target":
      return {
        ...w,
        user: { ...w.user, gazeTarget: e.data.target, gazeTargetAt: e.ts, attentionConfidence: clamp01(e.data.confidence) },
      };
    case "gaze.lost":
      return { ...w, user: { ...w.user, attentionConfidence: 0, facePresent: e.data.reason === "no_face" ? false : w.user.facePresent } };
    case "voice.partial":
      return { ...w, user: { ...w.user, speaking: true } };
    case "voice.final":
      return { ...w, user: { ...w.user, speaking: false, lastUtterance: e.data.text, lastUtteranceAt: e.ts } };
    case "app.focused":
    case "app.opened":
      return { ...w, desktop: { ...w.desktop, activeApp: e.data.app } };
    case "work.context":
      return w.desktop.activeApp === e.data.app ? w : { ...w, desktop: { ...w.desktop, activeApp: e.data.app } };
    case "page.context":
      return { ...w, desktop: { ...w.desktop, page: { url: e.data.url, title: e.data.title, targets: e.data.targets } } };
    case "preference.update": {
      const preference = { vector: e.data.vector, progress: e.data.progress, observations: e.data.observations };
      // A fresh Act I (reset) starts from zero observations: she isn't born yet.
      if (e.data.observations === 0 && e.data.progress === 0)
        return { ...w, preference, companion: { ...w.companion, born: false, persona: undefined, state: "sleeping" } };
      return { ...w, preference };
    }
    case "companion.born":
      return { ...w, companion: { ...w.companion, born: true, persona: e.data.persona, state: "idle" } };
    case "avatar.state":
      return { ...w, companion: { ...w.companion, state: e.data.state } };
    case "avatar.mood":
      return { ...w, companion: { ...w.companion, mood: e.data.mood } };
    case "speech.begin":
      return { ...w, companion: { ...w.companion, lastSpokeAt: e.ts } };
    case "relationship.update":
      return { ...w, companion: { ...w.companion, relationship: e.data.state } };
    case "task.start":
      return { ...w, tasks: { ...w.tasks, active: w.tasks.active + 1 } };
    case "task.done":
      return { ...w, tasks: { active: Math.max(0, w.tasks.active - 1), done: w.tasks.done + 1 } };
    default:
      return w;
  }
}

export function setSlot(w: WorldSnapshot, source: string, name: string, value: string | null): WorldSnapshot {
  const slots = { ...w.slots, [source]: { ...(w.slots[source] ?? {}) } };
  if (value === null) delete slots[source]![name];
  else slots[source]![name] = value;
  return { ...w, slots };
}

/** Render world + slots as the compact "Context" bullet block every prompt gets. */
export function renderContext(w: WorldSnapshot, now = Date.now()): string {
  const lines: string[] = [];
  const ago = (t?: number) => (t ? `${Math.max(0, Math.round((now - t) / 1000))}s ago` : "");
  lines.push(`- scene: ${w.scene}`);
  if (w.user.gazeTarget) {
    const m = w.user.gazeTarget.meta ? ` ${JSON.stringify(w.user.gazeTarget.meta)}` : "";
    lines.push(`- user is looking at: ${w.user.gazeTarget.label}${m} (${ago(w.user.gazeTargetAt)}, confidence ${w.user.attentionConfidence.toFixed(2)})`);
  } else {
    lines.push("- user gaze: not on anything specific");
  }
  if (w.user.lastUtterance) lines.push(`- user last said: "${w.user.lastUtterance}" (${ago(w.user.lastUtteranceAt)})`);
  if (w.desktop.activeApp) lines.push(`- active app: ${w.desktop.activeApp}`);
  if (w.desktop.page) {
    lines.push(`- open page: ${w.desktop.page.title} (${w.desktop.page.url})`);
    const visible = w.desktop.page.targets.slice(0, 12);
    visible.forEach((t, i) => lines.push(`  [${i + 1}] ${t.label}`));
  }
  if (w.tasks.active) lines.push(`- background tasks running: ${w.tasks.active}`);
  for (const [source, slots] of Object.entries(w.slots)) {
    for (const [name, value] of Object.entries(slots)) lines.push(`- ${source}.${name}: ${value}`);
  }
  return lines.join("\n");
}
