import type { CursorPt, ScreenRect } from "@eigenwife/protocol";
import type { EventBus } from "../../bus";
import type { AgentCursor } from "../cursor";
import { addressBarPoint, aimPoint, inViewport, leftHalf, pageToScreen, viewportCenter, type Box, type PageMetrics } from "./geometry";

/**
 * eve.browser: Eve's own visible browser (docs/AGENT_CURSOR.md). A headful
 * Chromium window on the left half of the main display, driven step by step.
 * Before every click or keystroke her cursor glides to the element's real
 * on-screen spot (agent.cursor), then the step happens. It's her page: read and
 * screenshot only ever see her browser, never matt's screen.
 *
 * The Playwright bits live behind BrowserBackend so tests drive a fake.
 */

export interface PageRead {
  title: string;
  url: string;
  text: string;
  cards?: { name: string; text: string; url?: string }[];
}

export interface Target {
  selector?: string;
  text?: string;
}

export interface Located {
  /** Viewport CSS px. */
  box: Box;
  /** Would activating it change something in the world (POST form, "Book", "Pay")? */
  submits: boolean;
  /** Short visible label, for the cursor tag and the trace. */
  label: string;
}

export interface BrowserPage {
  goto(url: string, timeoutMs: number): Promise<void>;
  url(): string;
  metrics(): Promise<PageMetrics>;
  /** Find, scroll into view, measure. null = not found in time. */
  locate(t: Target, timeoutMs: number): Promise<Located | null>;
  click(t: Target, timeoutMs: number): Promise<void>;
  /** Types into the element, one key at a time. enter: press Enter after. */
  type(t: Target, text: string, opts: { delayMs: number; enter?: boolean; timeoutMs: number }): Promise<void>;
  /** Wheel at a viewport point (scrolls whatever is under it). */
  wheel(at: CursorPt, dy: number): Promise<void>;
  /** cards: listing tiles on her page (Maps results, list items with a heading), for option extraction. */
  read(maxChars: number): Promise<PageRead>;
  screenshot(): Promise<Uint8Array>;
  /** Would pressing Enter in this field submit a consequential form? */
  enterSubmits(t: Target, timeoutMs: number): Promise<boolean>;
}

export interface BrowserBackend {
  /** Open (or reuse) the window. Returns the page and the display's usable area it's on. */
  launch(): Promise<{ page: BrowserPage; avail: ScreenRect }>;
  /** Move/resize the OS window (points). */
  setBounds(r: ScreenRect): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
  /** Called when the window goes away on its own (matt closed it). */
  onClosed(cb: () => void): void;
}

export type BrowserStep =
  | { op: "open"; url: string }
  | { op: "click"; selector?: string; text?: string; optional?: boolean; submit?: boolean }
  | { op: "type"; selector?: string; text?: string; value: string; enter?: boolean; optional?: boolean; submit?: boolean }
  | { op: "scroll"; dy?: number; selector?: string; text?: string }
  | { op: "read"; max?: number }
  | { op: "screenshot" }
  | { op: "wait"; ms: number };

export interface StepTrace {
  i: number;
  op: BrowserStep["op"];
  ok: boolean;
  ms: number;
  note: string;
  /** Where her cursor went for this step, screen points. */
  at?: CursorPt;
  skipped?: boolean;
}

export interface BrowserRun {
  ok: boolean;
  trace: StepTrace[];
  reads: PageRead[];
  shots: Uint8Array[];
  /** Stopped before a consequential step: which one and the steps from there on. */
  needsSubmit?: { index: number; why: string; remaining: BrowserStep[] };
  truncated?: number;
  url?: string;
}

export interface RunOpts {
  budget?: number;
  allowSubmit?: boolean;
  progress?: (text: string) => void;
}

export const BROWSER_LIMITS = {
  defaultBudget: 12,
  maxBudget: 30,
  locateMs: 6000,
  gotoMs: 20_000,
  keyDelayMs: 55,
  scrollDy: 520,
};

const CONSEQUENTIAL = /\b(book|reserve|reservation|order|buy|purchase|pay|checkout|check out|place order|confirm|submit|sign ?up|register|send|post|publish|subscribe|donate|delete|apply)\b/i;

