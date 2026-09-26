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
  /**
   * Answer this request with an HTTP error instead of a stream.
   *
   * The caller is the thinking-mode passback rule: a provider refuses a request whose `messages`
   * carry an assistant tool-call message without `reasoning_content`, and the app is expected to
   * recover by echoing the field. Only a *refusal* can test that, and no other turn shape
   * produces one.
   */
  fail?: { status: number; message: string };
}

/**
 * How the fake server tells the out-of-band calls apart from the conversation's own turns: one
 * phrase from each call's system prompt. `setMatches` is consulted for these requests only —
 * see the guard at its use site for why that matters.
 *
 * The coupling to prompt text is deliberate and pre-existing (`CLASSIFIER_MARKER` was the same
 * idea with one entry): a marker is the only thing in the body that says *which* call this is,
 * and a prompt phrase is stable in a way a request shape is not.
 */
const OUT_OF_BAND_MARKERS = [
  "topic-classification function", // threads.ts — thread.system
  "reflective study coach", // insights.ts — insight.system
  /*
   * `agent/title.ts` — TITLE_SYSTEM_PROMPT. In the list because a spec needs to make the titler
   * **fail**, and there is no other body-borne way to say so: the sticky `title` cannot be set to
   * something unusable, because `/__script` ignores an empty one (`if (body.title)`) and a
   * whitespace one would be indistinguishable from a title nobody scripted.
   *
   * A marker is not a behaviour change on its own: without a matching `includes` the lookup
   * returns nothing and the sticky title answers, which is what every existing case relies on.
   */
  "titling function",
];

/**
 * A body-keyed reply for non-streaming requests. First entry whose `includes` substring is
 * found in the raw request body wins; without a hit the plain `title` reply is used. This is
 * what lets one fake server answer several different out-of-band calls in one turn — the
 * auto-titler, the thread classifier and the insight pass.
 */
export interface FakeNonStreamingMatch {
  includes: string;
  content: string;
}

export interface FakeLlmOptions {
  port?: number;
  /**
   * Enforce DeepSeek's thinking-mode rule: refuse a request whose assistant tool-call messages do
   * not carry a **non-empty** `reasoning_content`, with the sentence the provider uses.
   *
   * A fake that accepts anything cannot fail the way the real provider does, so a spec about this
   * rule could only assert what the app *meant* to send. Enforcing it here makes the assertion the
   * provider's own answer instead — and the `""`-versus-missing distinction was learned exactly
   * this way, from a live refusal the app's own belief said could not happen.
   */
  requireReasoning?: boolean;
  /** Reply used for non-streaming requests (the auto-titler). */
  title?: string;
  /** Body-keyed replies for non-streaming requests, checked before `title`. */
  matches?: FakeNonStreamingMatch[];
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
  /** Replace the body-keyed non-streaming replies. */
  setMatches(matches: FakeNonStreamingMatch[]): void;
  /** Bodies of every `/chat/completions` request received, oldest first. */
  requests(): Record<string, unknown>[];
  /**
   * The subset of `requests()` that was answered with an HTTP error.
   *
   * The same objects, by identity, so a caller can skip them: a test about what a *provider*
   * accepts has to exclude the request the provider refused — that one is the subject, not the
   * evidence.
   */
  refusedRequests(): Record<string, unknown>[];
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

/**
 * The messages that break the thinking-mode rule: **any** assistant message whose
 * `reasoning_content` is missing or blank. See `FakeLlmOptions.requireReasoning`.
 *
 * Not only the ones carrying tool calls, which is the documented reading and the wrong one. It was
 * established against the real endpoint by capturing a refused request and bisecting it: removing
 * every assistant message *without* the field made it pass, removing only the tool-call ones did
 * not, and adding the field to those messages turned the same request into a 200. A fake that
 * checked only the tool-call messages would agree with a rewrite that had the same blind spot —
 * which is exactly how the bug survived two fixes.
 */
function reasoningOffences(body: Record<string, unknown>): Record<string, unknown>[] {
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  return (messages as Record<string, unknown>[]).filter((message) => {
    if (!message || message.role !== "assistant") return false;
    return String(message.reasoning_content ?? "").trim() === "";
  });
}

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
  let matches: FakeNonStreamingMatch[] = options.matches ?? [];
  const requireReasoning = options.requireReasoning === true;
  const seen: Record<string, unknown>[] = [];
  /** The same objects as in `seen`, for the requests a scripted `fail` answered with an error. */
  const refused: Record<string, unknown>[] = [];
  /** Streaming requests disconnected before their turn finished writing. */
  let aborted = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const url = req.url ?? "";

