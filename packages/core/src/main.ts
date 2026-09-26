import { startCore } from "./index";
import { allModules } from "./modules/registry";

const core = await startCore(allModules());
console.log(`eve core listening on http://127.0.0.1:${core.port} (bus ws://127.0.0.1:${core.port}/bus)`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await core.stop();
    process.exit(0);
  });
}
