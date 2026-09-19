import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  ANY_INTERFACE_HOST,
  LOOPBACK_HOST,
  PANEL_LAUNCH_ENV,
  adminEntryFor,
  buildAdminSpec,
  buildLaunchSpec,
  parseListeningLine,
  parseMigratedLine,
  serverEntryFor,
} from "../src/main/launch.js";
import type { AppPaths } from "../src/main/paths.js";

const paths: AppPaths = {
  root: "/Users/someone/Library/Application Support/ilearnassist",
  configDir: "/Users/someone/Library/Application Support/ilearnassist/config",
  configFile: "/Users/someone/Library/Application Support/ilearnassist/config/config.yaml",
  overlayFile:
    "/Users/someone/Library/Application Support/ilearnassist/config/config.local.yaml",
  defaultDataDir: "/Users/someone/ilearnassist",
  webDir: "/Applications/ilearnassist.app/Contents/Resources/web",
  templateConfig: "/Applications/ilearnassist.app/Contents/Resources/config/config.yaml",
};

/**
 * Deliberately *not* under `paths.root`, because that is the arrangement this change exists
 * to make possible: the app's tree is the app's, and the user's data is wherever they put it.
 */
const DATA_DIR = "/Users/someone/Documents/my-notes";

describe("parseListeningLine", () => {
  it("extracts the address the server bound", () => {
    expect(parseListeningLine("[ilearnassist] listening on http://127.0.0.1:50896")).toBe(
      "http://127.0.0.1:50896"
    );
  });

  it("tolerates the carriage return a piped stream can leave behind", () => {
    expect(parseListeningLine("[ilearnassist] listening on http://127.0.0.1:3720\r")).toBe(
      "http://127.0.0.1:3720"
    );
  });

  it("ignores Fastify's own listening banner", () => {
    // The logger prints this from inside `listen`, before the process is necessarily ready
    // to serve. Keying on it would let a half-started server look running.
    expect(parseListeningLine('{"level":30,"msg":"Server listening at http://127.0.0.1:3720"}')).toBe(
      null
    );
  });

  it("ignores unrelated output", () => {
    expect(parseListeningLine("seeded 2 providers")).toBe(null);
    expect(parseListeningLine("")).toBe(null);
    // The prefix alone is not a claim that anything is listening.
    expect(parseListeningLine("[ilearnassist] starting")).toBe(null);
  });
});

