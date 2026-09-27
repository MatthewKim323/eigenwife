import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import type { ScreenRect } from "@eigenwife/protocol";
import type { PageMetrics } from "./geometry";
import { soundsConsequential, type BrowserBackend, type BrowserPage, type Located, type Target } from "./driver";

/**
 * The real backend: playwright-core driving a headful Chromium with its own
 * persistent profile in ~/.eve/browser/profile (never matt's Chrome profile).
 * Input goes through CDP into her page only; the OS cursor is never touched.
 */

export const EVE_BROWSER_DIR = join(process.env.EVE_HOME || join(homedir(), ".eve"), "browser");
export const TITLE_PREFIX = "Eve's browser · ";

/** Keeps every tab title prefixed so the window reads as hers in the app switcher. */
const TITLE_SCRIPT = `(() => {
  const P = ${JSON.stringify(TITLE_PREFIX)};
  const fix = () => { try { if (!document.title.startsWith(P)) document.title = P + (document.title || location.hostname); } catch (e) {} };
  document.addEventListener("DOMContentLoaded", fix);
  setInterval(fix, 800);
})();`;

/** Evaluate once more if a navigation swapped the page out from under us. */
async function settled<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!/context was destroyed|navigat/i.test(String(err))) throw err;
    await new Promise((r) => setTimeout(r, 600));
    return fn();
  }
}

