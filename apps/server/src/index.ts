import { loadConfig, PROJECT_PATHS } from "./config.js";
import { buildServer } from "./server.js";

/**
 * Process entry point. All the wiring lives in `buildServer`; this module only loads
 * the config, binds the port, and turns a startup failure into a non-zero exit.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildServer({ config, dataDir: PROJECT_PATHS.dataDir });

  const { host, port } = config.server;
  await app.listen({ host, port });
}

main().catch((err) => {
  console.error("Failed to start guided-learning server:", err);
  process.exit(1);
});