describe("buildLaunchSpec", () => {
  const build = (host: string) =>
    buildLaunchSpec({
      electronExecPath: "/Applications/ilearnassist.app/Contents/MacOS/ilearnassist",
      serverEntry: "/Applications/ilearnassist.app/Contents/Resources/app/dist/server/index.mjs",
      paths,
      dataDir: DATA_DIR,
      host,
      baseEnv: { PATH: "/usr/bin" },
    });

  const spec = build(LOOPBACK_HOST);

  /** The other child the panel spawns: one-shot, and the one `reset-admin` runs in. */
  const adminSpec = buildAdminSpec({
    electronExecPath: "/Applications/ilearnassist.app/Contents/MacOS/ilearnassist",
    adminEntry: adminEntryFor("/Applications/ilearnassist.app/Contents/Resources/app"),
    paths,
    dataDir: DATA_DIR,
    args: ["reset-admin", "--json"],
    baseEnv: { PATH: "/usr/bin" },
  });

  it("runs the Electron binary as a plain Node process", () => {
    // There is no Node on a user's machine, so the child has to be the runtime we are
    // already running. Losing this makes every packaged launch fail with ENOENT.
    expect(spec.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(spec.command).toContain("ilearnassist");
    expect(spec.args).toHaveLength(1);
  });

  it("points the server at the per-user tree rather than the bundle", () => {
    // Without these the server resolves its project root from its own file location, which
    // inside an app bundle is read-only — the first write to the database would fail.
    expect(spec.env["ILA_PROJECT_ROOT"]).toBe(paths.root);
    expect(spec.env["ILA_CONFIG_PATH"]).toBe(paths.overlayFile);
    expect(spec.env["ILA_WEB_DIR"]).toBe(paths.webDir);
  });

  it("tells both children which launcher they have, so their wording names the right fix", () => {
    // Not a secret, and it grants nothing: it decides whether a refusal to start without an
    // administrator says "the button is in the control panel" or "run this command". A packed
    // launch and a checkout need different sentences, and this is how the server knows which
    // one it is looking at.
    expect(spec.env[PANEL_LAUNCH_ENV]).toBe("1");
    // The CLI gets it too — `reset-admin` runs as that child, and it is the one that reports
    // "there is nothing here to recover" to a panel rather than to a terminal.
    expect(adminSpec.env[PANEL_LAUNCH_ENV]).toBe("1");
  });

  it("points the server at the chosen data root, which is the user's and not the app's", () => {
    // The server refuses to start without this, by design — so a launch spec that dropped it
    // would be a panel that can never get past "starting". It is passed on every launch
    // rather than written into a config file, which is what lets the folder picker change it
    // without anything on disk being rewritten.
    expect(spec.env["ILA_DATA_DIR"]).toBe(DATA_DIR);
    expect(spec.env["ILA_DATA_DIR"]).not.toBe(paths.root);
  });

  it("keeps the ambient environment", () => {
    expect(spec.env["PATH"]).toBe("/usr/bin");
  });

  it("always states the bind address, including on the loopback default", () => {
    // Stating it even when it matches the config file is the point: leaving the loopback
    // case to the file would let a hand-edited `server.host` there put the server on the
    // network while the panel's switch still read "off".
    expect(build(LOOPBACK_HOST).env["ILA_HOST"]).toBe("127.0.0.1");
    expect(build(ANY_INTERFACE_HOST).env["ILA_HOST"]).toBe("0.0.0.0");
  });
});

describe("serverEntryFor", () => {
  it("points inside the app's own dist, where the bundle is built to", () => {
    expect(serverEntryFor("/app")).toBe(join("/app", "dist", "server", "index.mjs"));
  });
});

/**
 * The second line the panel reads off the server's stdout.
 *
 * It exists so a user can be told their database was upgraded and where the copy from before it
 * is. The failure modes worth pinning are the two that would make the panel lie: matching a line
 * that is not a migration, and claiming a backup path when the deployment opted out of taking one.
 */
describe("parseMigratedLine", () => {
  it("reads the versions and the backup", () => {
    expect(
      parseMigratedLine(
        "[ilearnassist] migrated schema v5 -> v6 (backup: /data/backups/ilearnassist-v5-20260919-092740.sqlite)"
      )
    ).toEqual({
      from: 5,
      to: 6,
      backup: "/data/backups/ilearnassist-v5-20260919-092740.sqlite",
    });
  });

  it("reports no backup rather than inventing a path", () => {
    // `ILA_SKIP_MIGRATION_BACKUP=1` is a deployment's own choice, and the panel says which of the
    // two happened — pointing at a file that is not there is worse than saying none was taken.
    expect(parseMigratedLine("[ilearnassist] migrated schema v5 -> v6 (no backup was taken)")).toEqual({
      from: 5,
      to: 6,
      backup: null,
    });
  });

  it("ignores every other line, including the listening one", () => {
    // The two patterns must not overlap: a listening line read as a migration would put a note on
    // screen about something that did not happen.
    expect(parseMigratedLine("[ilearnassist] listening on http://127.0.0.1:50896")).toBeNull();
    expect(parseMigratedLine("Server listening at http://0.0.0.0:3720")).toBeNull();
    expect(parseMigratedLine("[ilearnassist] migrated schema v5 -> 6 (backup: x)")).toBeNull();
    expect(parseMigratedLine("")).toBeNull();
  });

  it("handles a path that contains spaces", () => {
    // A data root is a folder the user chose, and "My Documents" is an ordinary name for one.
    expect(
      parseMigratedLine("[ilearnassist] migrated schema v4 -> v5 (backup: /Users/me/My Documents/b.sqlite)")
    ).toEqual({ from: 4, to: 5, backup: "/Users/me/My Documents/b.sqlite" });
  });
});
