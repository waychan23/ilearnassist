import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { createDb, seedDocumentParsersFromConfig, seedFromConfig, type AppDb } from "./db.js";
import { DocumentService } from "./documents/service.js";
import { ensureWorkspacesRoot } from "./workspace.js";
import { registerWebApp } from "./webApp.js";
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
  /**
   * Holds the built frontend to serve alongside the API. Omitted by the tests on
   * purpose: whether `apps/web/dist` happens to exist on the machine running them must
   * not change what they assert, so only the real entry point passes this.
   */
  webDir?: string;
  /** Fastify's logger. Tests pass `false` so route logs don't bury the assertions. */
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  db: AppDb;
  /** Where uploads are written — handed to the routes so tests can redirect it. */
  uploadsRoot: string;
  /** Owns document text extraction; exported so tests can await quiescence. */
  documents: DocumentService;
  /** Whether the built frontend was found and is being served at `/`. */
  servesWebApp: boolean;
}

export async function buildServer(input: BuildServerInput): Promise<BuiltServer> {
  const { config, dataDir } = input;

  // System boot: the workspaces root and the uploads tree must exist up front.
  ensureWorkspacesRoot(config.workspaces.rootDir);
  const uploadsRoot = join(dataDir, "uploads");
  mkdirSync(uploadsRoot, { recursive: true });

  const db = createDb(join(dataDir, "ilearnassist.sqlite"));

  // First boot copies config.yaml's providers/models into the database. From then on the
  // Settings → Providers UI owns them; config.yaml is seed data only.
  seedFromConfig(db, {
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  });

  // Document parsers follow the same seed-once contract, but are marked with an explicit
  // setting rather than "the table is empty" — see SETTING_DOCUMENT_SEEDED.
  seedDocumentParsersFromConfig(db, {
    parsers: config.documentParsers,
    parsing: {
      localEnabled: config.documentParsing.localEnabled,
      policy: config.documentParsing.policy,
      fallbackEnabled: config.documentParsing.fallbackEnabled,
      defaultParserId: config.documentParsing.defaultParserId ?? null,
    },
  });

  const documents = new DocumentService({ uploadRoot: uploadsRoot, db, config });

  const app = Fastify({ logger: input.logger ?? true });
  await app.register(cors, { origin: true });
  await app.register(routes, { config, db, uploadsRoot, documents });

  // After the API, so a concrete route always wins over the static wildcard.
  const servesWebApp = await registerWebApp(app, input.webDir);

  // A parse still running at shutdown would keep the process alive past `close()`.
  app.addHook("onClose", async () => {
    await documents.shutdown();
  });

  return { app, db, uploadsRoot, documents, servesWebApp };
}
