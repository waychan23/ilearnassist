import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import { createSseWriter } from "../src/stream.js";

/**
 * A stand-in for `reply.raw` that records what the writer puts on the wire.
 *
 * `destroyed` and `writableEnded` are settable so a test can reproduce a client that has
 * gone away — the state a stopped turn's response outlives — and `listeners` records the
 * `error` handler `createSseWriter` registers, so the test can prove it is there and that
 * it swallows rather than rethrows.
 */
function fakeReply() {
  const state = {
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    destroyed: false,
    listeners: {} as Record<string, ((err?: unknown) => void)[]>,
  };
  const raw = {
    get writableEnded() {
      return state.ended;
    },
    get destroyed() {
      return state.destroyed;
    },
    writeHead(_status: number, headers: Record<string, string>) {
      state.headers = headers;
    },
    flushHeaders() {
      /* present so the optional call in createSseWriter resolves */
    },
    on(event: string, listener: (err?: unknown) => void) {
      (state.listeners[event] ??= []).push(listener);
    },
    write(chunk: string) {
      state.chunks.push(chunk);
      return true;
    },
    end() {
      state.ended = true;
    },
  };
  return { reply: { raw } as unknown as FastifyReply, state };
}

describe("createSseWriter", () => {
  it("announces an event stream with buffering disabled", () => {
    const { reply, state } = fakeReply();
    createSseWriter(reply);

    expect(state.headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(state.headers["Cache-Control"]).toBe("no-cache, no-transform");
    expect(state.headers["X-Accel-Buffering"]).toBe("no");
  });

  it("frames each event as `event:` + `data:` + a blank line", () => {
    const { reply, state } = fakeReply();
    createSseWriter(reply).send({ type: "text", delta: "hi" });

    expect(state.chunks).toEqual(['event: text\ndata: {"type":"text","delta":"hi"}\n\n']);
  });

  it("serializes JSON that contains newlines without breaking the frame", () => {
    const { reply, state } = fakeReply();
    createSseWriter(reply).send({ type: "text", delta: "line one\nline two" });

    const frame = state.chunks[0]!;
    expect(frame.split("\n\n")).toHaveLength(2); // exactly one framing terminator
    expect(JSON.parse(frame.slice(frame.indexOf("data:") + 5).trim())).toEqual({
      type: "text",
      delta: "line one\nline two",
    });
  });

  it("emits every event type the chat route uses", () => {
    const { reply, state } = fakeReply();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: "s1" });
    sse.send({ type: "done" });

    expect(state.chunks.map((c) => c.split("\n")[0])).toEqual(["event: meta", "event: done"]);
  });

  it("ignores writes after end()", () => {
    const { reply, state } = fakeReply();
    const sse = createSseWriter(reply);
    sse.end();
    sse.send({ type: "text", delta: "too late" });

    expect(state.chunks).toEqual([]);
  });

  it("ends the response only once when end() is called twice", () => {
    const { reply, state } = fakeReply();
    const sse = createSseWriter(reply);
    sse.end();
    sse.end();
    expect(state.ended).toBe(true);
  });

  /*
   * The two guards a stopped turn depends on. A stop leaves the response writing for a
   * moment after the client that asked for it has gone, and Node reports that on the
   * response — so a write into a dead socket must go quiet rather than throw, and the
   * `error` it emits must have a listener.
   */
  it("goes quiet once the response has been torn down, rather than writing into it", () => {
    const { reply, state } = fakeReply();
    const sse = createSseWriter(reply);
    state.destroyed = true;

    expect(() => sse.send({ type: "text", delta: "nobody is reading" })).not.toThrow();
    expect(state.chunks).toEqual([]);
  });

  it("goes quiet once the response has ended from the other end", () => {
    const { reply, state } = fakeReply();
    const sse = createSseWriter(reply);
    // Not through `sse.end()`: this is the socket closing underneath the writer.
    state.ended = true;

    sse.send({ type: "done" });
    expect(state.chunks).toEqual([]);
  });

  it("listens for transport errors so a dead socket is not an uncaught exception", () => {
    const { reply, state } = fakeReply();
    createSseWriter(reply);

    const handlers = state.listeners["error"] ?? [];
    expect(handlers).toHaveLength(1);
    expect(() => handlers[0]!()).not.toThrow();
  });
});
