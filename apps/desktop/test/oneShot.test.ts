import { describe, expect, it } from "vitest";
import type { LaunchSpec } from "../src/main/launch.js";
import { runOneShot } from "../src/main/oneShot.js";

/**
 * The run-and-exit helper, against real children.
 *
 * Everything worth asserting here is about the process boundary the administrator CLI crosses:
 * stdout and stderr come back separately, stdin is handed in and closed, a child that never
 * finishes is killed rather than awaited forever, and a binary that cannot be spawned is a
 * result rather than a rejected promise. `process.execPath` stands in for the Electron binary,
 * exactly as `serverProcess.test.ts` does.
 */

function fixture(script: string, args: string[] = []): LaunchSpec {
  return { command: process.execPath, args: ["-e", script, ...args], env: {} };
}

describe("runOneShot", () => {
  it("returns exit code and the two streams separately", async () => {
    const result = await runOneShot(
      fixture('console.log("out"); console.error("err"); process.exit(0);')
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.timedOut).toBe(false);
  });

  it("hands stdin to the child and closes it, so a reader reaches EOF", async () => {
    // The CLI reads a password from stdin and resolves on the newline/EOF; a child that
    // waited for an open pipe would hang until the timeout instead.
    const result = await runOneShot(
      fixture('let d=""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => { process.stdout.write(d); });'),
      { stdin: "the-password\n" }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("the-password\n");
  });

  it("passes a nonzero exit code through rather than throwing", async () => {
    const result = await runOneShot(fixture("process.exit(3);"));
    expect(result.code).toBe(3);
  });

  it("kills a child that does not finish and reports the timeout", async () => {
    // One second rather than the 20s default: the assertion is that the deadline fires at all.
    const result = await runOneShot(fixture("setInterval(() => {}, 1000);"), { timeoutMs: 500 });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  }, 5_000);

  it("reports a binary that cannot be executed as a result", async () => {
    const spec: LaunchSpec = { command: "/nonexistent/definitely-not-here", args: [], env: {} };
    const result = await runOneShot(spec);

    expect(result.code).not.toBe(0);
  });
});
