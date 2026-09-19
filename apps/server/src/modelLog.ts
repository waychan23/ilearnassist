import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The observation log for the out-of-band model calls.
 *
 * A separate, append-only, human-readable file per call kind — the thread classifier and the
 * insight pass — for watching how a long, unstreamed, easy-to-get-wrong prompt actually behaves.
 * Distinct from the pino request log, whose lines are machine-shaped and mixed with every other
 * request. It is **off until the real server process configures it** (`index.ts`), so the test
 * server writes nothing, and even configured it is lazy: the file and its directory are created
 * on the first block.
 *
 * One module for both kinds rather than one per kind, because the thing being shared is the
 * append helper — and a second copy of "mkdir, append, swallow the error" is exactly the
 * duplication this repository does not keep. The *kind* is a parameter so a file cannot be
 * written by the wrong caller: without it, a future third call would have to remember which
 * `configure…Log(null)` in a test silences it.
 *
 * The callback shape means a caller only pays for building a multi-line block when that kind's
 * log is on. A write error is swallowed here on purpose: observation must never change a turn.
 */

/** Which out-of-band call a block came from. One log file each. */
export type ModelLogKind = "threads" | "insights";

const logFiles: Record<ModelLogKind, string | null> = {
  threads: null,
  insights: null,
};

/**
 * Point the logs at their files (the process entry point), or `null` to silence one (tests).
 *
 * A field left out is left as it was, so a test that silences one kind cannot accidentally
 * reconfigure the other.
 */
export function configureModelLog(paths: Partial<Record<ModelLogKind, string | null>>): void {
  for (const [kind, path] of Object.entries(paths)) {
    logFiles[kind as ModelLogKind] = path ?? null;
  }
}

export function modelLogEnabled(kind: ModelLogKind): boolean {
  return logFiles[kind] !== null;
}

export function modelLog(kind: ModelLogKind, render: () => string): void {
  const path = logFiles[kind];
  if (!path) return;
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
