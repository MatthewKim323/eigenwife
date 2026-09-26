import { realpathSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, normalize, resolve } from "path";

/**
 * The work module's hard lines. Everything here is pure and tested: paths Eve
 * never reads or opens, secrets she never repeats, shell commands she refuses
 * even with a yes, and apps whose window titles she never looks at.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Directories under ~ that are never read, opened, searched or used as a repo. */
const DENY_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".config/gcloud",
  ".config/gh",
  ".config/op",
  ".local/share/keyrings",
  "Library/Keychains",
  "Library/Messages",
  "Library/Mail",
  "Library/Cookies",
  "Library/Accounts",
  "Library/Application Support/1Password",
  "Library/Group Containers/2BUA8C4S2C.com.1password",
  "Library/Application Support/Bitwarden",
  "Library/Application Support/com.apple.TCC",
  "Library/Safari",
  "Library/Containers/com.apple.Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Arc",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Firefox",
  ".claude/.credentials.json",
  ".codex/auth.json",
];

/** Absolute paths outside ~ that are off limits. */
const DENY_ABS = ["/Library/Keychains", "/System/Library/Keychains", "/private/var/db", "/etc/sudoers", "/etc/master.passwd", "/private/etc/sudoers"];

/** File names that hold secrets wherever they live. */
const DENY_NAME =
  /^(?:\.env(?:\..+)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|known_hosts|authorized_keys|credentials(?:\.json)?|secrets?(?:\.[a-z]+)?|.*\.(?:pem|key|p12|pfx|keychain|keychain-db|kdbx|asc|gpg|ovpn|mobileprovision))$/i;

/** .env.example and friends are templates, not secrets. */
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults)$/i;

export function expandHome(p: string, home = homedir()): string {
  const t = p.trim();
  if (t === "~") return home;
  if (t.startsWith("~/")) return join(home, t.slice(2));
  return t;
}

