import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isEnabledSuperadmin } from "@ilearnassist/shared";
import type { AppConfig } from "./config.js";
import {
  createDb,
  seedBuiltInCopilots,
  seedDocumentParsersFromConfig,
  seedFromConfig,
  type AppDb,
} from "./db.js";
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
   * No account is created here, and none can be. There used to be one — a well-known
   * "default" the server ran as while ownership was real but signing in was not — and now an
   * account needs a password, which only a person choosing one can supply. So a fresh data
   * root has nobody in it, and the first administrator is made with the server *stopped*:
   * `cli create-admin`, or the desktop control panel driving it. `assertHasAdministrator`
   * below is what refuses to listen until one exists.
   */

  /*
   * Tokens that are dead are dropped at every boot.
   *
   * `auth_tokens` is the one table that grows with *use* rather than with what somebody made:
   * one row per sign-in, per device, forever. Nothing reads a dead row — the gate refuses it
   * on `revoked_at` or `expires_at` before it looks at anything else — so this is housekeeping
   * rather than a rule, which is why it runs once at boot and not on a timer.
   *
   * Ten minutes of grace on the revocation side, so a session the console just killed is
   * still in the table for anybody looking at what it did.
   */
  db.pruneAuthTokens(new Date(Date.now() - 10 * 60 * 1000).toISOString());

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

  /*
   * The built-in assistants, for a data root that already has an administrator.
   *
   * `createAdmin` seeds them inside its own transaction, so this only ever fires on an
   * installation that predates the catalog — a checkout somebody has been using, or the e2e
   * root after `ensure-admin`. It cannot fire twice: the seeder is marker-gated, and it does
   * nothing at all when no enabled superadmin exists (which is also the state the check below
   * refuses to listen in).
   */
  const administrator = db.listUsers().find(isEnabledSuperadmin);
  if (administrator) seedBuiltInCopilots(db, administrator.id);

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
