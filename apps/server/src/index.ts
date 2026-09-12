import { loadConfig, PROJECT_PATHS } from "./config.js";
import { buildServer } from "./server.js";

/**
 * Process entry point. All the wiring lives in `buildServer`; this module only loads
 * the config, binds the port, and turns a startup failure into a non-zero exit.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { app, db } = await buildServer({
    config,
    dataDir: PROJECT_PATHS.dataDir,
    webDir: PROJECT_PATHS.webDir,
  });

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

main().catch((err) => {
  console.error("Failed to start ilearnassist server:", err);
  process.exit(1);
});
