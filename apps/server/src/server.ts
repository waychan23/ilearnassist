import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { User } from "@ilearnassist/shared";
import type { AppConfig } from "./config.js";
import { createDb, newId, seedDocumentParsersFromConfig, seedFromConfig, type AppDb } from "./db.js";
import { DocumentService } from "./documents/service.js";
import { dataLayout, ensureUserLayout, userLayout, type DataLayout, type UserLayout } from "./paths.js";
import { uniqueUserSlug } from "./workspace.js";
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
  /** The user this process runs as. See `ensureBootstrapUser`. */
  user: User;
  /** That user's tree — the workspaces root the routes create and delete under. */
  userLayout: UserLayout;
  /** Where uploads are written — handed to the routes so tests can redirect it. */
  uploadsRoot: string;
  /** Owns document text extraction; exported so tests can await quiescence. */
  documents: DocumentService;
  /** Whether the built frontend was found and is being served at `/`. */
  servesWebApp: boolean;
}

/**
 * The username of the account this process runs as, until there is a login screen.
 *
 * Ownership is already real in the schema and the tree is already per-user, so the server
 * needs *a* user rather than a nullable owner in every query. Signing in is the next change,
 * and when it lands this constant is the whole of what goes: every route already reads its
 * owner from one place (`routes`' `userId` option), and that place becomes the request's
 * user instead.
 *
 * Well-known and created on first boot, so a fresh data root is usable immediately and its
 * directory is predictable rather than a random slug.
 */
const BOOTSTRAP_USERNAME = "default";

/**
 * Find or create the running user, and make sure its tree exists.
 *
 * The slug is chosen once and stored; a later rename of the username will not move the
 * directory, for the same reason a workspace's rename does not. Uniqueness is checked
 * against the database first and the filesystem second — the database is the authority
 * (the column is `UNIQUE`), and a filesystem-only check races two sign-ins that arrive
 * together.
 */
function ensureBootstrapUser(
  db: AppDb,
  root: DataLayout
): { user: User; tree: UserLayout } {
  let user = db.findUserByUsername(BOOTSTRAP_USERNAME);
  if (!user) {
    const slug = uniqueUserSlug(
      BOOTSTRAP_USERNAME,
      (candidate) =>
        db.listUsers().some((u) => u.slug === candidate) ||
        existsSync(join(root.usersRoot, candidate))
    );
    user = db.createUser({ id: newId(), username: BOOTSTRAP_USERNAME, slug });
  }
  const tree = userLayout(root, user.slug);
  ensureUserLayout(tree);
  return { user, tree };
}

export async function buildServer(input: BuildServerInput): Promise<BuiltServer> {
  const { config, dataRoot } = input;
  const root = dataLayout(dataRoot);

  const db = createDb(root.sqliteFile);

  // System boot: the running user's tree must exist before any route can write into it.
  const { user, tree } = ensureBootstrapUser(db, root);

  /*
   * Attachments still live here rather than under the user's own `sources/`, which is where
   * they are headed. The two are the same kind of thing — bytes the user gave us — so this
   * path is the last piece of the old layout in the server, and it moves as one piece.
   */
  const uploadsRoot = join(dataRoot, "uploads");
  mkdirSync(uploadsRoot, { recursive: true });

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
  await app.register(routes, {
    config,
    db,
    uploadsRoot,
    documents,
    userId: user.id,
    userLayout: tree,
  });

  // After the API, so a concrete route always wins over the static wildcard.
  const servesWebApp = await registerWebApp(app, input.webDir);

  // A parse still running at shutdown would keep the process alive past `close()`.
  app.addHook("onClose", async () => {
    await documents.shutdown();
  });

  return {
    app,
    db,
    dataRoot,
    user,
    userLayout: tree,
    uploadsRoot,
    documents,
    servesWebApp,
  };
}
