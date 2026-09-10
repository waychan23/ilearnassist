import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove the scratch directory the e2e run created (sqlite database, uploads and the
 * workspace directories the app made). Deliberately teardown-only: cleanup in a
 * `globalSetup` would race the `webServer` processes, which may already be running.
 */
export default function globalTeardown(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  rmSync(join(root, ".e2e"), { recursive: true, force: true });
}
