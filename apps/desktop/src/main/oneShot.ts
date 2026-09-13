import { spawn, type ChildProcess } from "node:child_process";
import type { LaunchSpec } from "./launch.js";

/**
 * Run a command that is expected to finish, and collect what it said.
 *
 * This is the missing companion to `ServerProcess`: that one supervises a child that is
 * supposed to live and keys on a printed line, this one waits for exit and returns a result.
 * The administrator CLI is why it exists — the panel has to create the first administrator
 * with the long-lived server deliberately stopped, so there is no process to supervise, only a
 * job to run.
 *
 * Its output is collected **here and nowhere else**. It never feeds `ServerStatus.logs`, which
 * is rendered in the panel's disclosure: with `--generate` the child's stdout *is a password*,
 * and a password in the log buffer is a password the panel keeps showing after the result has
 * been dismissed.
 */
export interface OneShotResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True when the process was still running at the deadline and was killed. */
  timedOut: boolean;
}

export interface OneShotOptions {
  /** Written to stdin and then closed. The child must never be left waiting on an open pipe. */
  stdin?: string;
  /** How long to wait before killing it. `scrypt` is ~100ms, so this is a generous backstop. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function runOneShot(spec: LaunchSpec, options: OneShotOptions = {}): Promise<OneShotResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        env: spec.env,
        // stdin is a pipe so the password can be handed in on it; stdout and stderr are
        // collected separately because the envelope goes on one and human sentences on the
        // other, and the caller has to know which it parsed.
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      // `spawn` throws synchronously only on a malformed call. Reported as an immediate
      // non-zero result rather than rejected, so the caller has one shape to map.
      resolve({
        code: -1,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // Always close stdin, even with nothing to write. The CLI reads a password from it when
    // asked, and decides *not to prompt* only once the pipe reaches EOF — an open pipe would
    // hang until the timeout on a command that had nothing to say.
    child.stdin?.end(options.stdin ?? "");

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on("error", (error) => {
      // ENOENT arrives here rather than at the throw above — a half-upgraded bundle whose CLI
      // entry is missing, for instance.
      clearTimeout(timer);
      stderr += (stderr ? "\n" : "") + error.message;
      resolve({ code: -1, signal: null, stdout, stderr, timedOut });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}
