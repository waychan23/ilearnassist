import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  Attachment,
  ChatStreamEvent,
  Message,
  ModelCapability,
  SessionSettings,
} from "@ilearnassist/shared";
import { runAgentStream } from "../../src/agent/loop.js";
import { dataLayout, userLayout } from "../../src/paths.js";
import { buildAskUserTool } from "../../src/tools/askUser.js";
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

function provider(capabilities: ModelCapability[] = []): ProviderRecord {
  return {
    id: "fake",
    name: "Fake",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [{ id: "r1", modelId: "fake-model", name: "fake-model", capabilities }],
  };
}

interface RunOptions {
  turns: FakeTurn[];
  tools?: StructuredToolInterface[];
  settings?: SessionSettings;
  history?: Message[];
  /** `null` is a resume: a suspended turn carries on with no new user message. */
  userMessage?: string | null;
  attachments?: Attachment[];
  vision?: boolean;
  toolUse?: boolean;
  /** Declared capabilities of the model record — `reasoning` gates the replay below. */
  capabilities?: ModelCapability[];
}

async function run(options: RunOptions) {
  llm.setTurns(options.turns);
  const events: ChatStreamEvent[] = [];
  const result = await runAgentStream({
    provider: provider(options.capabilities ?? []),
    modelId: "fake-model",
    workspace: {
      id: "w1",
      name: "W",
      slug: "w",
      dirPath: join(scratch, "ws"),
      workdirPath: workdir,
      createdAt: new Date().toISOString(),
      sessionCount: 0,
      lastActivityAt: null,
    },
    settings: options.settings ?? {},
    // The whole user tree, not just the sources directory: `buildUserContent` derives a
    // source's path from the layout, so it needs the root it belongs to.
    user: userLayout(dataLayout(scratch), "tester"),
    sessionId: "s1",
    vision: options.vision ?? false,
    toolUse: options.toolUse ?? false,
    history: options.history ?? [],
    userMessage: options.userMessage === undefined ? "hello" : options.userMessage,
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
    const files = buildFileTools(workdir);
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
    const files = buildFileTools(workdir);
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
    const files = buildFileTools(workdir);
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
    const files = buildFileTools(workdir);
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
    // The *sandbox*, not the workspace's own directory: naming the parent would tell the
    // model that `sessions/` sits inside the place it may write to.
    expect(JSON.stringify(sent.messages[0]!.content)).toContain(workdir);
    expect(JSON.stringify(sent.messages[0]!.content)).not.toContain(join(scratch, "ws") + "/sessions");
    expect(JSON.stringify(sent.messages[0]!.content)).toContain("sandboxed");
  });
});

describe("runAgentStream — known inconsistencies (pinned)", () => {
  /*
   * Documents behaviour we are deliberately NOT changing here. If either of these
   * starts failing, the semantics changed and the UI/UX consequences need a decision.
   */

  it("streams tool-step narration but persists only the final answer", async () => {
    const files = buildFileTools(workdir);
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

describe("runAgentStream — ask_user suspends the turn", () => {
  const questions = [
    {
      header: "认证方式",
      question: "要用哪种认证方式？",
      options: [{ label: "OAuth" }, { label: "API Key" }],
    },
  ];

  const askUser = () => [buildAskUserTool()];

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
    const files = buildFileTools(workdir);
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
    expect(second?.output).toMatch(/only one ask_user call is allowed per step/);
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

  it("cannot suspend when the tool is not in the copilot's tool set", async () => {
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
    expect(streamed).toBe("Let me look at the workspace.我先确认几件事：");
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
