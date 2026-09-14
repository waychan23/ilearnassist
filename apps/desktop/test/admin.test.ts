import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppPaths } from "../src/main/paths.js";
import {
  createFirstAdministrator,
  mayStartServer,
  queryAdministrator,
  resetAdministratorPassword,
  type AdminContext,
} from "../src/main/admin.js";

/**
 * The main-process wrapper around the administrator CLI.
 *
 * It spawns `dist/server/cli.mjs`, which is not built for the unit suite — so each test stages
 * a tiny stand-in at exactly that path inside a throwaway app root. The real CLI's *rules* are
 * tested against the server package; what is asserted here is the boundary this module owns:
 * argv, stdin, the two output streams, exit codes, and the deadline.
 */

let appRoot: string;
let dataDir: string;
let paths: AppPaths;

beforeEach(() => {
  appRoot = mkdtempSync(join(tmpdir(), "ila-panel-admin-"));
  dataDir = join(appRoot, "data");
  mkdirSync(join(appRoot, "dist", "server"), { recursive: true });
  paths = {
    root: appRoot,
    configDir: join(appRoot, "config"),
    configFile: join(appRoot, "config", "config.yaml"),
    overlayFile: join(appRoot, "config", "config.local.yaml"),
    webDir: join(appRoot, "resources", "web"),
    suggestedDataDir: dataDir,
    templateConfig: join(appRoot, "resources", "config", "config.yaml"),
  };
});

afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<AdminContext> = {}): AdminContext {
  return {
    electronExecPath: process.execPath,
    appRoot,
    paths,
    dataDir,
    ...overrides,
  };
}

/** Stage a script that is the whole CLI for the duration of the test. */
function fakeCli(script: string): void {
  writeFileSync(join(appRoot, "dist", "server", "cli.mjs"), script);
}

