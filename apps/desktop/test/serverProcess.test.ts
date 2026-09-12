import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchSpec } from "../src/main/launch.js";
import { ServerProcess } from "../src/main/serverProcess.js";

/**
 * The state machine, driven against real child processes.
 *
 * The fixtures are one-liners run by this machine's own Node rather than mocks, because
 * everything worth testing here *is* the process boundary: that a line split across two
 * `data` chunks is still recognised, that SIGTERM actually reaches the child, that an exit
 * nobody asked for is reported as a failure. A fake `ChildProcess` would assert that the
 * code calls the methods it visibly calls and nothing more.
 *
 * `process.execPath` stands in for the Electron binary; the panel passes `process.execPath`
 * too, only with `ELECTRON_RUN_AS_NODE` set. Nothing about this class depends on which it is.
 */

const live: ServerProcess[] = [];

afterEach(() => {
  // A test that fails mid-start must not leave a fixture running and hold the suite open.
  for (const process of live.splice(0)) process.killSync();
});

function fixture(script: string): LaunchSpec {
  return { command: process.execPath, args: ["-e", script], env: {} };
}

function start(
  spec: LaunchSpec | (() => LaunchSpec),
  options: Partial<ConstructorParameters<typeof ServerProcess>[1]> = {}
) {
  const instance = new ServerProcess(spec, { dataDir: "/tmp/data", logFlushMs: 10, ...options });
  live.push(instance);
  return instance;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const LISTENING = "http://127.0.0.1:41234";
const HEARTBEAT_LINE = `[ilearnassist] listening on ${LISTENING}`;

describe("ServerProcess — coming up", () => {
  it("reports running, with the address the server printed", async () => {
    const server = start(
      fixture(`console.log("seeding providers"); console.log(${JSON.stringify(HEARTBEAT_LINE)}); setInterval(() => {}, 1000);`)
    );

    await server.start();
    await waitFor(() => server.status().state === "running");

    const status = server.status();
    expect(status.url).toBe(LISTENING);
    expect(status.fault).toBe(null);
    // Diagnostics for a failed start are not much use without the lines around it.
    expect(status.logs).toContain("seeding providers");

    await server.stop();
    expect(server.status().state).toBe("stopped");
  });

  it("recognises the line when the stream splits it in half", async () => {
    // Node's stdout chunking is arbitrary — a `data` event can land mid-line. Treating the
    // first chunk as a whole line would leave the panel stuck on "starting" forever.
    const server = start(
      fixture(
        `process.stdout.write("[ilearnassist] listen");` +
          `setTimeout(() => { process.stdout.write("ing on ${LISTENING}\\n"); setInterval(() => {}, 1000); }, 60);`
      )
    );

    await server.start();
    await waitFor(() => server.status().state === "running");
    expect(server.status().url).toBe(LISTENING);
  });

  it("is a no-op when it is already running", async () => {
    const server = start(fixture(`console.log(${JSON.stringify(HEARTBEAT_LINE)}); setInterval(() => {}, 1000);`));
    await server.start();
    await waitFor(() => server.status().state === "running");

    const first = server.status();
    await server.start();

    expect(server.status().url).toBe(first.url);
    expect(server.status().state).toBe("running");
  });
});

describe("ServerProcess — failing to come up", () => {
  it("reports a crash before the server ever listened", async () => {
    const server = start(fixture(`console.error("No providers configured."); process.exit(3);`));

    await server.start();
    await waitFor(() => server.status().state === "failed");

    const status = server.status();
    expect(status.fault).toEqual({ code: "exited", exitCode: 3, signal: null });
    expect(status.url).toBe(null);
    // The server's own last words are the only clue a user can be shown.
    expect(status.logs.join("\n")).toContain("No providers configured.");
  });

  it("reports a binary that cannot be executed", async () => {
    const server = start({ command: "/nonexistent/definitely-not-here", args: [], env: {} });

    await server.start();
    await waitFor(() => server.status().state === "failed");

    expect(server.status().fault?.code).toBe("spawn_failed");
  });

  it("gives up on a server that starts but never reports itself ready", async () => {
    // The wedged-but-alive case: a process that holds the port and answers nothing. It has
    // to be declared failed *and* killed, or the next Start would silently do nothing.
    const dir = mkdtempSync(join(tmpdir(), "gl-desktop-wedged-"));
    const heartbeat = join(dir, "heartbeat");
    try {
      const server = start(
        fixture(`require("node:fs").writeFileSync(${JSON.stringify(heartbeat)}, "1"); setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(heartbeat)}, "x"), 50);`),
        { startTimeoutMs: 300, stopTimeoutMs: 300 }
      );

      await server.start();
      await waitFor(() => server.status().state === "failed");

      expect(server.status().fault).toEqual({ code: "timeout", seconds: 0 });

      // Proof the process is actually gone, rather than merely written off: a live one
      // would keep appending.
      const settled = statSync(heartbeat).size;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(statSync(heartbeat).size).toBe(settled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the reason a start failed after the process is reaped", async () => {
    // `#terminate` kills the wedged child. If the exit it causes were treated as a normal
    // stop, the panel would flip to "stopped" and lose the explanation it just showed.
    const server = start(fixture(`setInterval(() => {}, 1000);`), {
      startTimeoutMs: 200,
      stopTimeoutMs: 200,
    });

    await server.start();
    await waitFor(() => server.status().state === "failed");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(server.status().state).toBe("failed");
    expect(server.status().fault?.code).toBe("timeout");
  });
});

describe("ServerProcess — stopping and restarting", () => {
  it("stops the process, not just the bookkeeping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-desktop-stop-"));
    const heartbeat = join(dir, "heartbeat");
    try {
      const server = start(
        fixture(`console.log(${JSON.stringify(HEARTBEAT_LINE)}); setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(heartbeat)}, "x"), 50);`)
      );
      await server.start();
      await waitFor(() => server.status().state === "running");
      // The fixture writes on an interval, so give it one beat before measuring: stopping
      // first would make "the heartbeat stopped growing" true for the wrong reason.
      await waitFor(() => existsSync(heartbeat));

      await server.stop();

      const settled = statSync(heartbeat).size;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(statSync(heartbeat).size).toBe(settled);
      expect(server.status().state).toBe("stopped");
      expect(server.status().url).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops a server that never came up without claiming it is still running", async () => {
    const server = start(fixture(`setInterval(() => {}, 1000);`));
    await server.start();

    await server.stop();

    expect(server.status().state).toBe("stopped");
  });

  it("reads the launch spec at each start, so a setting can change between runs", async () => {
    // The panel's "open on your phone" switch changes the bind address, which the server
    // can only pick up from its environment at spawn. Reading the spec once would pin it to
    // whatever it was at launch, and the switch would appear to work while changing nothing.
    let url = "http://127.0.0.1:11111";
    const server = start(() => ({
      command: process.execPath,
      args: [
        "-e",
        `console.log("[ilearnassist] listening on " + process.env.TEST_URL); setInterval(() => {}, 1000);`,
      ],
      env: { TEST_URL: url },
    }));

    await server.start();
    await waitFor(() => server.status().state === "running");
    expect(server.status().url).toBe("http://127.0.0.1:11111");

    await server.stop();
    url = "http://192.168.1.42:22222";
    await server.start();
    await waitFor(() => server.status().url === "http://192.168.1.42:22222");
  });

  it("can start again after a stop", async () => {
    const server = start(fixture(`console.log(${JSON.stringify(HEARTBEAT_LINE)}); setInterval(() => {}, 1000);`));

    await server.start();
    await waitFor(() => server.status().state === "running");
    await server.stop();
    expect(server.status().state).toBe("stopped");

    await server.start();
    await waitFor(() => server.status().state === "running");
    expect(server.status().url).toBe(LISTENING);
  });

  it("treats a stop while stopped as a no-op rather than an error", async () => {
    const server = start(fixture(`setInterval(() => {}, 1000);`));
    await server.stop();
    expect(server.status().state).toBe("stopped");
  });
});

describe("ServerProcess — reporting", () => {
  it("caps retained output so a chatty server cannot grow the panel without bound", async () => {
    const server = start(
      fixture(
        `for (let i = 0; i < 40; i++) console.log("line " + i);` +
          `console.log(${JSON.stringify(HEARTBEAT_LINE)}); setInterval(() => {}, 1000);`
      ),
      { maxLogLines: 5 }
    );

    await server.start();
    await waitFor(() => server.status().state === "running");

    const { logs } = server.status();
    expect(logs).toHaveLength(5);
    // Newest kept, oldest dropped.
    expect(logs.at(-1)).toBe(HEARTBEAT_LINE);
  });

  it("only pushes log-only changes to subscribers once they settle", async () => {
    const server = start(
      fixture(
        `for (let i = 0; i < 30; i++) console.log("line " + i);` +
          `console.log(${JSON.stringify(HEARTBEAT_LINE)}); setInterval(() => {}, 1000);`
      ),
      { logFlushMs: 1_000 }
    );

    let emissions = 0;
    server.subscribe(() => {
      emissions += 1;
    });

    await server.start();
    await waitFor(() => server.status().state === "running");

    // `starting` on the way in, `running` on the way up, and at most one coalesced log
    // flush. Fastify logs every request, so without this a busy chat would push a full
    // status object across the IPC boundary several times a second.
    expect(emissions).toBeLessThanOrEqual(3);
  });

  it("hands out copies, so a subscriber cannot mutate the panel's view of the world", async () => {
    const server = start(fixture(`console.log("hello"); setInterval(() => {}, 1000);`));
    await server.start();

    const first = server.status();
    first.logs.push("not real");

    expect(server.status().logs).not.toContain("not real");
  });
});
