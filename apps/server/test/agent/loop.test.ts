import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  PLAN_PROGRESS_TOOL_NAME,
  QUIZ_REVIEW_TOOL_NAME,
  TABLE_TOOL_NAME,
  type Attachment,
  type ChatStreamEvent,
  type Message,
  type FileLocation,
  type ModelCapability,
  type SessionSettings,
} from "@ilearnassist/shared";
import type { TurnClock } from "../../src/agent/clock.js";
import { runAgentStream } from "../../src/agent/loop.js";
import { dataLayout, userLayout } from "../../src/paths.js";
import { buildAskUserTool } from "../../src/tools/askUser.js";
import { buildDiagramTool } from "../../src/tools/diagram.js";
import { buildQuizTool } from "../../src/tools/quiz.js";
import { fileToolsFor } from "../helpers/fileTools.js";
import type { ProviderRecord } from "../../src/db.js";
import { startFakeLlm, type FakeLlm, type FakeTurn } from "../helpers/fakeLlm.js";

/**
 * Drives the real agent loop against a scripted OpenAI-compatible server, so the
 * LangChain path, the reasoning wire-tap and the ReAct stepping are all exercised
 * for real — only the model is fake.
 */

let llm: FakeLlm;
let scratch: string;
/**
 * The workspace's sandbox — `scratch/ws/workdir`, the shape a real `Workspace` describes.
 *
 * Tests that exercise the file tools pass *this*, not `scratch`, because it is what the
 * agent is actually sandboxed to; using the parent would make a passing test that proves
 * the tools work somewhere they never run.
 */
let workdir: string;

beforeAll(async () => {
  llm = await startFakeLlm();
});