describe("queryAdministrator", () => {
  it("parses a status envelope", async () => {
    fakeCli(
      'process.stdout.write(JSON.stringify({ ok: true, command: "status", hasAdmin: true, adminUsername: "Ada" }));'
    );
    const result = await queryAdministrator(ctx());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toEqual({ hasAdmin: true, adminUsername: "Ada" });
  });

  it("turns a refusal on stderr into the CLI's own code", async () => {
    fakeCli(
      'process.stderr.write(JSON.stringify({ ok: false, error: { code: "SCHEMA_UNREADABLE", message: "old", params: { found: 1, needed: 2 } } })); process.exit(1);'
    );
    const result = await queryAdministrator(ctx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("SCHEMA_UNREADABLE");
    expect(result.fault.params).toEqual({ found: 1, needed: 2 });
  });

  it("reports garbage as bad_response rather than guessing", async () => {
    fakeCli('process.stdout.write("not json at all");');
    const result = await queryAdministrator(ctx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("bad_response");
  });

  it("kills a child that never finishes and says so", async () => {
    fakeCli("setInterval(() => {}, 1000);");
    const result = await queryAdministrator(ctx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("timed_out");
  }, 15_000);

  it("does not spawn anything without a data directory", async () => {
    const result = await queryAdministrator(ctx({ dataDir: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("no_data_dir");
  });
});

describe("createFirstAdministrator", () => {
  it("hands the password over stdin and reports the new username", async () => {
    // Asserts the security-relevant half: the password is on stdin, not argv (which the
    // process table would show), and the child is told --password-stdin.
    fakeCli(`
      const args = process.argv.slice(2);
      let input = "";
      process.stdin.on("data", (c) => (input += c));
      process.stdin.on("end", () => {
        const wantsStdin = args.includes("--password-stdin");
        const inArgv = args.some((a) => a.includes("secret"));
        process.stdout.write(
          JSON.stringify({
            ok: wantsStdin && !inArgv && input === "secret\\n",
            command: "create-admin",
            created: true,
            username: "Ada",
          })
        );
      });
    `);
    const result = await createFirstAdministrator(ctx(), { username: "Ada", password: "secret" });

    expect(result).toEqual({ ok: true, username: "Ada" });
  });

  it("surfaces a short-password refusal with its code", async () => {
    fakeCli(
      'process.stderr.write(JSON.stringify({ ok: false, error: { code: "PASSWORD_TOO_SHORT", message: "too short", params: { min: 8 } } })); process.exit(1);'
    );
    const result = await createFirstAdministrator(ctx(), { username: "Ada", password: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("PASSWORD_TOO_SHORT");
  });
});

/**
 * The Start gate, which is where a bug made the button do nothing at all.
 *
 * The rule is one line and it is worth its own test precisely for that reason: it is a rule
 * *because* the obvious spelling of it — a boolean variable named `hasAdmin` that quietly held
 * the negation — shipped, and Start then worked only on the one data root where the server
 * would refuse to listen. Asserting the three inputs here is asserting the thing the panel
 * cannot see: which of them may spawn a process.
 */
describe("mayStartServer", () => {
  it("starts when the data root has an administrator", () => {
    expect(mayStartServer(true)).toBe(true);
  });

  it("refuses when the data root definitely has none", () => {
    // The server would exit 1 on its own boot gate, and the panel is already drawing the create
    // card for this state — so the press is answered by the card rather than by a failure.
    expect(mayStartServer(false)).toBe(false);
  });

  it("starts anyway when the question could not be answered", () => {
    // No data root, an unreadable database, a CLI that would not run. Trying is what keeps the
    // button from going silent when the check it depends on is the thing that is broken; the
    // server's own gate is the backstop, and it says so on stderr.
    expect(mayStartServer(undefined)).toBe(true);
  });
});

/**
 * The reset, which is the panel's way back into a locked account.
 *
 * A one-shot child now rather than a request to the running server, so the boundary asserted
 * here is the same one the two commands above have — argv, the envelope, both output streams —
 * with one claim of its own: it is asked with **no username**, because the panel does not know
 * any names and "the first enabled superadmin" is the account it means.
 */
describe("resetAdministratorPassword", () => {
  it("asks for the reset and hands back the password exactly once", async () => {
    fakeCli(
      'process.stdout.write(JSON.stringify({ ok: true, command: "reset-admin", dataRoot: "/data", username: "Ada", password: "abcd-efgh-ijkl-mnop" }));'
    );
    const result = await resetAdministratorPassword(ctx());

    expect(result).toEqual({ ok: true, username: "Ada", password: "abcd-efgh-ijkl-mnop" });
  });

  it("names the first enabled superadmin rather than a username of its own", async () => {
    // The panel has no name to send. If a username ever crept into these arguments it would be
    // one the panel invented, and a rename on the server would turn the button into a refusal.
    fakeCli(
      'const ok = process.argv.slice(2).join(" ") === "reset-admin --json";' +
        'process.stdout.write(JSON.stringify(ok ? { ok: true, command: "reset-admin", dataRoot: "/data", username: "Ada", password: "x" } : { ok: false, error: { code: "USAGE", message: "wrong argv" } }));'
    );
    expect((await resetAdministratorPassword(ctx())).ok).toBe(true);
  });

  it("refuses with no data folder before spawning anything", async () => {
    // Nothing to write into, and no child worth starting.
    const result = await resetAdministratorPassword(ctx({ dataDir: "" }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("no_data_dir");
  });

  it("surfaces the CLI's own refusal with its code", async () => {
    // A data folder nobody has set up, which the panel says in the same breath as offering to
    // make one.
    fakeCli(
      'process.stderr.write(JSON.stringify({ ok: false, error: { code: "ADMIN_NOT_FOUND", message: "nothing to reset" } })); process.exit(1);'
    );
    const result = await resetAdministratorPassword(ctx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("ADMIN_NOT_FOUND");
  });

  it("treats a reply that is not a reset as a bad response, not a success", async () => {
    // `reset-admin` is the only command that produces this value, so a create envelope coming
    // back means the bundle and this build disagree — and reading it as an empty password would
    // be the worst possible way to find that out.
    fakeCli(
      'process.stdout.write(JSON.stringify({ ok: true, command: "status", hasAdmin: true, adminUsername: "Ada" }));'
    );
    const result = await resetAdministratorPassword(ctx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fault");
    expect(result.fault.code).toBe("bad_response");
  });
});
