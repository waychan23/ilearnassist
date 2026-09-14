import { adminEntryFor, buildAdminSpec, type LaunchSpec } from "./launch.js";
import { runOneShot, type OneShotResult } from "./oneShot.js";
import type {
  AdminFault,
  AdminStatus,
  AdminStatusResult,
  CreateAdministratorResult,
  ResetResult,
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
interface CliResetEnvelope {
  ok: true;
  command: "reset-admin";
  username: string;
  /** Present only when the CLI invented the password (`--generate`); the panel never does. */
  password?: string;
}
interface CliErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    params?: Record<string, string | number>;
  };
}
type CliEnvelope = CliStatusEnvelope | CliCreateEnvelope | CliResetEnvelope | CliErrorEnvelope;

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

/**
 * Whether a Start should spawn the server, given what the CLI said about the data root.
 *
 * A named rule rather than an `if (hasAdmin)` at the two call sites, and the reason is a bug
 * that made **Start do nothing at all** once an administrator existed: the panel stored the
 * question's negation and both callers read it as the question, so the button only ever worked
 * on a data root where the server would then refuse to listen. A predicate cannot be inverted
 * by accident the way a boolean variable's meaning can.
 *
 * Three inputs, two answers, and the asymmetry is deliberate:
 *
 * - `true` — there is an administrator, so start the server.
 * - `false` — there is definitely none, and the server refuses to listen without one. Do not
 *   spawn a process whose only outcome is "failed: exited 1". The panel is already drawing the
 *   create card in this state, so the press is answered by the card rather than by nothing.
 * - `undefined` — the question could not be answered: no data root, an unreadable database, a
 *   CLI that would not run. **Start anyway.** The server's own boot gate is the backstop and
 *   says so in one sentence on stderr, which is a better outcome than a button that silently
 *   does nothing when the check it depends on is the thing that is broken.
 */
export function mayStartServer(hasAdmin: boolean | undefined): boolean {
  return hasAdmin !== false;
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
  return runOneShot(spec, {
    stdin,
    // A reset hashes a password too, so it is on the same budget as a create; `status` does no
    // `scrypt` at all and is given a tighter one.
    timeoutMs: args[0] === "status" ? STATUS_TIMEOUT_MS : CREATE_TIMEOUT_MS,
  });
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
  if (envelope.command !== "create-admin" && envelope.command !== "ensure-admin") {
    return { ok: false, fault: { code: "bad_response", message: "unexpected CLI reply" } };
  }
  if (!envelope.created) {
    // `create-admin` never answers "nothing to do"; that is `ensure-admin`. So an uncreated
    // reply here is a mismatch worth refusing rather than reporting success.
    return { ok: false, fault: { code: "bad_response", message: "the administrator was not created" } };
  }
  return { ok: true, username: envelope.username };
}

/**
 * Replace a superadmin's password with the one the operator chose.
 *
 * A one-shot child rather than a request to the server, and that is what makes the button work
 * in **every** state rather than only while the server happens to be up. It used to be an HTTP
 * route guarded by a per-launch secret, which meant the one control that exists for "I cannot
 * sign in" also required a healthy running server — and a forgotten password is often found in
 * the same moment as something else being wrong. The CLI writes the row itself, exactly as
 * `create-admin` does, so there is one implementation of the reset and no secret to hold.
 *
 * The operator **chooses** the password, exactly as when creating the first administrator: the
 * person at this machine is assumed to be the superadmin, so handing them a random one and
 * forcing a change on login would contradict what the create flow assumes. It rides stdin —
 * never an argv string, which the process table would show — and it is not echoed back in the
 * result, logged, broadcast, or written to `desktop.json`.
 */
export async function resetAdministratorPassword(
  ctx: AdminContext,
  input: { password: string }
): Promise<ResetResult> {
  if (!ctx.dataDir) return { ok: false, fault: { code: "no_data_dir" } };

  const result = await runCli(
    ctx,
    ["reset-admin", "--json", "--password-stdin"],
    `${input.password}\n`
  );

  // Both streams, like the two commands above: a refusal is written to stderr even though the
  // envelope goes to stdout on success.
  const envelope = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
  if (!envelope) return { ok: false, fault: spawnFault(result) };
  if (!envelope.ok) return { ok: false, fault: envelopeFault(envelope) };
  if (envelope.command !== "reset-admin") {
    return { ok: false, fault: { code: "bad_response", message: "unexpected CLI reply" } };
  }
  return { ok: true, username: envelope.username };
}

const STATUS_TIMEOUT_MS = 10_000;
const CREATE_TIMEOUT_MS = 20_000;
