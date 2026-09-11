import { spawn, type ChildProcess } from "node:child_process";
import type { ServerFault, ServerState, ServerStatus } from "../shared/panelApi.js";
import { parseListeningLine, type LaunchSpec } from "./launch.js";

/**
 * Supervises the backend: start it, watch it come up, stop it, and be honest when it dies.
 *
 * The state machine is the point of this module. A control panel's worst failure is not a
 * server that will not start — it is a panel that says "Running" when it is not, because
 * then the user's only recourse is to guess. So `running` is entered on exactly one
 * condition (the server printed that it is listening) and left on exactly one (its process
 * exited). There is no optimistic "it should be up by now".
 *
 * `spec` is injected rather than built here so the class can be driven against a plain
 * `node` script in tests, with no Electron and no real server.
 */

export interface ServerProcessOptions {
  /** How long to wait for the listening line before calling the start a failure. */
  startTimeoutMs?: number;
  /** How long SIGTERM gets before SIGKILL. */
  stopTimeoutMs?: number;
  /** Cap on retained output. The panel shows diagnostics, not a transcript. */
  maxLogLines?: number;
  /** Shown in the status so the user can find their database and workspaces. */
  dataDir: string;
  /** Emission coalescing for pure log lines; see `#emitLogsSoon`. */
  logFlushMs?: number;
}

const DEFAULTS = {
  // Generous: a first launch creates the database and seeds providers before it binds, and
  // a cold start from a mounted .dmg is slower still. A wrong "it failed" is worse than a
  // slow one.
  startTimeoutMs: 30_000,
  stopTimeoutMs: 8_000,
  maxLogLines: 200,
  logFlushMs: 250,
};

export class ServerProcess {
  readonly #spec: LaunchSpec;
  readonly #options: Required<Omit<ServerProcessOptions, "dataDir">> & { dataDir: string };

  #child: ChildProcess | null = null;
  #state: ServerState = "stopped";
  #url: string | null = null;
  #fault: ServerFault | null = null;
  #logs: string[] = [];

  /** Partial line from the last chunk; a chunk boundary is not a line boundary. */
  #pending = "";
  #startTimer: ReturnType<typeof setTimeout> | null = null;
  #logTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set between a user-requested stop and the process actually exiting. */
  #stopping = false;
  #listeners = new Set<(status: ServerStatus) => void>();

  constructor(spec: LaunchSpec, options: ServerProcessOptions) {
    this.#spec = spec;
    this.#options = { ...DEFAULTS, ...options };
  }

