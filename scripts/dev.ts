/**
 * One command for the whole body: core (brain wiring + bus), shell (face), and
 * optionally the eye tracker and the macOS watcher.
 *
 *   bun run dev                 core + shell
 *   bun run dev --eye           + eye serve (webcam gaze)
 *   bun run dev --watcher       + macOS app/media watcher
 *   bun run dev --all           everything
 */
import { existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const all = args.has("--all");

interface Proc {
  name: string;
  color: string;
  cmd: string[];
  cwd: string;
  when: boolean;
}

const procs: Proc[] = [
  { name: "core", color: "\x1b[35m", cmd: ["bun", "run", "src/main.ts"], cwd: join(root, "packages/core"), when: true },
  { name: "shell", color: "\x1b[36m", cmd: ["bunx", "vite", "--port", "5173", "--strictPort"], cwd: join(root, "apps/shell"), when: true },
  { name: "eye", color: "\x1b[33m", cmd: ["uv", "run", "eye", "serve"], cwd: join(root, "eye"), when: all || args.has("--eye") },
  {
    name: "watcher",
    color: "\x1b[32m",
    cmd: ["python3", "watcher/watch.py"],
    cwd: root,
    when: (all || args.has("--watcher")) && existsSync(join(root, "watcher/watch.py")),
  },
];

const running: ReturnType<typeof Bun.spawn>[] = [];

async function pipe(name: string, color: string, stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) console.log(`${color}${name.padEnd(7)}\x1b[0m ${l}`);
  }
}

for (const p of procs.filter((p) => p.when)) {
  const proc = Bun.spawn(p.cmd, { cwd: p.cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  running.push(proc);
  void pipe(p.name, p.color, proc.stdout as ReadableStream<Uint8Array>);
  void pipe(p.name, p.color, proc.stderr as ReadableStream<Uint8Array>);
}

console.log("\n  eigenwife\n  shell  http://127.0.0.1:5173   (?gaze=mouse to fake gaze with the pointer)\n  core   http://127.0.0.1:7777/health\n");

const shutdown = () => {
  for (const p of running) p.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await Promise.all(running.map((p) => p.exited));
