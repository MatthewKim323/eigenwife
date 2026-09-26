import { redactSecrets } from "../work/safety";

/**
 * Screen text redaction. Runs on every accessibility read before anything
 * else looks at it: emails, phone numbers, card numbers (Luhn-checked), API
 * keys and tokens (the work module's patterns plus a few more), long opaque
 * strings, then a hard character cap. Pure and tested.
 */

export const SCREEN_MAX_CHARS = 4000;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// +1 (415) 555-0134, 415-555-0134, 415.555.0134, +44 20 7946 0958. Needs 10+ digits total.
const PHONE = /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w.])/g;
// 13-19 digits, optionally grouped by spaces or dashes.
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
/** Extra token shapes the work module doesn't cover (bearer headers, generic long secrets, OpenAI/Anthropic style keys, npm, stripe restricted...). */
const TOKENS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\b(?:ya29|AQ[A-Za-z0-9])\.[A-Za-z0-9_-]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bvck_[A-Za-z0-9]{20,}\b/g,
  // long random-looking strings: 32+ chars of mixed letters and digits with no spaces
  /\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b/g,
];

export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export interface Redacted {
  text: string;
  /** How many things were replaced. Lots of redactions is itself a "this looks private" signal. */
  count: number;
}

/** Redact one string. Order matters: secrets and cards before phones (a card can look like a phone). */
export function redactScreenText(input: string): Redacted {
  let count = 0;
  const sub = (s: string, re: RegExp, tag: string, test?: (m: string) => boolean) =>
    s.replace(re, (m) => {
      if (test && !test(m)) return m;
      count++;
      return tag;
    });
  let t = String(input ?? "");
  const before = t;
  t = redactSecrets(t);
  if (t !== before) count += (t.match(/\[redacted\]/g) ?? []).length - (before.match(/\[redacted\]/g) ?? []).length;
  for (const re of TOKENS) t = sub(t, re, "[token]");
  t = sub(t, EMAIL, "[email]");
  t = sub(t, CARD, "[card]", luhn);
  t = sub(t, SSN, "[id]");
  t = sub(t, IBAN, "[account]");
  t = sub(t, PHONE, "[phone]", (m) => m.replace(/\D/g, "").length >= 10);
  return { text: t, count };
}

/** Collapse whitespace and cap. */
export function capText(s: string, max = SCREEN_MAX_CHARS): string {
  const t = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max) : t;
}
