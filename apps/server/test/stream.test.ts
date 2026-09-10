import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import { createSseWriter } from "../src/stream.js";

/** A stand-in for `reply.raw` that records what the writer puts on the wire. */
function fakeReply() {
  const state = { headers: {} as Record<string, string>, chunks: [] as string[], ended: false };
  const raw = {
    writeHead(_status: number, headers: Record<string, string>) {
      state.headers = headers;
    },
    flushHeaders() {
      /* present so the optional call in createSseWriter resolves */
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
});
