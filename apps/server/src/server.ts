import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { createDb, seedDocumentParsersFromConfig, seedFromConfig, type AppDb } from "./db.js";
import { DocumentService } from "./documents/service.js";
import { dataLayout, type DataLayout } from "./paths.js";
import { registerWebApp } from "./webApp.js";
import routes from "./routes.js";

/**
 * Assemble the whole server without binding a port.
 *
 * Kept separate from `index.ts` on purpose: `index.ts` runs `main()` as a module
 * side effect (and calls `process.exit(1)` on failure), so anything that imports it
 * starts a real server. Tests and the e2e harness import *this* module instead, hand
 * it a throwaway `dataRoot`, and drive the app through `inject()` or `listen({port: 0})`.
 */

export interface BuildServerInput {
  config: AppConfig;
  /**
   * The data root, already resolved by the entry point. Holds `users/` and `db/`, and
   * nothing here decides it — `resolveDataRoot()` does, and it has no default.
   */
  dataRoot: string;
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
  /** The chosen data root, as given. */
  dataRoot: string;
  /** The tree that root describes. Exported because tests make accounts and check them. */
  layout: DataLayout;
  /** Owns document text extraction; exported so tests can await quiescence. */
  documents: DocumentService;
  /** Whether the built frontend was found and is being served at `/`. */
  servesWebApp: boolean;
}

export async function buildServer(input: BuildServerInput): Promise<BuiltServer> {
  const { config, dataRoot } = input;
  const layout = dataLayout(dataRoot);

  const db = createDb(layout.sqliteFile);

  /*
   * No account is created here. There used to be one — a well-known "default" the server ran
   * as while ownership was real but signing in was not — and removing it is exactly what
   * this change is: the server now serves whoever the cookie names, so a fresh installation
   * has no accounts rather than one nobody chose. The first name typed on the login screen
   * is the first account.
   */

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

  const documents = new DocumentService({ db, config });

  const app = Fastify({ logger: input.logger ?? true });
  await app.register(cors, { origin: true });
  await app.register(routes, { config, db, documents, layout });

  // After the API, so a concrete route always wins over the static wildcard.
  const servesWebApp = await registerWebApp(app, input.webDir);

  // A parse still running at shutdown would keep the process alive past `close()`.
  app.addHook("onClose", async () => {
    await documents.shutdown();
  });

  return { app, db, dataRoot, layout, documents, servesWebApp };
}
