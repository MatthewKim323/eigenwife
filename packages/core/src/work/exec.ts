import type { Exec } from "../agency/types";

/**
 * The real process runner behind every work action: argv only (no shell unless
 * the argv is literally ["/bin/sh", "-c", ...] for an approved shell.run),
 * a hard timeout (SIGTERM, then SIGKILL), capped output, optional line streaming.
 */
export const realExec: Exec = async (argv, opts = {}) => {
  const max = opts.maxBytes ?? 1_000_000;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  }
  let timedOut = false;
  let hard: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {}
    hard = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 2000);
  };
  const timer = setTimeout(kill, opts.timeoutMs ?? 30_000);
  opts.signal?.addEventListener("abort", kill, { once: true });

  const collect = async (stream: ReadableStream<Uint8Array>, onLine?: (l: string) => void): Promise<string> => {
    const dec = new TextDecoder();
    let out = "";
    let buf = "";
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      if (out.length < max) out += s.slice(0, max - out.length);
      if (onLine) {
        buf += s;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      }
    }
    if (onLine && buf.trim()) onLine(buf.trim());
    return out;
  };

  try {
    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout as ReadableStream<Uint8Array>, opts.onLine),
      collect(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (hard) clearTimeout(hard);
    opts.signal?.removeEventListener("abort", kill);
  }
};