afterAll(async () => {
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  scratch = mkdtempSync(join(tmpdir(), "gl-loop-"));
  workdir = join(scratch, "ws", "workdir");
  mkdirSync(workdir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function provider(capabilities: ModelCapability[] = [], baseURL = llm.baseURL): ProviderRecord {
  return {
    id: "fake",
    name: "Fake",
    baseURL,
    apiKey: "test-key",
    models: [{ id: "r1", modelId: "fake-model", name: "fake-model", capabilities }],
  };
}

interface RunOptions {
  turns: FakeTurn[];
  tools?: StructuredToolInterface[];
  /** The conversation's own persona; empty (the default) uses the built-in assistant text. */
  systemPrompt?: string;
  settings?: SessionSettings;
  history?: Message[];
  /** `null` is a resume: a suspended turn carries on with no new user message. */
  userMessage?: string | null;
  attachments?: Attachment[];
  vision?: boolean;
  toolUse?: boolean;
  /** Declared capabilities of the model record — `reasoning` gates the replay below. */
  capabilities?: ModelCapability[];
  /** Where an unqualified write goes, as `turnContext` would have resolved it. */
  writeLocation?: FileLocation;
  /** Aborts the turn; see `RunAgentInput.signal`. */
  signal?: AbortSignal;
  /** Overridden to point the provider at something that cannot answer. */
  baseURL?: string;
  /** The turn's clock. Fixed by default so a prompt assertion does not depend on today. */
  clock?: TurnClock;
}

/**
 * A clock no test has to think about, and one they can still assert on.
 *
 * Fixed rather than `new Date()`: the prompt states the date, so a test reading the system
 * message back would otherwise be asserting on whatever day the suite happens to run.
 */
const TEST_CLOCK: TurnClock = {
  local: "Wednesday, 2026-09-16 14:32",
  zone: "Asia/Shanghai, UTC+08:00",
};

async function run(options: RunOptions) {
  llm.setTurns(options.turns);
  const events: ChatStreamEvent[] = [];
  const result = await runAgentStream({
    provider: provider(options.capabilities ?? [], options.baseURL),
    modelId: "fake-model",
    workspace: {
      id: "w1",
      name: "W",
      slug: "w",
      dirPath: join(scratch, "ws"),
      workdirPath: workdir,
      description: "",
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      lastActivityAt: null,
    },
    // The session's own prompt, as the routes now pass it — the loop never sees a Copilot.
    systemPrompt: options.systemPrompt ?? "",
    settings: options.settings ?? {},
    clock: options.clock ?? TEST_CLOCK,
    // The whole user tree, not just the sources directory: `buildUserContent` derives a
    // source's path from the layout, so it needs the root it belongs to.
    user: userLayout(dataLayout(scratch), "tester"),
    sessionId: "s1",
    sessionDirPath: join(scratch, "ws", "sessions", "s1"),
    writeLocation: options.writeLocation ?? "session",
    vision: options.vision ?? false,
    toolUse: options.toolUse ?? false,
    history: options.history ?? [],
    userMessage: options.userMessage === undefined ? "hello" : options.userMessage,
    attachments: options.attachments ?? [],
    tools: options.tools ?? [],
    signal: options.signal,
    onEvent: (event) => events.push(event),
  });
  return { events, result };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(overrides: Partial<Message> & Pick<Message, "role" | "content">): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("runAgentStream — plain conversation", () => {
  it("streams text deltas and reports the final content", async () => {
    const { events, result } = await run({ turns: [{ content: "Hello world" }] });

    expect(result.content).toBe("Hello world");
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual([
      "Hello world",
    ]);
    expect(result.toolCalls).toEqual([]);
  });

  it("reports usage from the step's chunks, summing input and output", async () => {
    const { result, events } = await run({
      turns: [{ content: "hi", usage: { input: 100, output: 20, cached: 30 } }],
    });

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 30,
      // The provider in this turn reports no reasoning tokens, so this is `0` rather than absent:
      // the loop always fills every figure it knows how to read, the same way it does for
      // `cachedInputTokens`. See `MessageUsage.reasoningTokens`.
      reasoningTokens: 0,
      contextTokens: 120,
    });
    expect(events.at(-1)).toEqual({ type: "usage", usage: result.usage });
  });

  it("reports an empty usage object and no event when the provider says nothing", async () => {
    // Callers distinguish "not reported" from "reported zero", so the object must come
    // back empty rather than zero-filled — and no `usage` event should be emitted.
    const { events, result } = await run({ turns: [{ content: "hi", omitUsage: true }] });

    expect(result.usage).toEqual({});
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });

  it("states the current date, time and zone to the model on every turn", async () => {
    /*
     * Without this the model answers "what is today" from the most recent date in its training
     * data — confidently, and with nothing in the reply to say it is wrong. So the date is
     * *given*, unconditionally: not only on turns that mention time, since the failure is a
     * model that does not know it should have looked.
     */
    await run({ turns: [{ content: "hi" }] });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    const system = String(sent.messages[0]!.content);
    expect(system).toContain(TEST_CLOCK.local);
    expect(system).toContain(TEST_CLOCK.zone);
  });

  it("states the turn's clock, not the process's", async () => {
    // The prompt is built per turn from what it is handed, which is what makes a conversation
    // left open overnight answer tomorrow's question with tomorrow's date.
    const later: TurnClock = {
      local: "Thursday, 2026-09-17 09:05",
      zone: "Asia/Shanghai, UTC+08:00",
    };
    await run({ turns: [{ content: "hi" }], clock: later });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    expect(String(sent.messages[0]!.content)).toContain(later.local);
  });

  it("puts the clock ahead of the folder note and behind the persona", async () => {
    /*
     * Order is not cosmetic here. The persona is what the conversation is; the clock is a fact
     * about the world the answer is written in; the folders are about where files go. A session
     * with its own persona must not have it displaced by either.
     */
    await run({ turns: [{ content: "hi" }], systemPrompt: "You are a terse tutor." });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    const system = String(sent.messages[0]!.content);
    expect(system.indexOf("You are a terse tutor.")).toBeLessThan(system.indexOf(TEST_CLOCK.local));
    expect(system.indexOf(TEST_CLOCK.local)).toBeLessThan(system.indexOf("Two folders are writable"));
  });
});

describe("runAgentStream — chain of thought", () => {
  /*
   * Regression tests for the reasoning-duplication bug.
   *
   * `@langchain/openai` 1.5.x maps `reasoning_content` into `additional_kwargs`, so two
   * independent paths can see the same delta: the raw-SSE tap in `createReasoningFetch`
   * and `chunkReasoning`'s former `additional_kwargs` branch. Reading both emitted every
   * delta twice and doubled the persisted `reasoning`.
   */

  it("emits each reasoning_content delta exactly once", async () => {
    const { events, result } = await run({
      turns: [{ reasoning: "思考A", content: "answer" }],
    });

    expect(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta)).toEqual([
      "思考A",
    ]);
    expect(result.reasoning).toBe("思考A");
    expect(result.content).toBe("answer");
  });

  it("accumulates reasoning across steps without duplicating either step", async () => {
    // A second model call only happens when the first step asked for a tool.
    const { result, events } = await run({
      turns: [
        { reasoning: "step one ", toolCalls: [{ name: "no_such_tool", args: {} }] },
        { reasoning: "step two", content: "part 2" },
      ],
    });

    const deltas = events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["step one ", "step two"]);
    expect(result.reasoning).toBe("step one step two");
  });

  it.each(["reasoning", "reasoning_text"] as const)(
    "picks up the tap-only key %s exactly once",
    async (reasoningKey) => {
      const { result, events } = await run({
        turns: [{ reasoning: "quiet thought", reasoningKey, content: "answer" }],
      });

      // These keys are never mapped into `additional_kwargs`, so only the wire tap can
      // see them — this guards the tap against being "simplified" away.
      expect(events.filter((e) => e.type === "reasoning").length).toBe(1);
      expect(result.reasoning).toBe("quiet thought");
    }
  );

  it("never replays reasoning into the next turn's history", async () => {
    const history: Message[] = [
      message({ role: "user", content: "first question" }),
      message({ role: "assistant", content: "first answer", reasoning: "SECRET_THOUGHT" }),
    ];

    await run({ turns: [{ content: "second answer" }], history });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    expect(JSON.stringify(sent.messages)).not.toContain("SECRET_THOUGHT");
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("runAgentStream — tool calling", () => {
  it("runs a real tool and feeds the result back for a final answer", async () => {
    const files = fileToolsFor(join(scratch, "ws"), { defaultLocation: "workspace" }).tools;
    const { events, result } = await run({
      tools: [files.writeFile],
      turns: [
        {
          content: "Let me write that file.",
          toolCalls: [{ id: "call_1", name: "write_file", args: { path: "notes/a.txt", content: "hello" } }],
          usage: { input: 50, output: 10 },
        },
        { content: "Done.", usage: { input: 60, output: 5 } },
      ],
    });

    // The tool really executed, against the real sandbox helpers.
    expect(readFileSync(join(workdir, "notes/a.txt"), "utf8")).toBe("hello");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ id: "call_1", name: "write_file" });
    expect(result.toolCalls[0]!.output).toContain("Wrote 5 characters");

    const types = events.map((e) => e.type);
    expect(types).toEqual(["text", "tool_start", "tool_end", "text", "usage"]);

    // Usage is summed across the two steps — what the provider actually billed.
    expect(result.usage).toMatchObject({ inputTokens: 110, outputTokens: 15, totalTokens: 125 });
  });

  it("hands the tool result back to the model as a tool message", async () => {
    const files = fileToolsFor(join(scratch, "ws"), { defaultLocation: "workspace" }).tools;
    await run({
      tools: [files.writeFile],
      turns: [
        { toolCalls: [{ id: "call_1", name: "write_file", args: { path: "b.txt", content: "x" } }] },
        { content: "Done." },
      ],
    });

    const second = llm.requests()[1] as { messages: { role: string; content?: unknown }[] };
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(JSON.stringify(toolMessage)).toContain("Wrote 1 characters");
  });

  it("reports an unknown tool to the model instead of throwing", async () => {
    const { result } = await run({
      turns: [{ toolCalls: [{ name: "no_such_tool", args: {} }] }, { content: "recovered" }],
    });

    expect(result.toolCalls[0]!.output).toBe('Unknown tool "no_such_tool".');
    expect(result.content).toBe("recovered");
  });

  it("turns a tool failure into a tool result rather than a failed turn", async () => {
    const files = fileToolsFor(join(scratch, "ws"), { defaultLocation: "workspace" }).tools;
    const { result, events } = await run({
      tools: [files.readFile],
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "missing.txt" } }] },
        { content: "the file does not exist" },
      ],
    });

    expect(result.toolCalls[0]!.output).toMatch(/^Tool error: /);
    expect(events.some((e) => e.type === "tool_end")).toBe(true);
    expect(result.content).toBe("the file does not exist");
  });

  it("refuses a tool call that escapes the workspace sandbox", async () => {
    const files = fileToolsFor(join(scratch, "ws"), { defaultLocation: "workspace" }).tools;
    const { result } = await run({
      tools: [files.readFile],
      turns: [
        { toolCalls: [{ name: "read_file", args: { path: "../../etc/hosts" } }] },
        { content: "cannot read that" },
      ],
    });

    expect(result.toolCalls[0]!.output).toContain("outside the workspace sandbox");
  });
});

