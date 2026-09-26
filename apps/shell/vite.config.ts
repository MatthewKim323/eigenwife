import react from "@vitejs/plugin-react";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { defineConfig } from "vite";

/**
 * Local-only avatar models live in public/avatar/local/<id>/ (gitignored: third
 * party models are never committed to this public repo). The ids present on
 * this machine are baked in so the registry can prefer them over Haru.
 */
function localModels(): string[] {
  const dir = join(__dirname, "public", "avatar", "local");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && readdirSync(join(dir, d.name)).some((f) => f.endsWith(".model3.json")))
    .map((d) => d.name.toLowerCase());
}

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173 },
  define: {
    // EVE_MODEL picks the avatar model at build/dev time (?model= still wins at runtime).
    "import.meta.env.EVE_MODEL": JSON.stringify(process.env.EVE_MODEL ?? ""),
    "import.meta.env.EVE_LOCAL_MODELS": JSON.stringify(localModels().join(",")),
  },
});
