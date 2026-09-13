import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppPaths } from "../src/main/paths.js";
import {
  createFirstAdministrator,
  queryAdministrator,
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
