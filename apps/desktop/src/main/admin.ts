import { adminEntryFor, buildAdminSpec, type LaunchSpec } from "./launch.js";
import { runOneShot, type OneShotResult } from "./oneShot.js";
import type {
  AdminFault,
  AdminStatus,
  AdminStatusResult,
  CreateAdministratorResult,
} from "../shared/panelApi.js";

/**
 * The control panel's conversation with the administrator CLI.
 *
 * Everything here is *spawning*, not policy: the rules live in `apps/server/src/adminCli.ts`,
 * which the terminal runs directly and this process runs as a one-shot child. That split is
 * what lets the panel create an administrator with the long-lived server deliberately stopped —
 * there is no port to ask, so it asks the same code the command line does, as a process.
 *
 * The boundary this module owns is turning an exit code and two text streams into the typed
 * results `PanelApi` promises. A password is handed in on stdin (never an argv string, which
 * would show in the process table), and it is **not** echoed into the result or any log —
 * only the username comes back.
 */

/** What the CLI actually prints on success. Read structurally; this process does not own it. */
interface CliStatusEnvelope {
  ok: true;
  command: "status";
  hasAdmin: boolean;
  adminUsername: string | null;
}
interface CliCreateEnvelope {
  ok: true;
  command: "create-admin" | "ensure-admin";
  created: boolean;
  username: string;
}
interface CliErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    params?: Record<string, string | number>;
  };
}
type CliEnvelope = CliStatusEnvelope | CliCreateEnvelope | CliErrorEnvelope;

/** Parse one JSON object off a stream, or null if there is not exactly that to read. */
function parseEnvelope(text: string): CliEnvelope | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ok" in parsed &&
      typeof (parsed as { ok: unknown }).ok === "boolean"
    ) {
      const envelope = parsed as CliEnvelope;
      // A refusal is only an envelope when it carries the error. The real CLI always does;
      // a bare `{ ok: false }` is not a code anyone can render, so it is treated the same as
      // a sentence or a stack trace — a bad response, not a crash reading `.error.code`.
      if (!envelope.ok && (!("error" in envelope) || typeof (envelope as CliErrorEnvelope).error?.code !== "string")) {
        return null;
      }
      return envelope;
    }
  } catch {
    // A stack trace or a sentence is not an envelope.
  }
  return null;
}

/** Turn "the child did not answer" into the boundary fault that says which way. */
function spawnFault(result: OneShotResult): AdminFault {
  if (result.timedOut) return { code: "timed_out" };
  if (result.code === -1 || result.code === 127) {
    return { code: "spawn_failed", message: result.stderr || "the CLI could not be started" };
  }
  return { code: "bad_response", message: result.stderr || result.stdout || "no output" };
}

/** A refusal the CLI produced, with its code intact so the renderer can translate it. */
function envelopeFault(envelope: CliErrorEnvelope): AdminFault {
  return {
    // The CLI's codes are a subset of `AdminFault["code"]`; the cast is the boundary where
    // a string off the wire becomes a value this type system knows.
    code: envelope.error.code as AdminFault["code"],
    message: envelope.error.message,
    params: envelope.error.params,
  };
}

export interface AdminContext {
  electronExecPath: string;
  /** The packed app's root — `app.getAppPath()`. */
  appRoot: string;
  paths: Parameters<typeof buildAdminSpec>[0]["paths"];
  dataDir: string;
}

function runCli(
  ctx: AdminContext,
  args: string[],
  stdin?: string
): Promise<OneShotResult> {
  const spec: LaunchSpec = buildAdminSpec({
    electronExecPath: ctx.electronExecPath,
    adminEntry: adminEntryFor(ctx.appRoot),
    paths: ctx.paths,
    dataDir: ctx.dataDir,
    args,
  });
  return runOneShot(spec, { stdin, timeoutMs: args[0] === "status" ? STATUS_TIMEOUT_MS : CREATE_TIMEOUT_MS });
}

export async function queryAdministrator(ctx: AdminContext): Promise<AdminStatusResult> {
  if (!ctx.dataDir) return { ok: false, fault: { code: "no_data_dir" } };

  const result = await runCli(ctx, ["status", "--json"]);

  // Failures are written to stderr even for status (SCHEMA_UNREADABLE, NOT_A_DATABASE), so a
  // refusal there has to be read the same way as create's.
  const envelope = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
  if (!envelope) return { ok: false, fault: spawnFault(result) };
  if (!envelope.ok) return { ok: false, fault: envelopeFault(envelope) };
  if (envelope.command !== "status") {
    return { ok: false, fault: { code: "bad_response", message: "unexpected CLI reply" } };
  }

  const status: AdminStatus = {
    hasAdmin: envelope.hasAdmin,
    adminUsername: envelope.adminUsername,
  };
  return { ok: true, status };
}

export async function createFirstAdministrator(
  ctx: AdminContext,
  input: { username: string; password: string }
): Promise<CreateAdministratorResult> {
  if (!ctx.dataDir) return { ok: false, fault: { code: "no_data_dir" } };

  const result = await runCli(
    ctx,
    ["create-admin", "--json", "--username", input.username, "--password-stdin"],
    `${input.password}\n`
  );

  // Failures are printed on stderr, successes on stdout — check both, so a refusal is read
  // even though it did not come back on the stream success uses.
  const envelope = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
  if (!envelope) return { ok: false, fault: spawnFault(result) };
  if (!envelope.ok) return { ok: false, fault: envelopeFault(envelope) };
  if (envelope.command === "status" || !envelope.created) {
    // `create-admin` never answers "nothing to do"; that is `ensure-admin`. So an uncreated
    // reply here is a mismatch worth refusing rather than reporting success.
    return { ok: false, fault: { code: "bad_response", message: "the administrator was not created" } };
  }
  return { ok: true, username: envelope.username };
}

const STATUS_TIMEOUT_MS = 10_000;
const CREATE_TIMEOUT_MS = 20_000;