/** Does a button / link label read like it commits to something? */
export function soundsConsequential(label: string): boolean {
  return CONSEQUENTIAL.test(label);
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class EveBrowser {
  private page: BrowserPage | null = null;
  private baseDpr = 0;
  private bounds: ScreenRect | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private backend: BrowserBackend,
    private cursor: AgentCursor,
    private bus: EventBus,
    opts: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.sleep = opts.sleep ?? sleepReal;
    backend.onClosed(() => {
      if (!this.page) return;
      this.page = null;
      this.bus.emit("agent.browser", { status: "closed" }, "agency");
    });
  }

  isOpen(): boolean {
    return !!this.page && this.backend.isOpen();
  }

  /** Steps run one run() at a time: two shows never fight over the same window. */
  run(steps: BrowserStep[], opts: RunOpts = {}): Promise<BrowserRun> {
    const next = this.lock.then(() => this.runNow(steps, opts));
    this.lock = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    const had = !!this.page;
    this.page = null;
    await this.backend.close().catch(() => {});
    if (had) this.bus.emit("agent.browser", { status: "closed" }, "agency");
    this.cursor.settle();
  }

  private async ensure(): Promise<BrowserPage> {
    if (this.page && this.backend.isOpen()) return this.page;
    const { page, avail } = await this.backend.launch();
    const want = leftHalf(avail);
    await this.backend.setBounds(want).catch(() => {});
    this.page = page;
    const m = await page.metrics();
    // Fresh profile, 100% zoom: this is the display's backing scale.
    this.baseDpr = m.devicePixelRatio || 1;
    this.bounds = { x: m.screenX, y: m.screenY, width: m.outerWidth, height: m.outerHeight };
    this.bus.emit("agent.browser", { status: "open", bounds: this.bounds }, "agency");
    return page;
  }

  private async runNow(steps: BrowserStep[], opts: RunOpts): Promise<BrowserRun> {
    const budget = Math.max(1, Math.min(BROWSER_LIMITS.maxBudget, opts.budget ?? BROWSER_LIMITS.defaultBudget));
    const out: BrowserRun = { ok: true, trace: [], reads: [], shots: [] };
    const list = steps.slice(0, budget);
    if (steps.length > budget) out.truncated = steps.length - budget;
    let page: BrowserPage;
    try {
      page = await this.ensure();
    } catch (err) {
      out.ok = false;
      out.trace.push({ i: 0, op: "open", ok: false, ms: 0, note: `couldn't start my browser: ${msg(err)}` });
      return out;
    }
    for (let i = 0; i < list.length; i++) {
      const step = list[i]!;
      const t0 = Date.now();
      try {
        const r = await this.step(page, step, i, opts);
        if (r.stop) {
          out.needsSubmit = { index: i, why: r.stop, remaining: list.slice(i) };
          out.trace.push({ i, op: step.op, ok: false, ms: Date.now() - t0, note: `stopped: ${r.stop} needs your ok`, at: r.at });
          break;
        }
        if (r.read) out.reads.push(r.read);
        if (r.shot) out.shots.push(r.shot);
        out.trace.push({ i, op: step.op, ok: r.ok, ms: Date.now() - t0, note: r.note, at: r.at, ...(r.skipped ? { skipped: true } : {}) });
        if (r.note) opts.progress?.(r.note);
        if (!r.ok && !r.skipped) {
          out.ok = false;
          break;
        }
      } catch (err) {
        const optional = "optional" in step && step.optional;
        out.trace.push({ i, op: step.op, ok: false, ms: Date.now() - t0, note: `${step.op} failed: ${msg(err)}`, ...(optional ? { skipped: true } : {}) });
        if (!optional) {
          out.ok = false;
          break;
        }
      }
      if (!this.page) {
        out.ok = false;
        out.trace.push({ i, op: step.op, ok: false, ms: 0, note: "my browser was closed" });
        break;
      }
    }
    out.url = this.page?.url();
    this.cursor.settle();
    return out;
  }

  private async screenPoint(page: BrowserPage, p: CursorPt): Promise<CursorPt> {
    return pageToScreen(await page.metrics(), p, this.baseDpr);
  }

  private async step(
    page: BrowserPage,
    s: BrowserStep,
    i: number,
    opts: RunOpts,
  ): Promise<{ ok: boolean; note: string; at?: CursorPt; stop?: string; skipped?: boolean; read?: BrowserRun["reads"][number]; shot?: Uint8Array }> {
    const L = BROWSER_LIMITS;
    switch (s.op) {
      case "open": {
        const url = httpUrl(s.url);
        if (!url) return { ok: false, note: `not a web url: ${s.url}` };
        const at = addressBarPoint(await page.metrics(), this.baseDpr);
        await this.cursor.move(at, { label: "address bar", target: "address bar" });
        this.cursor.click({ label: "address bar" });
        this.cursor.type({ label: shortUrl(url) });
        await page.goto(url, L.gotoMs);
        return { ok: true, note: `opened ${shortUrl(url)}`, at };
      }
      case "click": {
        const t = targetOf(s);
        const found = await page.locate(t, L.locateMs);
        if (!found) return s.optional ? { ok: false, skipped: true, note: `no "${describe(t)}" here, moving on` } : { ok: false, note: `couldn't find "${describe(t)}"` };
        const m = await page.metrics();
        if (!inViewport(m, found.box)) return { ok: false, skipped: !!s.optional, note: `"${describe(t)}" is off screen` };
        const at = pageToScreen(m, aimPoint(found.box), this.baseDpr);
        const label = found.label || describe(t);
        // Submitting is never a plain browse: it goes back through the gate for a spoken yes.
        if (!opts.allowSubmit && (s.submit || found.submits)) {
          await this.cursor.move(at, { label: `wait: ${label}`, target: label });
          this.cursor.hover({ label: `ok to ${label.toLowerCase()}?` });
          return { ok: false, stop: `"${label}"`, note: "", at };
        }
        await this.cursor.move(at, { label, target: label });
        this.cursor.click({ label, target: label });
        await page.click(t, L.locateMs);
        return { ok: true, note: `clicked ${label}`, at };
      }
      case "type": {
        const t = targetOf(s);
        const found = await page.locate(t, L.locateMs);
        if (!found) return s.optional ? { ok: false, skipped: true, note: `no "${describe(t)}" field` } : { ok: false, note: `couldn't find the "${describe(t)}" field` };
        if (!opts.allowSubmit && (s.submit || (s.enter && (await page.enterSubmits(t, L.locateMs))))) {
          const at = pageToScreen(await page.metrics(), aimPoint(found.box), this.baseDpr);
          await this.cursor.move(at, { label: "wait: submitting", target: describe(t) });
          return { ok: false, stop: `sending "${describe(t)}"`, note: "", at };
        }
        const at = pageToScreen(await page.metrics(), aimPoint(found.box), this.baseDpr);
        await this.cursor.move(at, { label: found.label || "typing", target: describe(t) });
        this.cursor.click({ label: found.label || describe(t) });
        this.cursor.type({ label: `"${s.value.slice(0, 32)}"` });
        await page.type(t, s.value, { delayMs: L.keyDelayMs, enter: s.enter, timeoutMs: L.locateMs });
        return { ok: true, note: `typed "${s.value.slice(0, 40)}"`, at };
      }
      case "scroll": {
        const m = await page.metrics();
        let vp = { x: m.innerWidth * 0.5, y: m.innerHeight * 0.55 };
        if (s.selector || s.text) {
          const found = await page.locate(targetOf(s), 2500).catch(() => null);
          if (found) vp = aimPoint(found.box);
        }
        const at = pageToScreen(m, vp, this.baseDpr);
        await this.cursor.move(at, { label: "scrolling" });
        const dy = s.dy ?? L.scrollDy;
        this.cursor.scroll({ label: dy < 0 ? "up" : "down" });
        await page.wheel(vp, dy);
        await this.sleep(450);
        return { ok: true, note: `scrolled ${dy < 0 ? "up" : "down"}`, at };
      }
      case "read": {
        const at = viewportCenter(await page.metrics(), this.baseDpr);
        await this.cursor.move(at, { label: "reading" });
        this.cursor.hover({ label: "reading" });
        const read = await page.read(Math.min(20_000, s.max ?? 6000));
        return { ok: true, note: `read ${read.title || shortUrl(read.url)}`, at, read };
      }
      case "screenshot": {
        const shot = await page.screenshot();
        return { ok: true, note: "looked at the page", shot };
      }
      case "wait": {
        await this.sleep(Math.max(0, Math.min(5000, s.ms)));
        return { ok: true, note: "" };
      }
    }
    return { ok: false, note: `unknown step ${(s as { op?: string }).op ?? i}` };
  }
}

function targetOf(s: { selector?: string; text?: string }): Target {
  return s.selector ? { selector: s.selector } : { text: s.text ?? "" };
}

function describe(t: Target): string {
  return (t.text || t.selector || "?").slice(0, 60);
}

export function httpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + (x.pathname.length > 1 ? x.pathname : "")).slice(0, 48);
  } catch {
    return u.slice(0, 48);
  }
}

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 160);
}
