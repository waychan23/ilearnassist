import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildLaunchSpec, parseListeningLine, serverEntryFor } from "../src/main/launch.js";
import type { AppPaths } from "../src/main/paths.js";

const paths: AppPaths = {
  root: "/Users/someone/Library/Application Support/guided-learning",
  configDir: "/Users/someone/Library/Application Support/guided-learning/config",
  configFile: "/Users/someone/Library/Application Support/guided-learning/config/config.yaml",
  overlayFile:
    "/Users/someone/Library/Application Support/guided-learning/config/config.local.yaml",
  dataDir: "/Users/someone/Library/Application Support/guided-learning/data",
  webDir: "/Applications/guided-learning.app/Contents/Resources/web",
  templateConfig: "/Applications/guided-learning.app/Contents/Resources/config/config.yaml",
};

describe("parseListeningLine", () => {
  it("extracts the address the server bound", () => {
    expect(parseListeningLine("[guided-learning] listening on http://127.0.0.1:50896")).toBe(
      "http://127.0.0.1:50896"
    );
  });

  it("tolerates the carriage return a piped stream can leave behind", () => {
    expect(parseListeningLine("[guided-learning] listening on http://127.0.0.1:3720\r")).toBe(
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
    expect(parseListeningLine("[guided-learning] starting")).toBe(null);
  });
});

describe("buildLaunchSpec", () => {
  const spec = buildLaunchSpec({
    electronExecPath: "/Applications/guided-learning.app/Contents/MacOS/guided-learning",
    serverEntry: "/Applications/guided-learning.app/Contents/Resources/app/dist/server/index.mjs",
    paths,
    baseEnv: { PATH: "/usr/bin" },
  });

  it("runs the Electron binary as a plain Node process", () => {
    // There is no Node on a user's machine, so the child has to be the runtime we are
    // already running. Losing this makes every packaged launch fail with ENOENT.
    expect(spec.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(spec.command).toContain("guided-learning");
    expect(spec.args).toHaveLength(1);
  });

  it("points the server at the per-user tree rather than the bundle", () => {
    // Without these the server resolves its project root from its own file location, which
    // inside an app bundle is read-only — the first write to the database would fail.
    expect(spec.env["GL_PROJECT_ROOT"]).toBe(paths.root);
    expect(spec.env["GL_CONFIG_PATH"]).toBe(paths.overlayFile);
    expect(spec.env["GL_WEB_DIR"]).toBe(paths.webDir);
  });

  it("keeps the ambient environment", () => {
    expect(spec.env["PATH"]).toBe("/usr/bin");
  });
});

describe("serverEntryFor", () => {
  it("points inside the app's own dist, where the bundle is built to", () => {
    expect(serverEntryFor("/app")).toBe(join("/app", "dist", "server", "index.mjs"));
  });
});
