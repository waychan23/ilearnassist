import { assertHasAdministrator, NoAdministratorError } from "./adminCli.js";
import { loadConfig, PROJECT_PATHS, resolveDataRoot } from "./config.js";
import { buildServer } from "./server.js";

/**
 * Process entry point. All the wiring lives in `buildServer`; this module only resolves
 * the data root, loads the config, binds the port, and turns a startup failure into a
 * non-zero exit.
 */
async function main(): Promise<void> {
  // First, and deliberately here rather than in `config.ts`: the data root is a launcher
  // decision, not a config value, and a missing one should produce one actionable sentence
  // and a non-zero exit rather than a stack trace from a module that every test imports.
  const dataRoot = resolveDataRoot();

  const config = loadConfig();
  const { app, db } = await buildServer({
    config,
    dataRoot,
    webDir: PROJECT_PATHS.webDir,
  });

  // After `buildServer` and before `listen`, which is the only order that works: the predicate
  // needs a database, and binding the port is the thing being refused. See the note on
  // `assertHasAdministrator` for what has already happened to the data root by this point.
  assertHasAdministrator(db);

  const { host, port } = config.server;
  const address = await app.listen({ host, port });

  // The one line the desktop control panel keys on to learn where the app came up. It
  // reports the address Fastify actually bound rather than `config.server.port`, which
  // is what makes `port: 0` usable: the OS picks a free port and the shell still ends
  // up with the URL, with no separate probe to race against.
  console.log(`[ilearnassist] listening on ${address}`);

  // The desktop shell stops the server with SIGTERM. Closing through Fastify runs the
  // `onClose` hooks, so an in-flight document parse settles and the sqlite connection
  // is shut down rather than killed mid-write. `db.raw.close()` is here rather than in
  // an `onClose` hook because `startTestServer` closes the database itself, and a second
  // close on a better-sqlite3 handle throws.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(
        () => {
          db.raw.close();
          process.exit(0);
        },
        () => process.exit(1)
      );
    });
  }
}

main().catch((err: unknown) => {
  // The one refusal that is a *sentence* rather than a fault. "Failed to start …" followed by a
  // stack says nothing to somebody whose data folder has no administrator, and the sentence
  // `assertHasAdministrator` throws already names the fix — so it is printed alone, on stderr,
  // the way `resolveDataRoot`'s is.
  if (err instanceof NoAdministratorError) {
    console.error(err.message);
    process.exit(1);
    return;
  }
  console.error("Failed to start ilearnassist server:", err);
  process.exit(1);
});