  /** A snapshot. Callers never hold a reference into this object's mutable state. */
  status(): ServerStatus {
    return {
      state: this.#state,
      url: this.#url,
      fault: this.#fault,
      dataDir: this.#options.dataDir,
      logs: [...this.#logs],
    };
  }

  subscribe(listener: (status: ServerStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Start the server. Resolves as soon as the process is spawned — *not* when it is up.
   *
   * Waiting would mean the IPC call blocks for as long as a cold start takes, with the
   * panel frozen and showing nothing. The renderer gets `starting` back and the transition
   * to `running` (or `failed`) arrives through `subscribe`, which is also what it needs for
   * a crash that happens ten minutes later.
   */
  async start(): Promise<ServerStatus> {
    if (this.#state === "starting" || this.#state === "running") return this.status();

    this.#stopping = false;
    this.#url = null;
    this.#fault = null;
    this.#logs = [];
    this.#pending = "";
    this.#state = "starting";
    this.#emit();

    let child: ChildProcess;
    try {
      child = spawn(this.#spec.command, this.#spec.args, {
        env: this.#spec.env,
        // No stdin: a server that tried to prompt would hang forever, and nothing in the
        // protocol here is interactive.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      // `spawn` throws synchronously only for a malformed call; a missing binary arrives
      // as an "error" event. Both are handled so neither becomes an unhandled rejection.
      this.#fail({ code: "spawn_failed", message: messageOf(err) });
      return this.status();
    }

    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#ingest(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.#ingest(chunk));

    child.on("error", (err) => {
      this.#fail({ code: "spawn_failed", message: err.message });
    });
    child.on("exit", (code, signal) => {
      this.#onExit(code, signal);
    });

    this.#startTimer = setTimeout(() => {
      if (this.#state !== "starting") return;
      this.#fail({ code: "timeout", seconds: Math.round(this.#options.startTimeoutMs / 1000) });
      // The process is alive but not serving; leaving it running would hold the port and
      // make the next "Start" a confusing no-op.
      this.#terminate();
    }, this.#options.startTimeoutMs);

    return this.status();
  }

  /**
   * Stop the server, politely, with a deadline.
   *
   * SIGTERM and not SIGKILL, because the server turns it into `app.close()`: that drains
   * in-flight requests, lets a running document parse settle and closes the sqlite
   * connection. Killing outright risks a half-written WAL. SIGKILL is only the backstop for
   * a process that will not take the hint.
   */
  async stop(): Promise<ServerStatus> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.#child = null;
      this.#clearStartTimer();
      this.#setState("stopped");
      this.#url = null;
      this.#emit();
      return this.status();
    }

    this.#stopping = true;
    this.#setState("stopping");

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      // A server wedged in a synchronous sqlite write never reaches its signal handler.
      child.kill("SIGKILL");
    }, this.#options.stopTimeoutMs);

    await exited;
    clearTimeout(deadline);

    this.#stopping = false;
    this.#child = null;
    this.#url = null;
    this.#clearStartTimer();
    this.#setState("stopped");
    return this.status();
  }

  /**
   * Last resort for process exit, where nothing can be awaited.
   *
   * `app.on("before-quit")` normally runs `stop()` and gives the server its grace period.
   * This covers the paths that do not go through it — a crash, a forced quit — because a
   * server left behind would keep the port and, worse, look to the user like the app is
   * still running.
   */
  killSync(): void {
    this.#child?.kill("SIGKILL");
    this.#child = null;
  }

  /**
   * Ask the process to go away without touching the reported state.
   *
   * Used by the start-timeout path, which has already recorded the failure. Routing that
   * through `stop()` would set `stopping` and then `stopped`, erasing the reason at exactly
   * the moment the user needs to read it.
   */
  #terminate(): void {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), this.#options.stopTimeoutMs);
    child.once("exit", () => clearTimeout(deadline));
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#clearStartTimer();
    this.#child = null;

    if (this.#stopping) {
      this.#stopping = false;
      this.#url = null;
      // A stop that follows a declared failure keeps the failure on screen; see #terminate.
      if (this.#state !== "failed") this.#setState("stopped");
      return;
    }

    // A failure already has a better explanation than "it exited". Node emits `error`
    // *and* `exit` for some spawn failures, and the second one would replace "no such
    // file" with a bare exit code.
    if (this.#state === "failed") return;

    // Not requested by us, so it is a crash whatever the exit code says: a server that
    // exited cleanly is still a server the panel must not claim is running.
    this.#url = null;
    this.#fail({ code: "exited", exitCode: code, signal });
  }

  #ingest(chunk: string): void {
    this.#pending += chunk;
    const lines = this.#pending.split("\n");
    // The tail is an incomplete line until the next chunk proves otherwise.
    this.#pending = lines.pop() ?? "";
    for (const line of lines) this.#line(line);
  }

  #line(raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;

    this.#logs.push(line);
    const overflow = this.#logs.length - this.#options.maxLogLines;
    if (overflow > 0) this.#logs.splice(0, overflow);

    const url = parseListeningLine(line);
    if (url && this.#state === "starting") {
      this.#clearStartTimer();
      this.#url = url;
      this.#state = "running";
      this.#emit();
      return;
    }

    this.#emitLogsSoon();
  }

  #fail(fault: ServerFault): void {
    this.#clearStartTimer();
    this.#fault = fault;
    this.#url = null;
    this.#state = "failed";
    this.#emit();
  }

  #setState(state: ServerState): void {
    this.#state = state;
    this.#emit();
  }

  #clearStartTimer(): void {
    if (this.#startTimer) {
      clearTimeout(this.#startTimer);
      this.#startTimer = null;
    }
  }

  #emit(): void {
    const snapshot = this.status();
    for (const listener of this.#listeners) listener(snapshot);
  }

  /**
   * Coalesce log-only updates.
   *
   * Fastify logs every request, so an active chat would otherwise push a status object
   * across the IPC boundary several times a second for a pane that is usually collapsed.
   * State changes bypass this entirely — those must never be late.
   */
  #emitLogsSoon(): void {
    if (this.#logTimer) return;
    this.#logTimer = setTimeout(() => {
      this.#logTimer = null;
      this.#emit();
    }, this.#options.logFlushMs);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
