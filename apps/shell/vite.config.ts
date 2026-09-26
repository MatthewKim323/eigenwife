import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173 },
  // EVE_MODEL picks the avatar model at build/dev time (?model= still wins at runtime).
  define: { "import.meta.env.EVE_MODEL": JSON.stringify(process.env.EVE_MODEL ?? "") },
});
