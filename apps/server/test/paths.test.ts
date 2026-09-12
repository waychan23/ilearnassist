import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dataLayout,
  ensureUserLayout,
  sessionDir,
  userLayout,
  workspaceSessionsDir,
  workspaceWorkdir,
} from "../src/paths.js";

/**
 * The layout is derived, never stored, so these are the tests that keep the one description
 * of it honest. Nothing here needs a server: `paths.ts` is deliberately free of both the
 * database and the config, which is what lets it be the shared vocabulary for the rest.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ila-paths-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("dataLayout", () => {
  it("puts users and the database under the chosen root", () => {
    const layout = dataLayout("/data");
    expect(layout).toEqual({
      dataRoot: "/data",
      usersRoot: join("/data", "users"),
      sqliteDir: join("/data", "db", "sqlite"),
      sqliteFile: join("/data", "db", "sqlite", "ilearnassist.sqlite"),
    });
  });

  it("keeps the database in a directory of its own, so the next one is a sibling", () => {
    // `db/<engine>/` rather than `db.sqlite` at the root: a second engine, or a second file
    // for the same one, is then an addition rather than a naming argument.
    const layout = dataLayout("/data");
    expect(layout.sqliteFile.startsWith(layout.sqliteDir + "/")).toBe(true);
  });

  it("resolves a relative root against the working directory, and does not normalise it away", () => {
    // `dataLayout` is a pure function of what it is handed; `resolveDataRoot` is what turns
    // a relative ILA_DATA_DIR into an absolute one. Keeping that split is why this can be
    // tested without an environment.
    expect(dataLayout("./data").dataRoot).toBe("./data");
    expect(dataLayout(resolve("./data")).dataRoot).toBe(resolve(resolve("./data")));
  });
});

describe("userLayout", () => {
  it("derives one user's whole tree from their slug", () => {
    const layout = userLayout(dataLayout("/data"), "ada");
    expect(layout.userRoot).toBe(join("/data", "users", "ada"));
    expect(layout.workspacesRoot).toBe(join("/data", "users", "ada", "workspaces"));
    expect(layout.sourcesRoot).toBe(join("/data", "users", "ada", "sources"));
    expect(layout.rawDir).toBe(join("/data", "users", "ada", "sources", "raw"));
    expect(layout.parsedDir).toBe(join("/data", "users", "ada", "sources", "parsed"));
  });

  it("gives two users disjoint trees", () => {
    // The property the whole layout exists for: one user's workspaces root is never inside
    // another's, so no relative path from either can reach the other's files.
    const root = dataLayout("/data");
    const ada = userLayout(root, "ada");
    const bob = userLayout(root, "bob");
    expect(ada.workspacesRoot.startsWith(bob.userRoot)).toBe(false);
    expect(bob.userRoot.startsWith(ada.userRoot)).toBe(false);
  });
});

describe("ensureUserLayout", () => {
  it("creates every directory, including missing parents", () => {
    const layout = userLayout(dataLayout(join(root, "deep", "nested")), "ada");
    ensureUserLayout(layout);

    for (const dir of [layout.workspacesRoot, layout.rawDir, layout.parsedDir]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("is idempotent, so a boot that follows a boot is not an error", () => {
    const layout = userLayout(dataLayout(root), "ada");
    ensureUserLayout(layout);
    expect(() => ensureUserLayout(layout)).not.toThrow();
  });

  it("does not create the user's root as a side effect of anything else", () => {
    // Worth pinning: `userRoot` exists only because the directories under it do. Nothing
    // writes into it directly, and a test that asserted otherwise would be asserting a
    // layout detail rather than a requirement.
    const layout = userLayout(dataLayout(root), "ada");
    ensureUserLayout(layout);
    expect(existsSync(layout.userRoot)).toBe(true);
  });
});

describe("workspace directory helpers", () => {
  it("puts the sandbox and the sessions directory inside the workspace", () => {
    const workspaceRoot = join(root, "workspaces", "flink");
    expect(workspaceWorkdir(workspaceRoot)).toBe(join(workspaceRoot, "workdir"));
    expect(workspaceSessionsDir(workspaceRoot)).toBe(join(workspaceRoot, "sessions"));
  });

  it("names a session's directory by its id, never by anything a user typed", () => {
    const workspaceRoot = join(root, "workspaces", "flink");
    expect(sessionDir(workspaceRoot, "s-123")).toBe(join(workspaceRoot, "sessions", "s-123"));
  });

  it("keeps the sandbox and the sessions directory as siblings, not nested", () => {
    // The reason `dir_path` stores the workspace root rather than the sandbox: deleting a
    // workspace has to take both, and `removeWorkspaceDir` only removes a direct child of
    // the workspaces root. Nested, one of them would survive the delete.
    const workspaceRoot = join(root, "workspaces", "flink");
    const workdir = workspaceWorkdir(workspaceRoot);
    const sessions = workspaceSessionsDir(workspaceRoot);
    expect(workdir.startsWith(sessions)).toBe(false);
    expect(sessions.startsWith(workdir)).toBe(false);
    expect(join(workdir, "..")).toBe(workspaceRoot);
    expect(join(sessions, "..")).toBe(workspaceRoot);
  });
});
