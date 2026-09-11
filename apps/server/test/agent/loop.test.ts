import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  Attachment,
  ChatStreamEvent,
  Message,
  SessionSettings,
} from "@guided-learning/shared";
import { runAgentStream } from "../../src/agent/loop.js";
import { buildFileTools } from "../../src/tools/fileTools.js";
import type { ProviderRecord } from "../../src/db.js";
import { startFakeLlm, type FakeLlm, type FakeTurn } from "../helpers/fakeLlm.js";

/**
 * Drives the real agent loop against a scripted OpenAI-compatible server, so the
 * LangChain path, the reasoning wire-tap and the ReAct stepping are all exercised
 * for real — only the model is fake.
 */

let llm: FakeLlm;
let scratch: string;

beforeAll(async () => {
  llm = await startFakeLlm();
});

afterAll(async () => {
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  scratch = mkdtempSync(join(tmpdir(), "gl-loop-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function provider(): ProviderRecord {
  return { id: "fake", name: "Fake", baseURL: llm.baseURL, apiKey: "test-key", models: [] };
}

interface RunOptions {
  turns: FakeTurn[];
  tools?: StructuredToolInterface[];
  settings?: SessionSettings;
  history?: Message[];
  userMessage?: string;
  attachments?: Attachment[];
  vision?: boolean;
  toolUse?: boolean;
}

async function run(options: RunOptions) {
  llm.setTurns(options.turns);
  const events: ChatStreamEvent[] = [];
  const result = await runAgentStream({
    provider: provider(),
    modelId: "fake-model",
    workspace: {
      id: "w1",
      name: "W",
      slug: "w",
      dirPath: scratch,
      createdAt: new Date().toISOString(),
    },
    settings: options.settings ?? {},
    uploadRoot: join(scratch, "uploads"),
    sessionId: "s1",
    vision: options.vision ?? false,
    toolUse: options.toolUse ?? false,
    history: options.history ?? [],
    userMessage: options.userMessage ?? "hello",
    attachments: options.attachments ?? [],
    tools: options.tools ?? [],
    onEvent: (event) => events.push(event),
  });
  return { events, result };
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
    const files = buildFileTools(scratch);
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
    expect(readFileSync(join(scratch, "notes/a.txt"), "utf8")).toBe("hello");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ id: "call_1", name: "write_file" });
    expect(result.toolCalls[0]!.output).toContain("Wrote 5 characters");

    const types = events.map((e) => e.type);
    expect(types).toEqual(["text", "tool_start", "tool_end", "text", "usage"]);

    // Usage is summed across the two steps — what the provider actually billed.
    expect(result.usage).toMatchObject({ inputTokens: 110, outputTokens: 15, totalTokens: 125 });
  });

  it("hands the tool result back to the model as a tool message", async () => {
    const files = buildFileTools(scratch);
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
    const files = buildFileTools(scratch);
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
    const files = buildFileTools(scratch);
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

  it("always sends the workspace sandbox note in the system prompt", async () => {
    await run({ turns: [{ content: "ok" }] });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    expect(sent.messages[0]!.role).toBe("system");
    expect(JSON.stringify(sent.messages[0]!.content)).toContain(scratch);
    expect(JSON.stringify(sent.messages[0]!.content)).toContain("sandboxed");
  });
});

describe("runAgentStream — known inconsistencies (pinned)", () => {
  /*
   * Documents behaviour we are deliberately NOT changing here. If either of these
   * starts failing, the semantics changed and the UI/UX consequences need a decision.
   */

  it("streams tool-step narration but persists only the final answer", async () => {
    const files = buildFileTools(scratch);
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

    // The live stream shows the narration plus the answer...
    expect(streamed).toBe("I will write that file now.All done.");
    // ...but only the final step's text is persisted, so a reload loses the narration.
    expect(result.content).toBe("All done.");
  });
});
