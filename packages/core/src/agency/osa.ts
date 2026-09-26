/**
 * osascript plumbing. Every script we run is a constant: user data only ever
 * reaches AppleScript/JXA as argv (JXA `run(argv)`), never by splicing it into
 * source. The escapers below exist for the few one-liners that name an app, and
 * are tested against injection anyway.
 */

export interface OsaResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export interface OsaRunner {
  (script: string, opts?: { lang?: "AppleScript" | "JavaScript"; args?: string[]; timeoutMs?: number }): Promise<OsaResult>;
}

/** The real runner: `osascript -l <lang> -e <script> <args...>`, killed after timeoutMs. */
export const realOsa: OsaRunner = async (script, opts = {}) => {
  const lang = opts.lang ?? "AppleScript";
  const proc = Bun.spawn(["osascript", "-l", lang, "-e", script, ...(opts.args ?? [])], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Quote any string as an AppleScript string literal. Backslashes and double
 * quotes are escaped, and control characters (which could end a line and start
 * a new statement) are replaced with spaces.
 */
export function appleScriptString(s: string): string {
  const clean = String(s)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${clean}"`;
}

/** Quote any value as a JavaScript (JXA) literal. JSON is a JS subset once U+2028/2029 are escaped. */
export function jxaLiteral(v: unknown): string {
  return JSON.stringify(v ?? null)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Run a constant JXA script with one JSON payload as argv[0] and parse its JSON return value. */
export async function runJxa<T>(osa: OsaRunner, script: string, payload: unknown, timeoutMs = 20_000): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const r = await osa(script, { lang: "JavaScript", args: [JSON.stringify(payload ?? {})], timeoutMs });
  if (!r.ok) return { ok: false, error: r.stderr || `osascript exited ${r.code}` };
  try {
    return { ok: true, value: JSON.parse(r.stdout) as T };
  } catch {
    return { ok: false, error: `bad JSON from osascript: ${r.stdout.slice(0, 200)}` };
  }
}