export function playwrightBackend(opts: { dir?: string; executablePath?: string } = {}): BrowserBackend {
  const dir = opts.dir ?? EVE_BROWSER_DIR;
  let ctx: BrowserContext | null = null;
  let page: Page | null = null;
  const closed: (() => void)[] = [];

  const current = (): Page => {
    if (!page || page.isClosed()) {
      const pages = ctx?.pages().filter((p) => !p.isClosed()) ?? [];
      page = pages[pages.length - 1] ?? null;
    }
    if (!page) throw new Error("my browser has no tab open");
    return page;
  };

  const locator = async (t: Target): Promise<Locator> => {
    const p = current();
    if (t.selector) return p.locator(t.selector).filter({ visible: true }).first();
    // A person clicking "Menu" means the link or button called Menu, not any text containing it.
    const name = t.text ?? "";
    const exactish = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const width = await p.evaluate(() => window.innerWidth).catch(() => 10_000);
    // Skip off-canvas matches (carousel slides, closed drawers): horizontally reachable only.
    const reachable = async (l: Locator): Promise<Locator | null> => {
      const n = Math.min(12, await l.count().catch(() => 0));
      for (let i = 0; i < n; i++) {
        const b = await l.nth(i).boundingBox().catch(() => null);
        if (b && b.x + b.width > 0 && b.x < width) return l.nth(i);
      }
      return null;
    };
    for (const role of ["link", "button", "tab"] as const) {
      const hit = await reachable(p.getByRole(role, { name: exactish }).filter({ visible: true }));
      if (hit) return hit;
    }
    const text = p.getByText(name, { exact: false }).filter({ visible: true });
    return (await reachable(text)) ?? text.first();
  };

  const wrap: BrowserPage = {
    async goto(url, timeoutMs) {
      // Committed is enough to start looking; slow sites finish loading while she scrolls.
      const p = current();
      await p.goto(url, { waitUntil: "commit", timeout: timeoutMs });
      await p.waitForLoadState("domcontentloaded", { timeout: Math.min(8000, timeoutMs) }).catch(() => {});
    },
    url: () => {
      try {
        return current().url();
      } catch {
        return "";
      }
    },
    async metrics(): Promise<PageMetrics> {
      return settled(() =>
        current().evaluate(() => ({
          screenX: window.screenX,
          screenY: window.screenY,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        })),
      );
    },
    async locate(t, timeoutMs): Promise<Located | null> {
      const loc = await locator(t);
      try {
        await loc.waitFor({ state: "visible", timeout: timeoutMs });
        await loc.scrollIntoViewIfNeeded({ timeout: timeoutMs });
      } catch {
        return null;
      }
      const box = await loc.boundingBox();
      if (!box) return null;
      const info = await loc.evaluate((el) => {
        const hit = (el.closest("button, a, input, [role=button], [role=link], [role=tab]") as HTMLElement | null) ?? (el as HTMLElement);
        const tag = hit.tagName.toLowerCase();
        const type = (hit.getAttribute("type") || "").toLowerCase();
        const form = hit.closest("form");
        const label = (hit.getAttribute("aria-label") || hit.innerText || (hit as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 60);
        const submitter = (tag === "button" && (type === "" || type === "submit") && !!form) || (tag === "input" && (type === "submit" || type === "image"));
        const post = !!form && (form.getAttribute("method") || "get").toLowerCase() === "post";
        const isLink = tag === "a" || hit.getAttribute("role") === "link";
        return { label, submitter, post, isLink };
      });
      // Links are browsing. Buttons that commit ("Book", "Pay") and POST forms are not.
      const submits = (info.submitter && info.post) || (!info.isLink && soundsConsequential(info.label));
      return { box, submits, label: info.label };
    },
    async click(t, timeoutMs) {
      const loc = await locator(t);
      // Stay in this tab: new-tab links would leave her cursor pointing at nothing.
      await loc.evaluate((el) => el.closest("a")?.removeAttribute("target")).catch(() => {});
      await loc.click({ timeout: timeoutMs });
    },
    async type(t, text, o) {
      const loc = await locator(t);
      await loc.click({ timeout: o.timeoutMs });
      await loc.fill("");
      await loc.pressSequentially(text, { delay: o.delayMs });
      if (o.enter) await loc.press("Enter");
    },
    async wheel(at, dy) {
      const p = current();
      await p.mouse.move(at.x, at.y);
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        await p.mouse.wheel(0, dy / steps);
        await p.waitForTimeout(35);
      }
    },
    async read(maxChars) {
      const p = current();
      const r = await p.evaluate(() => ({ title: document.title, url: location.href, text: (document.body?.innerText ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() }));
      return { title: r.title.replace(TITLE_PREFIX, ""), url: r.url, text: r.text.slice(0, maxChars) };
    },
    async screenshot() {
      return new Uint8Array(await current().screenshot({ type: "png" }));
    },
    async enterSubmits(t) {
      return (await locator(t))
        .evaluate((el) => {
          const f = (el as HTMLInputElement).form ?? el.closest("form");
          return !!f && (f.getAttribute("method") || "get").toLowerCase() === "post";
        })
        .catch(() => false);
    },
  };

  return {
    async launch() {
      if (!ctx) {
        const { chromium } = (await import("playwright-core")) as typeof import("playwright-core");
        mkdirSync(join(dir, "profile"), { recursive: true });
        ctx = await chromium.launchPersistentContext(join(dir, "profile"), {
          headless: false,
          viewport: null,
          executablePath: opts.executablePath || process.env.EVE_BROWSER_EXECUTABLE || undefined,
          args: ["--no-first-run", "--no-default-browser-check", "--window-position=0,40", "--window-size=720,860", "--disable-features=Translate", "--deny-permission-prompts"],
        });
        await ctx.addInitScript(TITLE_SCRIPT);
        ctx.on("close", () => {
          ctx = null;
          page = null;
          for (const cb of closed) cb();
        });
        // On a Mac, closing her last window keeps Chromium running with no windows,
        // so the context never closes: treat "no pages left" as closed.
        const watch = (p: NonNullable<typeof page>) =>
          p.on("close", () => {
            if (ctx && ctx.pages().length === 0) void ctx.close().catch(() => {});
          });
        ctx.on("page", (p) => {
          page = p;
          watch(p);
        });
        page = ctx.pages()[0] ?? (await ctx.newPage());
        watch(page);
        await page.bringToFront().catch(() => {});
      }
      const avail = await current().evaluate(() => ({
        x: (screen as unknown as { availLeft?: number }).availLeft ?? 0,
        y: (screen as unknown as { availTop?: number }).availTop ?? 0,
        width: screen.availWidth,
        height: screen.availHeight,
      }));
      return { page: wrap, avail };
    },
    async setBounds(r: ScreenRect) {
      const p = current();
      const cdp = await p.context().newCDPSession(p);
      try {
        const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });
      } finally {
        await cdp.detach().catch(() => {});
      }
      await p.waitForTimeout(120);
    },
    async close() {
      const c = ctx;
      ctx = null;
      page = null;
      await c?.close();
    },
    isOpen: () => !!ctx,
    onClosed(cb) {
      closed.push(cb);
    },
  };
}