describe("runAgentStream — step breaks", () => {
  const streamedOf = (events: readonly ChatStreamEvent[]): string =>
    events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");

  it("separates two speaking steps with a paragraph break", async () => {
    const { events } = await run({
      turns: [
        { content: "我先读一下这个文件。", toolCalls: [{ name: "no_such_tool", args: {} }] },
        { content: "读完了，这里是答案。" },
      ],
    });

    // Not "我先读一下这个文件。读完了，这里是答案。" — two utterances run together read as one
    // broken sentence whatever language they are in.
    expect(streamedOf(events)).toBe("我先读一下这个文件。\n\n读完了，这里是答案。");
  });

  it("opens no break in front of the first step", async () => {
    const { events } = await run({ turns: [{ content: "只有一步。" }] });

    expect(streamedOf(events)).toBe("只有一步。");
  });

  it("adds no break for a step that said nothing", async () => {
    // The break belongs between steps that both spoke: a bare tool call in the middle must
    // not leave a blank paragraph behind it.
    const { events } = await run({
      turns: [
        { content: "先查一下。", toolCalls: [{ name: "no_such_tool", args: {} }] },
        { toolCalls: [{ name: "no_such_tool", args: {} }] },
        { content: "答案是 42。" },
      ],
    });

    expect(streamedOf(events)).toBe("先查一下。\n\n答案是 42。");
  });
});

describe("runAgentStream — step budget", () => {
  it("stops at maxSteps and explains itself", async () => {
    const calls = Array.from({ length: 5 }, () => ({
      toolCalls: [{ name: "no_such_tool", args: {} }],
    }));

    const { result } = await run({ turns: calls, settings: { maxSteps: 2 } });

    expect(result.toolCalls).toHaveLength(2);
    // Two streamed requests, and no third for a "final answer".
    expect(llm.requests()).toHaveLength(2);
    expect(result.content).toContain("ran out of steps");
  });
});

