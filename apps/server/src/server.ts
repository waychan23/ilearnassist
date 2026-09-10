import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { createDb, seedFromConfig, type AppDb } from "./db.js";
import { ensureWorkspacesRoot } from "./workspace.js";
import routes from "./routes.js";

/**
 * Assemble the whole server without binding a port.
 *
 * Kept separate from `index.ts` on purpose: `index.ts` runs `main()` as a module
 * side effect (and calls `process.exit(1)` on failure), so anything that imports it
 * starts a real server. Tests and the e2e harness import *this* module instead, hand
 * it a throwaway `dataDir`, and drive the app through `inject()` or `listen({port: 0})`.
 */

export interface BuildServerInput {
  config: AppConfig;
  /** Holds the sqlite database and the `uploads/` tree. */
  dataDir: string;
  /** Fastify's logger. Tests pass `false` so route logs don't bury the assertions. */
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  db: AppDb;
  /** Where uploads are written — handed to the routes so tests can redirect it. */
  uploadsRoot: string;
}

export async function buildServer(input: BuildServerInput): Promise<BuiltServer> {
  const { config, dataDir } = input;

  // System boot: the workspaces root and the uploads tree must exist up front.
  ensureWorkspacesRoot(config.workspaces.rootDir);
  const uploadsRoot = join(dataDir, "uploads");
  mkdirSync(uploadsRoot, { recursive: true });

  const db = createDb(join(dataDir, "guided-learning.sqlite"));

  // First boot copies config.yaml's providers/models into the database. From then on the
  // Settings → Providers UI owns them; config.yaml is seed data only.
  seedFromConfig(db, {
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  });

  const app = Fastify({ logger: input.logger ?? true });
  await app.register(cors, { origin: true });
  await app.register(routes, { config, db, uploadsRoot });

  return { app, db, uploadsRoot };
}
