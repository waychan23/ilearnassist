import Fastify from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, PROJECT_PATHS } from "./config.js";
import { createDb, seedFromConfig } from "./db.js";
import { ensureWorkspacesRoot } from "./workspace.js";
import { UPLOADS_ROOT } from "./attachments.js";
import routes from "./routes.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // System boot: ensure the global workspaces directory exists up front.
  ensureWorkspacesRoot(config.workspaces.rootDir);
  mkdirSync(UPLOADS_ROOT, { recursive: true });

  const db = createDb(join(PROJECT_PATHS.dataDir, "guided-learning.sqlite"));

  // First boot copies config.yaml's providers/models into the database. From then on the
  // Settings → Providers UI owns them; config.yaml is seed data only.
  seedFromConfig(db, {
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  });

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(routes, { config, db });

  const { host, port } = config.server;
  await app.listen({ host, port });
}

main().catch((err) => {
  console.error("Failed to start guided-learning server:", err);
  process.exit(1);
});