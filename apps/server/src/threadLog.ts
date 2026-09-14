import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The thread widget's observation log.
 *
 * A separate, append-only, human-readable file for watching how the classifier organises a
 * conversation — distinct from the pino request log, whose lines are machine-shaped and mixed
 * with every other request. It is **off until the real server process configures it**
 * (`index.ts`), so the test server writes nothing, and even configured it is lazy: the file
 * and its directory are created on the first block.
 *
 * The callback shape means a caller only pays for building a multi-line block when the log is
 * on. A write error is swallowed here on purpose: observation must never change a turn.
 */
let logFile: string | null = null;

/** Point the log at a file (the process entry point), or null to silence it (tests). */
export function configureThreadLog(path: string | null): void {
  logFile = path;
}

export function threadLogEnabled(): boolean {
  return logFile !== null;
}

export function threadLog(render: () => string): void {
  if (!logFile) return;
  const path = logFile;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, render(), { encoding: "utf8" });
  } catch {
    // A full disk or an unwritable log directory must not affect classification or a turn.
  }
}

/** The timestamp prefix every block starts with, local time for the person reading the file. */
export function logTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}
