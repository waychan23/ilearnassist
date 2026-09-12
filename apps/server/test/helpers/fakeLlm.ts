import http from "node:http";
import { pathToFileURL } from "node:url";

/**
 * A minimal, scriptable OpenAI-compatible chat server.
 *
 * The whole agent path — `buildModel` → LangChain's `ChatOpenAI` → `createReasoningFetch`
 * → `runAgentStream` → the SSE route — is driven by this instead of a real provider, so
 * the loop, the wire-tap and the streaming route are all exercised for real, with no API
 * key, no network and deterministic output.
 *
 * It can be used two ways:
 *   - in-process: `const llm = await startFakeLlm()` from a Vitest test
 *   - as a standalone process: `tsx test/helpers/fakeLlm.ts --port 3801`, controlled
 *     over HTTP via `POST /__script` (that is what the Playwright e2e uses)
 *
 * Protocol notes that are load-bearing (each one was verified against the installed
 * `@langchain/openai` 1.5.12):
 *   - The **first** delta of a stream must carry `role: "assistant"`. Without it LangChain
 *     builds a `ChatMessageChunk` instead of an `AIMessageChunk`, and tool calls are
 *     dropped silently — no error, the tools simply never run.
 *   - `Content-Type: text/event-stream` is required, not for the SDK but for
 *     `createReasoningFetch`, which leaves the response untouched unless it sees it.
 *   - `usage` arrives on its own frame with `choices: []`.
 *   - `model` ids must not look like a Responses-API model (`gpt-5*`, `codex`), or
 *     `ChatOpenAI` switches to `/responses` and never calls us.
 */

/** Which delta key carries chain-of-thought. Only `reasoning_content` is also mapped
 *  into `additional_kwargs` by LangChain — the other two are tap-only, which makes this
 *  a useful knob for the reasoning-duplication regression test. */
export type ReasoningKey = "reasoning_content" | "reasoning" | "reasoning_text";

export interface FakeToolCall {
  id?: string;
  name: string;
  /** Args as an object, or a pre-serialized JSON string. */
  args?: Record<string, unknown> | string;
}

/** One scripted assistant turn — what the model "replies" to a single request. */
export interface FakeTurn {
  reasoning?: string;
  reasoningKey?: ReasoningKey;
  content?: string;
  toolCalls?: FakeToolCall[];
  usage?: { input?: number; output?: number; cached?: number };
  /** Send no usage frame at all — exercises the "provider reported nothing" path. */
  omitUsage?: boolean;
  /**
   * Pause this many milliseconds after every frame, so the turn is still streaming while
   * a test acts. Without it a turn is written in one synchronous burst and there is no
   * moment at which anything can be interrupted.
   */
  holdMs?: number;
}

export interface FakeLlmOptions {
  port?: number;
  /** Reply used for non-streaming requests (the auto-titler). */
  title?: string;
}

export interface FakeLlm {
  readonly baseURL: string;
  readonly port: number;
  /** Append turns to the queue. One turn is consumed per streamed request. */
  script(turns: FakeTurn | FakeTurn[]): void;
  /** Replace the queue outright. */
  setTurns(turns: FakeTurn[]): void;
  /** Text returned for non-streaming requests (`generateTitle`). */
  setTitle(title: string): void;
  /** Bodies of every `/chat/completions` request received, oldest first. */
  requests(): Record<string, unknown>[];
  /**
   * How many streaming requests were disconnected before their turn finished writing —
   * i.e. how many times a caller really did cancel, rather than just stop reading.
   */
  abortedRequests(): number;
  /** Drop the queued turns and the request log, so one instance can serve many tests. */
  reset(): void;
  close(): Promise<void>;
}

/** Turns served once the queue is exhausted. Ends the agent loop with a plain reply. */
const DEFAULT_TURN: FakeTurn = { content: "ok" };

function parseArgs(args: FakeToolCall["args"]): string {
  if (typeof args === "string") return args;
  return JSON.stringify(args ?? {});
}

function chunkFrame(delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageFrame(u: { input?: number; output?: number; cached?: number }) {
  const input = u.input ?? 10;
  const output = u.output ?? 5;
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "fake-model",
    choices: [],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      ...(u.cached ? { prompt_tokens_details: { cached_tokens: u.cached } } : {}),
    },
  };
}

