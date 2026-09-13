import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The command-line contract, proved by running it.
 *
 * Everything about *what* the command decides is in `adminCli.test.ts`, driven in-process. What
 * is left here is the part only a real child can show: which stream an envelope goes to, what
 * the exit code is, that stdin is closed rather than waited on, and — the one that cannot be
 * faked — that two processes racing produce one administrator rather than two.
 *
 * Run under `tsx` because that is how the package runs it in development; the packaged app
 * runs the bundled `dist/server/cli.mjs` through Electron instead, which is the same file with
 * a different loader.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ila-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI as a real process.
 *
 * Stdin is **always** closed, even with nothing to write. A child that decided to prompt
 * because its stdin was an open pipe would hang until the panel's timeout, and the failure
 * would look like the command being slow rather than like a missing flag.
 */
function runCli(args: string[], stdin = ""): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ILA_DATA_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const parse = (text: string): Record<string, unknown> => JSON.parse(text.trim()) as Record<string, unknown>;

describe("the command line", () => {
  it(
    "answers `status` on a folder with no database, and says so on stdout",
    async () => {
      const run = await runCli(["status", "--json"]);

      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      expect(parse(run.stdout)).toMatchObject({ ok: true, database: "absent", hasAdmin: false });
    },
    30_000
  );

  it(
    "creates an administrator and prints the invented password exactly once",
    async () => {
      const run = await runCli(["create-admin", "--username", "ada", "--generate", "--json"]);

      expect(run.code).toBe(0);
      const envelope = parse(run.stdout);
      expect(envelope).toMatchObject({ ok: true, created: true, generated: true, username: "ada" });
      // One line of JSON on stdout and nothing else, so the panel can parse the stream whole.
      expect(run.stdout.trim().split("\n")).toHaveLength(1);
    },
    30_000
  );

  it(
    "takes a typed password on stdin without ever echoing it",
    async () => {
      // The control panel's path. The password must not appear on either stream: stdout is
      // parsed as JSON, and stderr is what the panel renders as a message.
      const secret = "typed-by-the-operator";
      const run = await runCli(
        ["create-admin", "--username", "ada", "--password-stdin", "--json"],
        `${secret}\n`
      );

      expect(run.code).toBe(0);
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
      expect(parse(run.stdout)).toMatchObject({ ok: true, generated: false });
      expect(parse(run.stdout)).not.toHaveProperty("password");
    },
    30_000
  );

  it(
    "refuses a coded failure on stderr with exit 1",
    async () => {
      await runCli(["create-admin", "--username", "ada", "--generate", "--json"]);
      const second = await runCli([
        "create-admin",
        "--username",
        "mallory",
        "--generate",
        "--json",
      ]);

      expect(second.code).toBe(1);
      expect(second.stdout).toBe("");
      expect((parse(second.stderr).error as { code: string }).code).toBe("ADMIN_EXISTS");
    },
    30_000
  );

  it(
    "refuses a malformed command with exit 2, naming both ways to give a password",
    async () => {
      const run = await runCli(["create-admin", "--username", "ada", "--json"]);

      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--password-stdin");
      expect(run.stderr).toContain("--generate");
    },
    30_000
  );

  it(
    "makes exactly one administrator when two of them run at once",
    async () => {
      /*
       * The property the transaction exists for, and the only place it can be shown: two
       * *processes*, each of which spends ~100ms in `scrypt` before it looks at the database.
       * A check-then-write pair would let both through, and the second administrator is one
       * nobody at the machine chose — on an installation whose owner has no reason to look for
       * it. `BEGIN IMMEDIATE` takes the write lock before either reads.
       */
      const [a, b] = await Promise.all([
        runCli(["create-admin", "--username", "ada", "--generate", "--json"]),
        runCli(["create-admin", "--username", "mallory", "--generate", "--json"]),
      ]);

      const codes = [a, b].map((run) => run.code).sort((x, y) => (x ?? -1) - (y ?? -1));
      expect(codes).toEqual([0, 1]);

      const status = parse((await runCli(["status", "--json"])).stdout);
      expect(status).toMatchObject({ hasAdmin: true });
      // Named, so the loser's refusal was about *this* administrator rather than a coincidence.
      const loser = a.code === 0 ? b : a;
      expect((parse(loser.stderr).error as { code: string }).code).toBe("ADMIN_EXISTS");
    },
    60_000
  );
});