describe("runAgentStream — history handling", () => {
  it("replays completed tool calls together with their results", async () => {
    const history: Message[] = [
      message({ role: "user", content: "write a file" }),
      message({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "prev_1", name: "write_file", input: '{"path":"a.txt"}', output: "Wrote 1 characters" }],
      }),
    ];

    await run({ turns: [{ content: "ok" }], history });

    const sent = llm.requests()[0] as { messages: { role: string; tool_calls?: unknown }[] };
    const assistant = sent.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toHaveLength(1);
    expect(sent.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("drops a tool call whose result was never recorded", async () => {
    // OpenAI rejects a `tool_calls` block with no matching tool result, so an
    // interrupted turn must be replayed as a plain assistant message.
    const history: Message[] = [
      message({ role: "user", content: "write a file" }),
      message({
        role: "assistant",
        content: "interrupted",
        toolCalls: [{ id: "prev_1", name: "write_file", input: "{}" }],
      }),
    ];

    await run({ turns: [{ content: "ok" }], history });

    const sent = llm.requests()[0] as { messages: { role: string; tool_calls?: unknown }[] };
    expect(sent.messages.find((m) => m.role === "assistant")?.tool_calls).toBeUndefined();
    expect(sent.messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("trims history to maxContextMessages and opens on a user turn", async () => {
    const history: Message[] = [
      message({ role: "user", content: "oldest" }),
      message({ role: "assistant", content: "old reply" }),
      message({ role: "user", content: "middle" }),
      message({ role: "assistant", content: "mid reply" }),
      message({ role: "user", content: "newest" }),
      message({ role: "assistant", content: "new reply" }),
    ];

    await run({ turns: [{ content: "ok" }], history, settings: { maxContextMessages: 3 } });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    // system + the last 3 messages (minus the leading assistant, which is dropped so the
    // window opens on a user turn) + the new user turn.
    expect(sent.messages).toHaveLength(4);
    expect(sent.messages[1]!.role).toBe("user");
    expect(JSON.stringify(sent.messages)).toContain("newest");
    expect(JSON.stringify(sent.messages)).not.toContain("oldest");
  });

  it("keeps a diagram's source in history, so the model can revise its own drawing", async () => {
    /*
     * The revise story, and why the diagram tool has no read companion. A non-suspending
     * tool's arguments are persisted verbatim onto the call, and `buildHistoryMessages`
     * replays every call that has an output — so on a later turn the model is shown the source
     * it drew, which is the only copy it can reach. `redactQuizInput` is the precedent for
     * this not being automatic: a redaction added here later would silently take away the
     * model's ability to correct its own diagram, and nothing else would fail.
     */
    const diagram = buildDiagramTool({
      sessionDir: join(scratch, "ws", "sessions", "s1"),
      save: () => undefined,
    });
    const source = "flowchart TD\n  A --> B";
    const summary = "A flow from A to B";

    const first = await run({
      tools: [diagram],
      turns: [
        {
          toolCalls: [
            { id: "call_1", name: "ila_diagram", args: { name: "flow", source, summary } },
          ],
        },
        { content: "Drawn." },
      ],
    });

    const call = first.result.toolCalls[0]!;
    expect(call.input).toContain("flowchart TD");
    // The tool really ran against the real filesystem closure: the file is on disk.
    expect(existsSync(join(scratch, "ws", "sessions", "s1", "flow.mmd"))).toBe(true);

    await run({
      turns: [{ content: "ok" }],
      history: [
        message({ role: "user", content: "draw it" }),
        message({
          role: "assistant",
          content: "Drawn.",
          toolCalls: [{ id: "call_1", name: "ila_diagram", input: call.input, output: call.output }],
        }),
      ],
    });

    const sent = llm.requests().at(-1) as { messages: unknown[] };
    expect(JSON.stringify(sent.messages)).toContain("flowchart TD");
  });

  /*
   * Both folders, by absolute path, and the default named.
   *
   * This replaces a test that asserted the opposite — that the session directory was *not* in
   * the prompt. That was right while the only writable folder was the workdir, and the claim it
   * protected ("the sandbox is the workdir") stopped being true the moment a file could go into
   * a conversation's own directory. The thing still worth pinning is that the prompt names *the
   * folders the tools resolve against* and not their parent: a model told to write into
   * `<workspace>` would be aiming at the directory holding `workdir/` and `sessions/`, which
   * the tools refuse.
   */
  it("names both writable folders and the effective default", async () => {
    await run({ turns: [{ content: "ok" }] });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    expect(sent.messages[0]!.role).toBe("system");
    const prompt = JSON.stringify(sent.messages[0]!.content);
    expect(prompt).toContain(workdir);
    expect(prompt).toContain(join(scratch, "ws", "sessions", "s1"));
    expect(prompt).toContain("conversation folder");
    // The workspace's own directory — the parent of both — is never offered as a place to write.
    expect(prompt).not.toContain(`${join(scratch, "ws")}\n`);
  });

  it("names the workspace folder as the default when the session says so", async () => {
    await run({ turns: [{ content: "ok" }], writeLocation: "workspace" });

    const sent = llm.requests()[0] as { messages: { content: unknown }[] };
    expect(JSON.stringify(sent.messages[0]!.content)).toContain(
      "goes to the shared workspace folder"
    );
  });

  it("tells the built-in assistant to confirm a deliverable it has finished", async () => {
    // What a conversation with no Copilot gets. The prompt used to offer `ask_user` only for
    // a choice made *before* the work — several defensible options and no way to tell which
    // — so a turn that had just produced a plan could read itself as finished and ask in
    // prose, which draws no card. The tool's own description carries the same rule and is
    // the half that survives a Copilot's prompt replacing this string; this is the policy.
    await run({ turns: [{ content: "ok" }] });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    expect(sent.messages[0]!.role).toBe("system");

    const system = JSON.stringify(sent.messages[0]!.content);
    expect(system).toContain("put it to them for confirmation");
    expect(system).toContain("ask_user");
  });

  it("replaces the built-in assistant prompt with the session's own", async () => {
    // A Copilot's persona reaches the model as the *session's* string now, because the session
    // copied it at creation. The loop takes the prompt and nothing about where it came from,
    // which is what makes an edit to the Copilot afterwards unable to reach this turn.
    await run({ turns: [{ content: "ok" }], systemPrompt: "You are a laconic tutor." });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    const system = JSON.stringify(sent.messages[0]!.content);
    expect(system).toContain("You are a laconic tutor.");
    expect(system).not.toContain("You are a helpful, precise AI assistant");
    // The sandbox note is appended to whichever persona was chosen, so it survives.
    expect(system).toContain(workdir);
  });

  it("puts the ask_user description on the wire", async () => {
    // `askUser.test.ts` asserts the string is on the tool *object*; this closes the gap to
    // "the model is actually sent it", which is the whole claim a wording change rests on.
    // A description that never reaches the request is not guidance, it is a comment.
    await run({ turns: [{ content: "ok" }], tools: [buildAskUserTool()] });

    const sent = llm.requests()[0] as {
      tools?: { function: { name: string; description: string } }[];
    };
    const sent_ask_user = sent.tools?.find((t) => t.function.name === "ask_user");

    expect(sent_ask_user).toBeDefined();
    expect(sent_ask_user!.function.description).toContain("just produced a plan");
  });
});

describe("runAgentStream — stopped mid-turn", () => {
  /*
   * A pause after every frame is what makes any of this testable: without it the fake
   * model writes a whole turn in one synchronous burst and there is no instant at which
   * an abort could land.
   */
  const HELD = { content: "half an answer", holdMs: 100 };

  it("resolves with what had streamed, and says the turn was stopped", async () => {
    const controller = new AbortController();
    const promise = run({ turns: [HELD], signal: controller.signal });
    await sleep(120);
    controller.abort();

    const { events, result } = await promise;

    // Not an error and not a failure: the caller persists this as a partial reply.
    expect(result.stopped).toBe(true);
    expect(result.content).toBe("half an answer");
    expect(events.some((e) => e.type === "text")).toBe(true);
    // The abort reached the provider rather than merely leaving it generating. Polled: the
    // fake server learns of the hang-up from its own socket event, a moment after the loop
    // has already unwound.
    await vi.waitFor(() => expect(llm.abortedRequests()).toBe(1));
  });

  it("reports nothing rather than a half-step's usage", async () => {
    const controller = new AbortController();
    const promise = run({ turns: [HELD], signal: controller.signal });
    await sleep(120);
    controller.abort();

    const { events, result } = await promise;
    expect(result.usage).toEqual({});
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });

  it("does not claim the step budget ran out", async () => {
    // The truncated-budget sentence is for a turn that ran out of steps. A stopped turn
    // was ended by the user, so `OUT_OF_STEPS` would be a lie — and worse, one replayed to
    // the model next turn. An empty reply here is legitimate.
    const controller = new AbortController();
    controller.abort();

    const { result } = await run({ turns: [HELD], signal: controller.signal });
    expect(result.stopped).toBe(true);
    expect(result.content).toBe("");
  });

  it("lets a genuine failure through, with a signal that never fired", async () => {
    // The catch is narrow on purpose. Swallowing everything there would dress any provider
    // outage up as a silent, empty turn the user appeared to have stopped.
    //
    // A provider that rejects the request outright. A 400 and not a 5xx, and a live server
    // and not an unreachable host: ChatOpenAI retries 5xx and connection failures with
    // backoff, so either would fail slowly and for a reason this test is not about — while
    // what is under test is only that a non-abort throw still leaves the loop.
    const failing = createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "the request is malformed" } }));
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const port = (failing.address() as AddressInfo).port;

    try {
      await expect(
        run({
          turns: [{ content: "never sent" }],
          signal: new AbortController().signal,
          baseURL: `http://127.0.0.1:${port}/v1`,
        })
      ).rejects.toThrow();
    } finally {
      failing.closeAllConnections();
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it("does not report an aborted tool call as a tool failure", async () => {
    // A stop is not the tool breaking. Reporting it as `Tool error: …` would carry the loop
    // into another step and persist a `tool_calls` block with a result nobody produced.
    const controller = new AbortController();
    let passedSignal: AbortSignal | undefined;

    const tool = {
      name: "slow_tool",
      description: "aborts itself",
      invoke: async (_input: unknown, config?: { signal?: AbortSignal }) => {
        passedSignal = config?.signal;
        controller.abort();
        throw new Error("this tool was interrupted");
      },
    } as unknown as StructuredToolInterface;

    const { events, result } = await run({
      turns: [{ toolCalls: [{ name: "slow_tool", args: {} }] }, { content: "unreachable" }],
      tools: [tool],
      signal: controller.signal,
    });

    // The signal reaches the tool at all — every part of this design rests on that.
    expect(passedSignal).toBe(controller.signal);
    expect(result.stopped).toBe(true);
    expect(result.toolCalls).toEqual([]);
    expect(events.some((e) => e.type === "tool_end")).toBe(false);
    // And the loop did not carry on to the second step.
    expect(result.content).not.toContain("unreachable");
  });
});

describe("runAgentStream — known inconsistencies (pinned)", () => {
  /*
   * Documents behaviour we are deliberately NOT changing here. If either of these
   * starts failing, the semantics changed and the UI/UX consequences need a decision.
   */

  it("streams tool-step narration but persists only the final answer", async () => {
    const files = fileToolsFor(join(scratch, "ws"), { defaultLocation: "workspace" }).tools;
    const { events, result } = await run({
      tools: [files.writeFile],
      turns: [
        { content: "I will write that file now.", toolCalls: [{ name: "write_file", args: { path: "c.txt", content: "y" } }] },
        { content: "All done." },
      ],
    });

    const streamed = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");

    // The live stream shows the narration plus the answer, and the two steps are separated by
    // a paragraph break rather than run together as one sentence.
    expect(streamed).toBe("I will write that file now.\n\nAll done.");
    // ...but only the final step's text is persisted, so a reload loses the narration.
    expect(result.content).toBe("All done.");
  });
});

describe("runAgentStream — quiz grading rundown survives later steps", () => {
  /*
   * The general rule above (persist only the last step's utterance) has one exception:
   * text streamed beside `ila_review_quiz` is the per-question verdict walkthrough — the
   * turn's actual answer — whereas a following step that only moves the plan and asks
   * whether to continue used to replace it, so the verdicts shown live vanished at
   * `message_done`. These stand-ins speak the tool names the loop keys on; no database.
   */
  const RUNDOWN = "Q1：回答正确。滑动窗口按步长触发。\nQ2：也答对了，RocksDB 是状态后端。";

  const gradingTool = (): StructuredToolInterface =>
    tool(async () => JSON.stringify({ graded: [], note: "noted" }), {
      name: QUIZ_REVIEW_TOOL_NAME,
      description: "record quiz verdicts",
      schema: z.object({ reviews: z.array(z.unknown()) }),
    });
  const progressTool = (): StructuredToolInterface =>
    tool(async () => JSON.stringify({ ok: true }), {
      name: PLAN_PROGRESS_TOOL_NAME,
      description: "move the plan on",
      schema: z.object({}),
    });

  const textOf = (events: ChatStreamEvent[]) =>
    events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");

  it("keeps the walkthrough when a later plan step's final message only asks what is next", async () => {
    const { events, result } = await run({
      tools: [gradingTool(), progressTool()],
      turns: [
        {
          content: RUNDOWN,
          toolCalls: [{ name: QUIZ_REVIEW_TOOL_NAME, args: { reviews: [] } }],
        },
        { toolCalls: [{ name: PLAN_PROGRESS_TOOL_NAME, args: {} }] },
        { content: "本章进度已更新，要进入下一章节吗？" },
      ],
    });

    // What streamed live is what survives: the verdicts no longer vanish when the final
    // step replaces them. Both halves now read the same string — the walkthrough, a paragraph
    // break, then the question — which is the point of the break being streamed.
    expect(textOf(events)).toBe(`${RUNDOWN}\n\n本章进度已更新，要进入下一章节吗？`);
    expect(result.content).toBe(`${RUNDOWN}\n\n本章进度已更新，要进入下一章节吗？`);
  });

  it("does not duplicate a walkthrough the final step repeats verbatim", async () => {
    const { result } = await run({
      tools: [gradingTool()],
      turns: [
        {
          content: RUNDOWN,
          toolCalls: [{ name: QUIZ_REVIEW_TOOL_NAME, args: { reviews: [] } }],
        },
        // The model re-answered with the same rundown plus the hand-back question.
        { content: `${RUNDOWN}\n\n继续吗？` },
      ],
    });

    expect(result.content).toBe(`${RUNDOWN}\n\n继续吗？`);
    expect(result.content.split("滑动窗口按步长触发")).toHaveLength(2);
  });

  it("joins an earlier walkthrough with the preamble of a step that suspends", async () => {
    const questions = [
      {
        header: "去向",
        question: "接下来学哪一章？",
        options: [{ label: "窗口" }, { label: "状态" }],
      },
    ];
    const { result } = await run({
      tools: [gradingTool(), buildAskUserTool()],
      turns: [
        {
          content: RUNDOWN,
          toolCalls: [{ name: QUIZ_REVIEW_TOOL_NAME, args: { reviews: [] } }],
        },
        {
          content: "接下来怎么走，你定。",
          toolCalls: [{ name: "ask_user", args: { questions } }],
        },
      ],
    });

    expect(result.awaiting).toBe(true);
    expect(result.content).toBe(`${RUNDOWN}\n\n接下来怎么走，你定。`);
  });

  it("keeps the walkthrough when the step budget runs out mid-turn", async () => {
    const { result } = await run({
      tools: [gradingTool()],
      settings: { maxSteps: 2 },
      turns: [
        {
          content: RUNDOWN,
          toolCalls: [{ name: QUIZ_REVIEW_TOOL_NAME, args: { reviews: [] } }],
        },
        {
          content: "还在继续批改。",
          toolCalls: [{ name: QUIZ_REVIEW_TOOL_NAME, args: { reviews: [] } }],
        },
      ],
    });

    expect(result.content).toContain(RUNDOWN);
    expect(result.content).toContain("还在继续批改。");
    expect(result.content).toContain("ran out of steps");
  });
});

describe("runAgentStream — a recorded table survives later steps", () => {
  /*
   * The same exception as the grading rundown above, for the other tool that has it, and this
   * one is the whole feature rather than a nicety: `ila_table` renders **nothing**. Its contract
   * is that the table is written into the reply as ordinary Markdown, so the prose beside the
   * call is the artifact — and the shape a real model produces is the table in the step that
   * records it, followed by a closing question. Under the last-utterance rule the table streamed
   * live and then vanished at `message_done`, so the panel listed a table the conversation no
   * longer showed. See `ANSWER_BEARING_TOOLS`.
   */
  const TABLE = "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |";

  const tableTool = (): StructuredToolInterface =>
    tool(async () => JSON.stringify({ saved: "季度对比" }), {
      name: TABLE_TOOL_NAME,
      description: "record a table",
      schema: z.object({ name: z.string(), table: z.string(), summary: z.string() }),
    });

  it("keeps the table when a later step only asks what to expand", async () => {
    const { result } = await run({
      tools: [tableTool()],
      turns: [
        {
          content: `好的，对比表如下：\n\n${TABLE}`,
          toolCalls: [{ name: TABLE_TOOL_NAME, args: { name: "季度对比", table: TABLE, summary: "三项" } }],
        },
        { content: "已记录，需要展开哪一项？" },
      ],
    });

    expect(result.content).toBe(`好的，对比表如下：\n\n${TABLE}\n\n已记录，需要展开哪一项？`);
  });

  it("does not duplicate a table the final step repeats verbatim", async () => {
    // The other half of the rule: a model that re-writes the table in its final answer must not
    // produce it twice.
    const { result } = await run({
      tools: [tableTool()],
      turns: [
        {
          content: TABLE,
          toolCalls: [{ name: TABLE_TOOL_NAME, args: { name: "季度对比", table: TABLE, summary: "三项" } }],
        },
        { content: `${TABLE}\n\n需要展开哪一项？` },
      ],
    });

    expect(result.content).toBe(`${TABLE}\n\n需要展开哪一项？`);
    expect(result.content.split("| 速度 | 3 |")).toHaveLength(2);
  });

  it("still drops narration beside an ordinary tool call", async () => {
    // The general rule is untouched, and the control is a call that is *not* answer-bearing: a
    // write's preamble is still narration, which is what keeps a message to one utterance.
    const files = fileToolsFor(join(scratch, "ws2"), { defaultLocation: "workspace" }).tools;
    const { result } = await run({
      tools: [files.writeFile, tableTool()],
      turns: [
        { content: "我先把这份说明写进文件。", toolCalls: [{ name: "write_file", args: { path: "n.md", content: "x" } }] },
        { content: "写好了。" },
      ],
    });

    expect(result.content).toBe("写好了。");
  });
});

describe("runAgentStream — a suspending tool ends the turn", () => {
  const questions = [
    {
      header: "认证方式",
      question: "要用哪种认证方式？",
      options: [{ label: "OAuth" }, { label: "API Key" }],
    },
  ];

  const askUser = () => [buildAskUserTool()];

  /**
   * `quiz` numbers its questions from the turn's context. The loop holds no database by
   * design — which store is authoritative is the route's business — so a stand-in keeps
   * these cases off one. The start number is a parameter because the id coming from the
   * *counter* rather than from the question's position is one of the things pinned here.
   */
  const quiz = (start = 1) => [
    buildQuizTool({
      reserveQuestionNumbers: (count) => Array.from({ length: count }, (_, i) => start + i),
      registerQuestions: ({ items }) =>
        items.map((item) => ({ uid: `uid-${item.qid}`, qid: item.qid })),
    }),
  ];

  const quizQuestions = [
    { header: "窗口", question: "哪种窗口？", options: [{ label: "滚动" }, { label: "滑动" }] },
    { header: "状态", question: "状态后端？", options: [{ label: "RocksDB" }, { label: "内存" }] },
  ];

  it("stops the turn, records the call as awaiting, and emits no end for it", async () => {
    const { events, result } = await run({
      tools: askUser(),
      turns: [{ toolCalls: [{ name: "ask_user", args: { questions } }] }],
    });

    expect(result.awaiting).toBe(true);

    // The pending call is recorded so the route can persist it — but with no `output`,
    // which is exactly what keeps it out of history until the user answers.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "ask_user", status: "awaiting" });
    expect(result.toolCalls[0]!.output).toBeUndefined();

    // A `tool_start` with no matching `tool_end`: there is no result yet, and saying there
    // was would render the card as a finished, answer-less question.
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_end")).toEqual([]);
  });

  it("does not report the suspension as a failed tool", async () => {
    // The sentinel is an exception, so the generic arm would happily turn it into
    // "Tool error: …" — telling the model its own question broke.
    const { result } = await run({
      tools: askUser(),
      turns: [{ toolCalls: [{ name: "ask_user", args: { questions } }] }],
    });

    expect(result.toolCalls[0]!.output).toBeUndefined();
    expect(JSON.stringify(result.toolCalls)).not.toContain("Tool error");
  });

  it("does not claim the step budget ran out", async () => {
    const { result } = await run({
      tools: askUser(),
      turns: [{ toolCalls: [{ name: "ask_user", args: { questions } }] }],
    });

    expect(result.content).toBe("");
  });

  it("keeps a preamble the model streamed before asking", async () => {
    const { result, events } = await run({
      tools: askUser(),
      turns: [
        {
          content: "有两件事需要你定。",
          toolCalls: [{ name: "ask_user", args: { questions } }],
        },
      ],
    });

    expect(result.content).toBe("有两件事需要你定。");
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("runs the step's other tool calls before suspending", async () => {
    // Nothing the model asked for is silently dropped: the read still happens, and the
    // question is the only thing left outstanding.
    const files = fileToolsFor(join(scratch, "ws"), { defaultLocation: "workspace" }).tools;
    await files.writeFile.invoke({ path: "a.txt", content: "hello" });

    const { result } = await run({
      tools: [files.readFile, buildAskUserTool()],
      turns: [
        {
          toolCalls: [
            { id: "call_read", name: "read_file", args: { path: "a.txt" } },
            { id: "call_ask", name: "ask_user", args: { questions } },
          ],
        },
      ],
    });

    expect(result.awaiting).toBe(true);
    const read = result.toolCalls.find((tc) => tc.id === "call_read");
    expect(read?.output).toContain("hello");
    expect(result.toolCalls.find((tc) => tc.id === "call_ask")?.status).toBe("awaiting");
  });

  it("rejects a second ask_user in the same step instead of suspending twice", async () => {
    // Two live question sets is a state the card has no way to present, and the model can
    // simply ask again — so the extra call becomes an ordinary tool error it can read.
    const { result } = await run({
      tools: askUser(),
      turns: [
        {
          toolCalls: [
            { id: "call_a", name: "ask_user", args: { questions } },
            { id: "call_b", name: "ask_user", args: { questions } },
          ],
        },
      ],
    });

    expect(result.awaiting).toBe(true);
    const second = result.toolCalls.find((tc) => tc.id === "call_b");
    expect(second?.status).toBeUndefined();
    expect(second?.output).toMatch(/only one question tool call is allowed per step/);
  });

  it("records the ids quiz assigned, which the model itself never sent", async () => {
    // The loop stringifies a call's arguments *before* invoking the tool, and the numbering
    // happens inside the tool — so `recordedInput` is the only path those ids have into the
    // persisted record that the card is re-rendered from. Numbering from 5 pins the other
    // half: an id comes from the counter, not from the question's position in the list.
    const { events, result } = await run({
      tools: quiz(5),
      turns: [{ toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: quizQuestions } }] }],
    });

    expect(result.awaiting).toBe(true);
    const call = result.toolCalls[0]!;
    expect(call).toMatchObject({ name: "ila_quiz", status: "awaiting" });
    expect(call.output).toBeUndefined();
    // No `tool_end` either, for the same reason as `ask_user`: there is no result yet.
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_end")).toEqual([]);

    const recorded = JSON.parse(call.input) as { questions: { id: string }[] };
    expect(recorded.questions.map((q) => q.id)).toEqual(["Q5", "Q6"]);
  });

  it("rejects a second suspension in the same step, from the other tool too", async () => {
    // The rule is one live question set per step, not one per tool: two cards at once is a
    // state the UI has no way to present, whichever tools produced them. The losing call
    // becomes an ordinary tool error the model can read.
    const { result } = await run({
      tools: [...askUser(), ...quiz()],
      turns: [
        {
          toolCalls: [
            { id: "call_ask", name: "ask_user", args: { questions } },
            { id: "call_quiz", name: "ila_quiz", args: { questions: [quizQuestions[0]] } },
          ],
        },
      ],
    });

    expect(result.awaiting).toBe(true);
    expect(result.toolCalls.find((tc) => tc.id === "call_ask")?.status).toBe("awaiting");
    const second = result.toolCalls.find((tc) => tc.id === "call_quiz");
    expect(second?.status).toBeUndefined();
    expect(second?.output).toMatch(/only one question tool call is allowed per step/);
  });

  it("turns a malformed question set into a tool error, so no card is ever rendered", async () => {
    // Validation runs inside the tool, which means a bad question set fails before the
    // suspension exists. The model gets an ordinary tool error and can correct itself.
    const { result } = await run({
      tools: askUser(),
      turns: [
        { toolCalls: [{ name: "ask_user", args: { questions: [] } }] },
        { content: "明白了。" },
      ],
    });

    expect(result.awaiting).toBe(false);
    expect(result.toolCalls[0]!.output).toMatch(/^Tool error: /);
  });

  it("cannot suspend when the tool is not in the turn's tool set", async () => {
    const { result } = await run({
      tools: [],
      turns: [{ toolCalls: [{ name: "ask_user", args: { questions } }] }, { content: "好的" }],
    });

    expect(result.awaiting).toBe(false);
    expect(result.toolCalls[0]!.output).toBe('Unknown tool "ask_user".');
  });

  it("resumes without appending a user message, replaying the call and its result", async () => {
    const { result } = await run({
      tools: askUser(),
      userMessage: null,
      turns: [{ content: "好的，按 OAuth 实现。" }],
      history: [
        message({ role: "user", content: "帮我加个登录" }),
        message({
          role: "assistant",
          content: "需要先确认一件事。",
          toolCalls: [
            {
              id: "call_ask",
              name: "ask_user",
              input: JSON.stringify({ questions }),
              output: '{"user_answers":[{"question":"要用哪种认证方式？","selected":["OAuth"]}]}',
              status: "answered",
            },
          ],
        }),
      ],
    });

    expect(result.content).toBe("好的，按 OAuth 实现。");
    expect(result.awaiting).toBe(false);

    const sent = llm.requests().at(-1) as {
      messages: { role: string; tool_calls?: { id: string; function: { name: string } }[] }[];
    };
    // The history's own user turn is there, but nothing was appended after the tool result
    // — the resumed run's request ends on the answer, not on words the user never wrote.
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sent.messages.at(-1)!.role).toBe("tool");
    expect(sent.messages[2]!.tool_calls?.[0]?.function.name).toBe("ask_user");
  });

  it("omits an unanswered call from the resumed history", async () => {
    // The `skipped` case: the user sent a message instead of answering, so the call has no
    // `output` and `buildHistoryMessages` leaves it out rather than sending OpenAI a
    // `tool_calls` block whose results are missing.
    await run({
      tools: askUser(),
      turns: [{ content: "ok" }],
      history: [
        message({ role: "user", content: "帮我加个登录" }),
        message({
          role: "assistant",
          content: "需要先确认一件事。",
          toolCalls: [
            {
              id: "call_ask",
              name: "ask_user",
              input: JSON.stringify({ questions }),
              status: "skipped",
            },
          ],
        }),
      ],
    });

    const sent = llm.requests().at(-1) as { messages: { role: string }[] };
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("replaying reasoning into history", () => {
  /** An assistant turn that used a tool, as it comes back out of the database. */
  const history: Message[] = [
    message({ role: "user", content: "教我 Flink" }),
    message({
      role: "assistant",
      content: "先看一眼工作区。",
      reasoning: "the chain of thought that produced the tool call",
      toolCalls: [{ id: "call_ls", name: "read_file", input: '{"path":"."}', output: "{}" }],
    }),
  ];

  const sentMessages = (): Record<string, unknown>[] =>
    (llm.requests().at(-1) as { messages: Record<string, unknown>[] }).messages;

  it("sends the chain of thought back with the tool call, for a reasoning model", async () => {
    // DeepSeek's thinking mode answers 400 without this — and LangChain cannot send it,
    // so it leaves the run through a side channel and the fetch wrapper puts it back.
    await run({
      turns: [{ content: "好。" }],
      history,
      capabilities: ["tool_use", "reasoning"],
    });

    const assistant = sentMessages().find((m) => m.role === "assistant")!;
    expect(assistant).toMatchObject({
      content: "先看一眼工作区。",
      reasoning_content: "the chain of thought that produced the tool call",
    });
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it("leaves the field off entirely for a model that never used it", async () => {
    await run({ turns: [{ content: "好。" }], history, capabilities: ["tool_use"] });

    const assistant = sentMessages().find((m) => m.role === "assistant")!;
    expect(assistant).not.toHaveProperty("reasoning_content");
  });

  it("still sends an empty string when the turn recorded no reasoning", async () => {
    // The field has to be present on a tool-call message; where nothing was recorded the
    // value is the empty string DeepSeek sends itself, not an omission.
    const noReasoning = structuredClone(history);
    delete noReasoning[1]!.reasoning;

    await run({ turns: [{ content: "好。" }], history: noReasoning, capabilities: ["reasoning"] });

    expect(sentMessages().find((m) => m.role === "assistant")).toMatchObject({
      reasoning_content: "",
    });
  });

  it("does not attach it to a plain assistant turn", async () => {
    const plain = [message({ role: "user", content: "hi" }), message({ role: "assistant", content: "a", reasoning: "hidden" })];

    await run({ turns: [{ content: "好。" }], history: plain, capabilities: ["reasoning"] });

    expect(sentMessages().find((m) => m.role === "assistant")).not.toHaveProperty(
      "reasoning_content"
    );
  });
});

describe("what a suspended turn persists", () => {
  const questions = [
    { header: "背景", question: "你的背景？", options: [{ label: "A" }, { label: "B" }] },
  ];

  /** Narration before a tool, then the sentence that introduces the questions. */
  const narrateThenAsk = (): FakeTurn[] => [
    {
      content: "Let me look at the workspace.",
      toolCalls: [{ id: "c1", name: "no_such_tool", args: {} }],
    },
    {
      content: "我先确认几件事：",
      toolCalls: [{ id: "c2", name: "ask_user", args: { questions } }],
    },
  ];

  it("holds the last step's text, not every step's narration run together", async () => {
    // The bug this pins: a turn that ends on a tool call never reaches the branch that
    // *replaces* the accumulated text, so both steps were saved concatenated with no
    // separator — "Let me look at the workspace.我先确认几件事：".
    const { result } = await run({ tools: [buildAskUserTool()], turns: narrateThenAsk() });

    expect(result.awaiting).toBe(true);
    expect(result.content).toBe("我先确认几件事：");
  });

  it("still streams the narration, which is the accepted asymmetry", async () => {
    // The live view shows everything as it arrives; only what is *persisted* is trimmed.
    // That is the same trade the final-answer path already makes, and changing it would
    // be a product decision rather than a fix.
    const { events } = await run({ tools: [buildAskUserTool()], turns: narrateThenAsk() });

    const streamed = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    // Two steps, so two paragraphs: the English narration no longer runs straight into the
    // Chinese question it introduces.
    expect(streamed).toBe("Let me look at the workspace.\n\n我先确认几件事：");
  });

  it("falls back to the previous utterance when the asking step says nothing", async () => {
    // A silent suspending step must not resurrect the pile either — the most recent words
    // are still the most recent words.
    const { result } = await run({
      tools: [buildAskUserTool()],
      turns: [
        { content: "Let me look at the workspace.", toolCalls: [{ id: "c1", name: "no_such_tool", args: {} }] },
        { toolCalls: [{ id: "c2", name: "ask_user", args: { questions } }] },
      ],
    });

    expect(result.awaiting).toBe(true);
    expect(result.content).toBe("Let me look at the workspace.");
  });

  it("leaves a turn with no narration at all alone", async () => {
    const { result } = await run({
      tools: [buildAskUserTool()],
      turns: [{ content: "需要先确认。", toolCalls: [{ id: "c2", name: "ask_user", args: { questions } }] }],
    });

    expect(result.content).toBe("需要先确认。");
  });
});

describe("running out of steps", () => {
  const calls = (): FakeTurn[] => [
    { toolCalls: [{ id: "c1", name: "no_such_tool", args: {} }] },
    { toolCalls: [{ id: "c2", name: "no_such_tool", args: {} }] },
  ];

  it("keeps the last utterance and says it was cut short", async () => {
    // Both halves matter. The last utterance is the most recent thing the model said; the
    // notice is what stops a turn that stopped mid-work from reading as a finished answer.
    const { result } = await run({
      turns: [
        { content: "Let me look around.", toolCalls: [{ id: "c1", name: "no_such_tool", args: {} }] },
        { content: "我先看看工作区。", toolCalls: [{ id: "c2", name: "no_such_tool", args: {} }] },
      ],
      settings: { maxSteps: 2 },
    });

    // Not the two utterances run together.
    expect(result.content).toBe(
      "我先看看工作区。\n\nThe assistant ran out of steps while working on this task. Please ask a follow-up to continue."
    );
  });

  it("still says so when the model never spoke", async () => {
    const { result } = await run({ turns: calls(), settings: { maxSteps: 2 } });

    expect(result.content).toBe(
      "The assistant ran out of steps while working on this task. Please ask a follow-up to continue."
    );
  });

  it("does not add the notice when the model answered", async () => {
    const { result } = await run({
      turns: [
        { content: "查一下。", toolCalls: [{ id: "c1", name: "no_such_tool", args: {} }] },
        { content: "答案是 42。" },
      ],
      settings: { maxSteps: 2 },
    });

    expect(result.content).toBe("答案是 42。");
  });

  it("does not add the notice when the turn suspended on a question", async () => {
    const { result } = await run({
      tools: [buildAskUserTool()],
      settings: { maxSteps: 2 },
      turns: [
        { content: "先看一眼。", toolCalls: [{ id: "c1", name: "no_such_tool", args: {} }] },
        {
          content: "需要你定一下：",
          toolCalls: [
            {
              id: "c2",
              name: "ask_user",
              args: { questions: [{ header: "背景", question: "你的背景？", options: [{ label: "A" }, { label: "B" }] }] },
            },
          ],
        },
      ],
    });

    expect(result.awaiting).toBe(true);
    expect(result.content).toBe("需要你定一下：");
    expect(result.content).not.toContain("ran out of steps");
  });
});