/** The frames for one streamed turn, in order. */
function turnFrames(turn: FakeTurn): unknown[] {
  const frames: unknown[] = [];

  // Role first: see the note at the top of this file — this is what makes LangChain
  // build an AIMessageChunk that can carry tool calls.
  const first: Record<string, unknown> = { role: "assistant" };
  if (turn.reasoning) first[turn.reasoningKey ?? "reasoning_content"] = turn.reasoning;
  if (!turn.toolCalls?.length && turn.content) first.content = turn.content;
  frames.push(chunkFrame(first, null));

  if (turn.toolCalls?.length) {
    // Preamble text before a tool call, as a separate frame.
    if (turn.content) frames.push(chunkFrame({ content: turn.content }, null));
    frames.push(
      chunkFrame(
        {
          tool_calls: turn.toolCalls.map((call, index) => ({
            index,
            id: call.id ?? `call_${index}`,
            type: "function",
            function: { name: call.name, arguments: parseArgs(call.args) },
          })),
        },
        null
      )
    );
    frames.push(chunkFrame({}, "tool_calls"));
  } else {
    frames.push(chunkFrame({}, "stop"));
  }

  if (!turn.omitUsage) frames.push(usageFrame(turn.usage ?? {}));
  return frames;
}

function nonStreamingBody(title: string) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "fake-model",
    // `message.role` must be "assistant" or the converter falls back to ChatMessage.
    choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFakeLlm(options: FakeLlmOptions = {}): Promise<FakeLlm> {
  let queue: FakeTurn[] = [];
  let title = options.title ?? "Fake Conversation Title";
  const seen: Record<string, unknown>[] = [];
  /** Streaming requests disconnected before their turn finished writing. */
  let aborted = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const url = req.url ?? "";

      // Control plane — lets the e2e drive a server it does not share a process with.
      if (url.startsWith("/__script")) {
        try {
          const body = JSON.parse(raw || "{}") as { turns?: FakeTurn[]; title?: string };
          if (body.turns) queue = [...body.turns];
          if (body.title) title = body.title;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid script" }));
        }
        return;
      }
      if (url.startsWith("/__requests")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(seen));
        return;
      }
      if (url === "/__state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ aborted }));
        return;
      }
      if (url === "/__reset") {
        queue = [];
        seen.length = 0;
        aborted = 0;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Anything else is assumed to be the chat completion endpoint. Matched by suffix so
      // a baseURL with or without a `/v1` prefix works either way.
      if (!url.includes("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `unexpected path ${url}` } }));
        return;
      }

      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
        return;
      }
      seen.push(body);

      if (body.stream !== true) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(nonStreamingBody(title)));
        return;
      }

      const turn = queue.shift() ?? DEFAULT_TURN;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // A client that hangs up mid-turn — the agent loop aborting its provider request —
      // closes the connection while frames are still being written. Recording that is the
      // only way a test can tell a real cancellation from a caller that merely stopped
      // reading, so it is tracked rather than ignored as a write error.
      let hungUp = false;
      let notHungUp: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        notHungUp = resolve;
      });
      res.on("close", () => {
        if (!res.writableEnded) {
          hungUp = true;
          aborted += 1;
        }
        notHungUp();
      });

      // Abandon the turn as soon as the client goes away. The socket is torn down rather
      // than merely left alone: an aborted request can strand a half-open connection, and
      // `close()` below would then sit on it until the keep-alive timeout.
      const bail = () => {
        if (!res.destroyed) res.destroy();
      };

      for (const frame of turnFrames(turn)) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (turn.holdMs) await Promise.race([sleep(turn.holdMs), closed]);
        if (hungUp) return bail();
      }
      if (turn.holdMs) await Promise.race([sleep(turn.holdMs), closed]);
      if (hungUp) return bail();
      res.write("data: [DONE]\n\n");
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    script(turns) {
      queue.push(...(Array.isArray(turns) ? turns : [turns]));
    },
    setTurns(turns) {
      queue = [...turns];
    },
    setTitle(next) {
      title = next;
    },
    requests() {
      return seen;
    },
    abortedRequests() {
      return aborted;
    },
    reset() {
      queue = [];
      seen.length = 0;
      aborted = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Destroy whatever is still parked, in flight or not. A turn that was stopped
        // leaves the client's socket stranded rather than cleanly closed, and `close()`
        // would otherwise wait it out — seconds, for a run that is already over.
        server.closeAllConnections();
      });
    },
  };
}

/** `tsx test/helpers/fakeLlm.ts --port 3801` — used by the Playwright webServer. */
async function main(): Promise<void> {
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : Number(process.env.FAKE_LLM_PORT ?? 3801);
  const llm = await startFakeLlm({ port });
  console.log(`fake LLM listening on ${llm.baseURL}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
