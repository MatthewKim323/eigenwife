import type { ScreenMode } from "@eigenwife/protocol";
import { hostOf } from "./privacy";

/**
 * The cheap local summarizer. Accessibility text in (already redacted and
 * capped), one compact line out: app + title + the error or headline or a
 * couple of key lines. Only this line (never the raw text) ever leaves the
 * machine. Also makes first guesses at mode / interesting / sensitive, which
 * are the local fallback when Jev is unreachable. Pure, well under 1ms.
 */

export interface AxText {
  /** AX role: AXStaticText, AXTextArea, AXHeading, ... */
  r: string;
  t: string;
}

export interface ScreenRead {
  app: string;
  bundleId?: string;
  title?: string;
  url?: string;
  texts: AxText[];
  selected?: string;
  focusedValue?: string;
  focusedRole?: string;
}

export interface Digest {
  app: string;
  title?: string;
  host?: string;
  /** The compact line sent to Jev and put in the world slot. Max ~300 chars. */
  summary: string;
  /** First error-looking line, trimmed ("TypeError: x is undefined (hub.ts line 42)"). */
  error?: string;
  /** Stable key for "the same error is still there" (error text without numbers that churn). */
  errorKey?: string;
  headline?: string;
  lines: string[];
  guess: { mode: ScreenMode; interesting: number; sensitive: boolean };
  /** Hash of everything read: unchanged screen = no new observation. */
  signature: string;
  chars: number;
}

export const EDITOR_APPS = /^(?:cursor|code|visual studio code|vscodium|windsurf|zed|xcode|sublime text|nova|webstorm|intellij idea|pycharm|goland|rustrover|fleet|android studio)$/i;
export const TERMINAL_APPS = /^(?:terminal|iterm2?|ghostty|warp|alacritty|kitty|wezterm|hyper|tabby)$/i;
export const BROWSER_APPS = /^(?:safari|google chrome|chrome|arc|brave browser|firefox|microsoft edge|orion|zen|dia|chromium|vivaldi|opera)$/i;
const WRITING_APPS = /^(?:pages|microsoft word|textedit|notes|notion|obsidian|bear|ulysses|craft|google docs|typora|ia writer)$/i;
const VIDEO_APPS = /^(?:tv|quicktime player|iina|vlc|netflix|infuse|plex)$/i;
const SOCIAL_APPS = /^(?:discord|slack|twitter|x|threads|instagram|telegram|beeper)$/i;
const GAME_APPS = /^(?:steam|minecraft|league of legends|riot client|battle\.net|epic games launcher|roblox)$/i;
const READER_APPS = /^(?:preview|books|skim|pdf expert|kindle|reeder|netnewswire)$/i;

const VIDEO_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|netflix\.com|twitch\.tv|hulu\.com|max\.com|disneyplus\.com|vimeo\.com|primevideo\.com|crunchyroll\.com)$/;
const SOCIAL_HOSTS = /(?:^|\.)(?:x\.com|twitter\.com|instagram\.com|reddit\.com|tiktok\.com|facebook\.com|threads\.net|bsky\.app|linkedin\.com|discord\.com|news\.ycombinator\.com)$/;
const SHOP_HOSTS = /(?:^|\.)(?:amazon\.[a-z.]+|etsy\.com|ebay\.com|shopify\.com|target\.com|walmart\.com|bestbuy\.com|nike\.com|ssense\.com|zara\.com|uniqlo\.com|grailed\.com|depop\.com|farfetch\.com|asos\.com|hm\.com|nordstrom\.com|aritzia\.com)$|shop|store/;
const READ_HOSTS = /(?:^|\.)(?:wikipedia\.org|arxiv\.org|medium\.com|substack\.com|nytimes\.com|theverge\.com|github\.com|docs\.[a-z.]+|developer\.[a-z.]+|stackoverflow\.com|notion\.site)$|docs|blog|news/;
const GAME_HOSTS = /(?:^|\.)(?:chess\.com|lichess\.org|poki\.com|itch\.io|store\.steampowered\.com)$/;

/** Lines that look like an error or a failure. */
export const ERROR_RE =
  /\b(?:[A-Z][A-Za-z]*(?:Error|Exception)\b|error(?:\[[\w-]+\])?:|Traceback \(most recent call last\)|panic(?:ked)?:|FAIL(?:ED)?\b|fatal:|Uncaught\b|cannot find (?:module|name)|is not defined|is not a function|undefined is not|Cannot read propert|ENOENT|EADDRINUSE|ECONNREFUSED|segmentation fault|exit(?:ed)? (?:with )?code [1-9]|command not found|Build failed|compilation failed|\d+ (?:errors?|failing)\b)/;
const FILE_LINE = /([\w@./-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|swift|java|kt|rb|php|c|cc|cpp|h|hpp|cs|vue|svelte|css|scss|json|toml|ya?ml))(?:[:(](\d+)(?:[:,]\d+)?\)?|,? line (\d+))/;
const SENSITIVE_RE =
  /\b(?:password|passcode|social security|ssn|account number|routing number|available balance|current balance|credit limit|diagnos(?:is|ed)|prescription|lab results|therapy notes|medical record|salary|tax return|w-2|1099|verification code|one-time code|security question|private key|seed phrase|recovery phrase)\b/i;
const PRICE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s?(?:usd|eur|gbp))/i;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** "src/core/hub.ts:42:7" -> "hub.ts line 42". */
export function fileLine(s: string): string | null {
  const m = FILE_LINE.exec(s);
  if (!m) return null;
  const file = m[1]!.split("/").pop()!;
  const line = m[2] ?? m[3];
  return line ? `${file} line ${line}` : file;
}

