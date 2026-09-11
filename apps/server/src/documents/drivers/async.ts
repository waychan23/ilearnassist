import { ParseError } from "../errors.js";
import type { DriverTuning } from "./types.js";

/**
 * The submit → poll → fetch loop every async vendor shares.
 *
 * Only the loop is shared, not the wire format. The vendors genuinely differ in how a job
 * is submitted (presigned `PUT` versus multipart) and how the result is shaped (a ZIP to
 * download versus Markdown inline in the poll response), so each driver keeps its own
 * request shaping and hands the loop a single question: *is it done yet?*
 */

/** A cancellable sleep — an abort must interrupt the wait, not just the next request. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ParseError("cancelled", "Parsing was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ParseError("cancelled", "Parsing was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollStep<T> {
  /** `undefined` while the job is still running. */
  value?: T;
  /** Set when the job reported a terminal failure. */
  error?: ParseError;
}

/**
 * Poll `attempt` until it yields a value, fails, or the job budget runs out.
 *
 * The first attempt fires immediately: a small document can already be finished by the
 * time the submit call returns, and waiting a full interval to notice would add seconds
 * to every parse.
 */
export async function pollUntil<T>(
  attempt: (attemptNumber: number) => Promise<PollStep<T>>,
  tuning: DriverTuning,
  signal: AbortSignal
): Promise<T> {
  const deadline = Date.now() + tuning.jobTimeoutMs;
  let attemptNumber = 0;

  for (;;) {
    if (signal.aborted) throw new ParseError("cancelled", "Parsing was cancelled.");
    attemptNumber += 1;

    const step = await attempt(attemptNumber);
    if (step.error) throw step.error;
    if (step.value !== undefined) return step.value;

    if (Date.now() >= deadline) {
      throw new ParseError(
        "timeout",
        `Parsing did not finish within ${Math.round(tuning.jobTimeoutMs / 1000)}s.`
      );
    }
    await sleep(tuning.pollIntervalMs, signal);
  }
}