      // Control plane — lets the e2e drive a server it does not share a process with.
      if (url.startsWith("/__script")) {
        try {
          const body = JSON.parse(raw || "{}") as {
            turns?: FakeTurn[];
            title?: string;
            matches?: FakeNonStreamingMatch[];
          };
          if (body.turns) queue = [...body.turns];
          if (body.title) title = body.title;
          if (body.matches) matches = body.matches;
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
        matches = [];
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

      if (requireReasoning && reasoningOffences(body).length > 0) {
        // The provider's own words, so a test can key on the sentence rather than on a paraphrase.
        // Recorded as refused for the same reason a scripted `fail` is: it is the request the
        // provider rejected, which is the subject of such a test rather than its evidence.
        refused.push(body);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "The `reasoning_content` in the thinking mode must be passed back to the API.",
            },
          })
        );
        return;
      }

      /*
       * Body-keyed matches are for the OUT-OF-BAND calls only, and a call is recognised by a
       * phrase in its own system prompt. The guard is the point: without it a needle would be
       * consulted for the main agent turn too, so a test's `includes` would silently become the
       * model's reply to the user.
       *
       * A body can carry an earlier turn's material (the classifier's recent-tail), so take the
       * LAST matching needle rather than the first — the current call's, not the previous one's.
       */
      const isOutOfBand = OUT_OF_BAND_MARKERS.some((marker) => raw.includes(marker));
      const classifierHit = isOutOfBand
        ? [...matches].reverse().find((m) => raw.includes(m.includes))
        : undefined;

      if (body.stream !== true) {
        // The titler (non-streaming) always gets the sticky title; a classifier answer only
        // goes to a classifier request.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(nonStreamingBody(classifierHit ? classifierHit.content : title)));
        return;
      }

      // A matched streamed reply consumes nothing from the agent-turn queue.
      const turn = classifierHit ? { content: classifierHit.content } : (queue.shift() ?? DEFAULT_TURN);
      if (turn.fail) {
        // Refused before any frame: the status and the body are the whole point, and a client
        // that recovers has to see them as a provider error rather than as a broken stream.
        refused.push(body);
        res.writeHead(turn.fail.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: turn.fail.message, type: "invalid_request_error" } }));
        return;
      }
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
    setMatches(next) {
      matches = next;
    },
    requests() {
      return seen;
    },
    refusedRequests() {
      return refused;
    },
    abortedRequests() {
      return aborted;
    },
    reset() {
      queue = [];
      seen.length = 0;
      refused.length = 0;
      aborted = 0;
      matches = [];
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
  /*
   * `--require-reasoning` makes the browser suite enforce the thinking-mode rule too, which is where
   * the reported bug actually lives: the whole point of the flag is that a flow which sends a blank
   * `reasoning_content` fails loudly in a real browser instead of only in a unit test.
   */
  const requireReasoning =
    process.argv.includes("--require-reasoning") ||
    process.env.FAKE_LLM_REQUIRE_REASONING === "1";
  const llm = await startFakeLlm({ port, requireReasoning });
  console.log(`fake LLM listening on ${llm.baseURL}${requireReasoning ? " (reasoning enforced)" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