/** Pull the error out of a line: "TypeError: Cannot read properties of undefined (reading 'x')". */
export function errorLine(lines: string[]): { text: string; key: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!ERROR_RE.test(l)) continue;
    const m = /(?:[A-Z][A-Za-z]*(?:Error|Exception)|error(?:\[[\w-]+\])?|panic|fatal|FAIL(?:ED)?|Uncaught)\b:?.*/.exec(l);
    let text = (m ? m[0] : l).trim();
    // Location: on the same line, or in the next couple (stack frames, "--> src/x.rs:3").
    const where = fileLine(l) ?? lines.slice(i + 1, i + 4).map(fileLine).find(Boolean) ?? null;
    text = clip(text.replace(/\s+/g, " "), 120);
    if (where && !text.includes(where.split(" ")[0]!)) text = `${text} (${where})`;
    const key = text
      .toLowerCase()
      .replace(/\d+/g, "#")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    return { text, key };
  }
  return null;
}

function splitLines(texts: AxText[]): string[] {
  const out: string[] = [];
  for (const x of texts) {
    for (const raw of x.t.split(/\r?\n/)) {
      const l = raw.replace(/\s+/g, " ").trim();
      if (l.length >= 2) out.push(l);
    }
  }
  return out;
}

export function guessMode(app: string, host: string | null, error: boolean, focusedRole?: string): ScreenMode {
  const a = app.trim();
  if (EDITOR_APPS.test(a) || TERMINAL_APPS.test(a)) return error ? "debugging" : "coding";
  if (GAME_APPS.test(a)) return "gaming";
  if (VIDEO_APPS.test(a)) return "video";
  if (SOCIAL_APPS.test(a)) return "social";
  if (host) {
    if (VIDEO_HOSTS.test(host)) return "video";
    if (SOCIAL_HOSTS.test(host)) return "social";
    if (GAME_HOSTS.test(host)) return "gaming";
    if (SHOP_HOSTS.test(host)) return "shopping";
    if (/github\.com$|localhost|127\.0\.0\.1|vercel\.app$/.test(host) && error) return "debugging";
    if (READ_HOSTS.test(host)) return "reading";
  }
  if (WRITING_APPS.test(a)) return error ? "debugging" : "writing";
  if (READER_APPS.test(a)) return "reading";
  if (error) return "debugging";
  if (BROWSER_APPS.test(a)) return "reading";
  if (focusedRole === "AXTextArea") return "writing";
  return "idle";
}

/** Local interest prior per mode: shopping and social are what a friend glancing over would comment on. */
const INTEREST: Record<ScreenMode, number> = { shopping: 0.62, social: 0.5, video: 0.45, reading: 0.38, gaming: 0.4, writing: 0.2, debugging: 0.3, coding: 0.12, idle: 0.05 };

export function summarize(read: ScreenRead, redactions = 0): Digest {
  const app = read.app || "unknown app";
  const title = read.title?.trim() || undefined;
  const host = hostOf(read.url) ?? undefined;
  const lines = splitLines(read.texts).filter((l) => l !== title);
  const err = errorLine(lines);
  const headings = read.texts.filter((x) => x.r === "AXHeading").map((x) => x.t.replace(/\s+/g, " ").trim()).filter(Boolean);
  const headline = headings[0] ? clip(headings[0], 100) : undefined;
  // Key lines: distinct, sentence-ish, not UI crumbs.
  const seen = new Set<string>();
  const key: string[] = [];
  for (const l of lines) {
    if (l.length < 12 || l.length > 220 || seen.has(l)) continue;
    if (/^[\W\d_]+$/.test(l)) continue;
    seen.add(l);
    key.push(clip(l, 90));
    if (key.length >= 3) break;
  }
  const prices = lines.filter((l) => PRICE.test(l) && l.length < 120).slice(0, 2);
  const mode = guessMode(app, host ?? null, !!err, read.focusedRole);
  const parts: string[] = [title ? `${app}: ${clip(title, 90)}` : app];
  if (host && !(title ?? "").toLowerCase().includes(host.replace(/^www\./, ""))) parts.push(host.replace(/^www\./, ""));
  if (err) parts.push(`error: ${err.text}`);
  else if (headline && headline !== title) parts.push(headline);
  if (mode === "shopping" && prices.length) parts.push(prices.map((p) => clip(p, 60)).join(" / "));
  const room = err ? 1 : 2;
  const extra = key.filter((k) => !parts.some((p) => p.includes(k.slice(0, 30)))).slice(0, room);
  if (extra.length) parts.push(extra.join(" / "));
  if (read.selected?.trim()) parts.push(`selected: "${clip(read.selected.replace(/\s+/g, " ").trim(), 80)}"`);
  const summary = clip(parts.join(" · "), 300);
  const all = [app, title ?? "", read.url ?? "", ...read.texts.map((x) => x.t), read.selected ?? "", read.focusedValue ?? ""].join("\n");
  let interesting = INTEREST[mode];
  if (mode === "shopping" && prices.length) interesting += 0.1;
  if (headline) interesting += 0.05;
  if (lines.length < 3) interesting -= 0.1;
  const sensitive = SENSITIVE_RE.test(all) || redactions >= 4;
  return {
    app,
    title,
    host,
    summary,
    ...(err ? { error: err.text, errorKey: err.key } : {}),
    headline,
    lines: key,
    guess: { mode, interesting: Math.max(0, Math.min(1, Math.round(interesting * 100) / 100)), sensitive },
    signature: hash(all),
    chars: all.length,
  };
}