/** Resolve symlinks when the path exists, so a link into ~/.ssh is still ~/.ssh. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Why a path is off limits, or null when Eve may touch it. */
export function deniedPath(raw: string, home = homedir()): string | null {
  if (!raw || typeof raw !== "string") return "no path";
  const expanded = expandHome(raw, home);
  const abs = isAbsolute(expanded) ? normalize(expanded) : resolve(home, expanded);
  for (const candidate of new Set([abs, real(abs)])) {
    const name = basename(candidate);
    if (DENY_NAME.test(name) && !ENV_TEMPLATE.test(name)) return `${name} holds secrets`;
    for (const d of DENY_DIRS) {
      const dir = join(home, d);
      if (candidate === dir || candidate.startsWith(dir + "/")) return `~/${d} is private`;
    }
    for (const d of DENY_ABS) if (candidate === d || candidate.startsWith(d + "/")) return `${d} is private`;
    if (/\/(?:[^/]*keychain[^/]*|\.password-store)(?:\/|$)/i.test(candidate)) return "keychains are private";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|auth)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi;

/** Replace anything that looks like a credential with [redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  out = out.replace(ASSIGNMENT, (_m, k: string, sep: string, q: string) => `${k}${sep}${q}[redacted]${q}`);
  return out;
}

// ---------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------

const DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\b|--recursive|--force)/, "recursive or forced rm"],
  [/\bgit\s+push\b[^|;&]*(?:\s-f\b|--force|--force-with-lease|\s\+\S)/, "force push"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
  [/\bgit\s+clean\b[^|;&]*-[a-zA-Z]*f/, "git clean -f"],
  [/\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, "discarding the working tree"],
  [/\bgit\s+branch\s+-D\b/, "force-deleting a branch"],
  [/\bgit\s+filter-(?:branch|repo)\b/, "rewriting history"],
  [/(?:^|[\s;&|(])(?:sudo|su|doas)\b/, "sudo"],
  [/\b(?:diskutil|hdiutil|fdisk|gpt|newfs(?:_\w+)?|mkfs(?:\.\w+)?|asr|bless|nvram|csrutil|tmutil\s+delete)\b/, "disk utilities"],
  [/\bdd\s+[^|;&]*\b(?:if|of)=/, "dd"],
  [/\b(?:shutdown|reboot|halt|launchctl|systemsetup|pmset|spctl|kextload|kextunload)\b/, "system control"],
  [/\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python3?|node|bun|perl|ruby)\b/, "piping a download into a shell"],
  [/\b(?:sh|bash|zsh)\s+<\s*\(\s*(?:curl|wget)/, "running a downloaded script"],
  [/\bchmod\s+(?:-R\s+)?[0-7]*777\b|\bchmod\s+-R\b|\bchown\s+-R\b/, "recursive permission changes"],
  [/\b(?:killall|pkill)\b|\bkill\s+-9\s+(?:-1|1)\b/, "killing processes"],
  [/:\(\)\s*\{/, "fork bomb"],
  [/>\s*\/dev\/(?:disk|rdisk|sd)/, "writing to a disk device"],
  [/\bsecurity\s+(?:find|dump|delete|export|unlock)/, "keychain access"],
  [/\bdefaults\s+delete\b/, "deleting preferences"],
  [/\bcrontab\s+-r\b/, "wiping crontab"],
  [/\bosascript\b/, "arbitrary automation"],
  [/\beval\b/, "eval"],
  [/\bfind\b[^|;&]*\s-(?:delete|exec\s+rm)\b/, "find -delete"],
  [/\bxargs\s+(?:-\S+\s+)*rm\b/, "xargs rm"],
  [/\b(?:truncate|shred|srm)\b/, "destroying file contents"],
  [/\bmv\s+[^|;&]*\s(?:\/dev\/null|~\/?\s*$|\/\s*$)/, "moving files into oblivion"],
  [/(?:^|\s)>\s*~\/\.[\w.-]+/, "overwriting a dotfile"],
  [/\b(?:npm|bun|pnpm|yarn)\s+publish\b/, "publishing a package"],
  [/\bgh\s+(?:repo\s+delete|release\s+delete)\b/, "deleting on github"],
];

/** Why a command is refused outright (no approval can unlock it), or null. */
export function destructiveCommand(cmd: string, home = homedir()): string | null {
  const c = String(cmd ?? "").trim();
  if (!c) return "empty command";
  if (c.length > 600) return "command too long to read back";
  if (/[\n\r]/.test(c)) return "multi-line commands aren't allowed";
  for (const [re, why] of DESTRUCTIVE) if (re.test(c)) return `refused: ${why}`;
  // Reading secrets through the shell is still reading secrets.
  for (const tok of c.split(/[\s|;&<>()"'`=]+/)) {
    if (!tok || !/[/~.]/.test(tok)) continue;
    if (/^-/.test(tok)) continue;
    if (tok.includes("/") || tok.startsWith("~") || tok.startsWith(".")) {
      const why = deniedPath(tok, home);
      if (why && why !== "no path") return `refused: ${why}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/** Apps whose window titles Eve never reads. Matched case-insensitively as substrings. */
export const PRIVATE_APPS = [
  "1password",
  "bitwarden",
  "lastpass",
  "dashlane",
  "keeper",
  "passwords",
  "keychain access",
  "messages",
  "facetime",
  "signal",
  "whatsapp",
  "telegram",
  "mail",
  "chase",
  "bank of america",
  "wells fargo",
  "capital one",
  "citi",
  "amex",
  "american express",
  "venmo",
  "cash app",
  "paypal",
  "robinhood",
  "coinbase",
  "schwab",
  "fidelity",
  "vanguard",
  "monarch",
  "copilot money",
  "wallet",
  "health",
];

export function isPrivateApp(app: string | undefined, bundleId?: string): boolean {
  const a = (app ?? "").toLowerCase();
  const b = (bundleId ?? "").toLowerCase();
  if (!a && !b) return false;
  // Short names ("mail", "citi") must match a whole word of the app name; long ones may be substrings ("1Password 8").
  const words = a.split(/[^a-z0-9]+/);
  const byName = PRIVATE_APPS.some((p) => (p.includes(" ") ? a.includes(p) : words.includes(p) || (p.length >= 6 && a.includes(p))));
  return byName || /1password|bitwarden|com\.apple\.(?:mobilesms|mail|keychainaccess|passwords|facetime|health)/.test(b);
}
