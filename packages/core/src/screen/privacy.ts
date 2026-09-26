import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isPrivateApp } from "../work/safety";

/**
 * What Eve never reads on screen, and the persisted screen settings
 * (~/.eve/screen.json). A denylisted app or domain shows up only as
 * "private app": no title, no text, no capture.
 */

/** Apps on top of the work module's private list (password managers, Messages, Mail, banks, Wallet, Health). */
export const SCREEN_PRIVATE_APPS = [
  "keychain access",
  "system settings",
  "system preferences",
  "passwords",
  "authy",
  "google authenticator",
  "ledger live",
  "exodus",
  "metamask",
  "turbotax",
  "quicken",
  "mint",
  "ynab",
  "facetime",
  "photo booth",
];

/** Domains whose pages are never read or captured (and all their subdomains). */
export const PRIVATE_DOMAINS = [
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "capitalone.com",
  "citi.com",
  "citibank.com",
  "americanexpress.com",
  "usbank.com",
  "pnc.com",
  "tdbank.com",
  "discover.com",
  "ally.com",
  "sofi.com",
  "chime.com",
  "schwab.com",
  "fidelity.com",
  "vanguard.com",
  "etrade.com",
  "robinhood.com",
  "coinbase.com",
  "kraken.com",
  "binance.com",
  "paypal.com",
  "venmo.com",
  "cash.app",
  "wise.com",
  "revolut.com",
  "mercury.com",
  "brex.com",
  "ramp.com",
  "monarchmoney.com",
  "copilot.money",
  "mint.intuit.com",
  "creditkarma.com",
  "experian.com",
  "equifax.com",
  "transunion.com",
  "irs.gov",
  "ssa.gov",
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
  "dashlane.com",
  "accounts.google.com",
  "appleid.apple.com",
  "mychart.org",
  "mail.google.com",
  "outlook.live.com",
  "messages.google.com",
  "web.whatsapp.com",
  "web.telegram.org",
];

/** Titles that are private on their face, whatever the app ("Chase Online", "Sign in to your bank"). */
const PRIVATE_TITLE = /\b(?:online banking|bank of|credit union|brokerage|wire transfer|routing number|account balance|statement for|patient portal|mychart|password|passcode|2fa|two.factor|verification code|one.time code|sign in to|log in to your)\b/i;

export interface ScreenSettings {
  /** Screen awareness paused (tray "Pause screen", cmd+shift+P). */
  paused: boolean;
  /** Extra app names (substring, case-insensitive) that are private. */
  denyApps: string[];
  /** Extra domains (and their subdomains) that are private. */
  denyDomains: string[];
  /** Permission hints she already said out loud, so she says each one once. */
  told: { accessibility?: boolean; screenRecording?: boolean };
}

export const DEFAULT_SETTINGS: ScreenSettings = { paused: false, denyApps: [], denyDomains: [], told: {} };

export function parseSettings(raw: string | null): ScreenSettings {
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
    const deny = (j.denylist ?? j.deny ?? {}) as Record<string, unknown>;
    const told = (j.told ?? {}) as Record<string, unknown>;
    return {
      paused: j.paused === true,
      denyApps: [...list(j.denyApps), ...list(deny.apps)],
      denyDomains: [...list(j.denyDomains), ...list(deny.domains)].map((d) => d.toLowerCase().replace(/^\*\./, "")),
      told: { accessibility: told.accessibility === true, screenRecording: told.screenRecording === true },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function serializeSettings(s: ScreenSettings): string {
  return JSON.stringify({ paused: s.paused, denylist: { apps: s.denyApps, domains: s.denyDomains }, told: s.told }, null, 2) + "\n";
}

export function settingsPath(eveHome: string) {
  return join(eveHome, "screen.json");
}

export function loadSettings(eveHome: string): ScreenSettings {
  const p = settingsPath(eveHome);
  try {
    return parseSettings(existsSync(p) ? readFileSync(p, "utf8") : null);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(eveHome: string, s: ScreenSettings) {
  const p = settingsPath(eveHome);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, serializeSettings(s));
  } catch {}
}

export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function domainMatch(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** Why this window is private, or null. Checked before any text is looked at. */
export function privateReason(w: { app?: string; bundleId?: string; title?: string; url?: string }, s: Pick<ScreenSettings, "denyApps" | "denyDomains">): string | null {
  const app = (w.app ?? "").toLowerCase();
  if (isPrivateApp(w.app, w.bundleId)) return "private app";
  if (SCREEN_PRIVATE_APPS.some((p) => app === p || app.startsWith(p + " ") || (p.length >= 8 && app.includes(p)))) return "private app";
  if (s.denyApps.some((p) => app.includes(p.toLowerCase()))) return "denylisted app";
  const host = hostOf(w.url);
  if (host) {
    if (PRIVATE_DOMAINS.some((d) => domainMatch(host, d))) return "private site";
    if (s.denyDomains.some((d) => domainMatch(host, d))) return "denylisted site";
    if (/(?:^|\.)(?:bank|banking|creditunion)[a-z0-9-]*\./.test(host)) return "private site";
  }
  if (w.title && PRIVATE_TITLE.test(w.title)) return "private title";
  return null;
}
