import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Diagram, Message, Session } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { repairArtifactMarker } from "../src/artifactRepair.js";
import { eventTypes, parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Missing-artifact repair, end to end: a reply writes an inline marker and never calls the tool
 * that produces the object, and the server completes it before persisting the message — or the
 * manual route does it later for one marker.
 *
 * The unit half is `repairArtifactMarker`'s refusal when the tool is not assembled; everything
 * else runs the real loop, the real artifact tools and the real routes, with only the model
 * faked. The repair call is recognisable in the fake's request log by the prompt's own first
 * sentence, the same marker technique the thread and insight passes use.
 */

const FLOW = "flowchart TD\n  A[开始] --> B[结束]";

let llm: FakeLlm;
let env: TestEnv;

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [{ id: "fake-model", name: "fake-model" }],
  };
  env = await startTestServer({
    providers: [provider],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Fake Conversation Title");
});

async function freshSession(): Promise<{
  session: Session;
  sessionDirPath: string;
  workdirPath: string;
}> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  const session = await newSession(env, workspace.id);
  return {
    session,
    sessionDirPath: join(workspace.dirPath, "sessions", session.id),
    workdirPath: workspace.workdirPath,
  };
}

async function chat(
  sessionId: string,
  payload: Record<string, unknown>
): Promise<{ res: Awaited<ReturnType<TestEnv["inject"]>>; events: ChatStreamEvent[] }> {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload,
  });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (
    await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })
  ).json<Message[]>();
}

async function diagramsOf(sessionId: string): Promise<Diagram[]> {
  return (
    await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/diagrams` })
  ).json<{ diagrams: Diagram[] }>().diagrams;
}

/** Every request the fake answered that was a repair call rather than a conversation turn. */
function repairRequests(): Record<string, unknown>[] {
  return llm
    .requests()
    .filter((body) => JSON.stringify(body).includes("artifact-completion function"));
}

describe("automatic missing-artifact repair", () => {
  it("completes a dangling diagram marker before the message is persisted", async () => {
    const { session, sessionDirPath } = await freshSession();
    llm.setTurns([
      { content: "如下图：\n\n[[artifact:diagram/ghost]]\n\n以上。" },
      {
        toolCalls: [
          {
            // Deliberately a different name than the marker: the marker's own identity must be
            // pinned onto whatever the repair call produced, or the card would not match it.
            name: "ila_diagram",
            args: { name: "something else", source: FLOW, summary: "补的图" },
          },
        ],
      },
    ]);

    const { res, events } = await chat(session.id, { message: "画个图" });

    expect(res.statusCode).toBe(200);
    expect(events.at(-1)).toEqual({ type: "done" });

    const done = events.find((e) => e.type === "message_done") as { message: Message };
    // The reply's content is exactly what streamed — the marker included, never rewritten.
    expect(done.message.content).toContain("[[artifact:diagram/ghost]]");
    const calls = done.message.toolCalls ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "ila_diagram" });
    expect(calls[0]!.output).toBeTruthy();

    // The repair went through the real tool: the file and its row both exist, named from the
    // marker rather than from the model's answer.
    expect(existsSync(join(sessionDirPath, "ghost.mmd"))).toBe(true);
    const diagrams = await diagramsOf(session.id);
    expect(diagrams.map((d) => d.name)).toEqual(["ghost.mmd"]);
    expect(diagrams[0]!.fileMissing).toBe(false);

    // The repair call is on the ledger under its own purpose, not folded into the chat turn.
    const rows = env.server.db.listUsageRows({
      userId: env.user.id,
      sessionId: session.id,
      fromIso: null,
      toIso: null,
    });
    expect(rows.some((r) => r.purpose === "artifact")).toBe(true);
    expect(repairRequests()).toHaveLength(1);

    /*
     * The repair request must not force `tool_choice`. The fake LLM ignores the field, which
     * is exactly how the first version shipped a 400 on every real DeepSeek call — thinking
     * mode refuses a forced choice (`Thinking mode does not support this tool_choice`). The
     * assertion is on the wire body because that is where the provider's refusal happened.
     */
    const choice = repairRequests()[0]!.tool_choice;
    expect(choice === undefined || choice === "auto").toBe(true);
  });

  it("leaves a marker with a matching call alone", async () => {
    const { session } = await freshSession();
    llm.setTurns([
      {
        content: "如下图：\n\n[[artifact:diagram/flow]]\n\n以上。",
        toolCalls: [
          { name: "ila_diagram", args: { name: "flow", source: FLOW, summary: "图" } },
        ],
      },
    ]);

    await chat(session.id, { message: "画个图" });

    expect(repairRequests()).toHaveLength(0);
  });

  it("keeps the turn healthy when the repair cannot produce a tool call", async () => {
    const { session } = await freshSession();
    // Only the conversation's own turn is scripted; every repair request falls to the fake's
    // default plain reply, so both attempts end with no tool call.
    llm.setTurns([{ content: "见图：\n\n[[artifact:plot/ghost]]\n\n以上。" }]);

    const { res, events } = await chat(session.id, { message: "画个图" });

    expect(res.statusCode).toBe(200);
    expect(events.at(-1)).toEqual({ type: "done" });
    const done = events.find((e) => e.type === "message_done") as { message: Message };
    expect(done.message.toolCalls ?? []).toHaveLength(0);
    // Two attempts, then the marker is left exactly as it was.
    expect(repairRequests()).toHaveLength(2);
  });

  it("does not overwrite a file on disk that has no row yet", async () => {
    const { session, sessionDirPath } = await freshSession();
    // A file the user dropped into the sandbox, which nothing has walked or registered.
    writeFileSync(join(sessionDirPath, "notes.md"), "user bytes");

    llm.setTurns([{ content: "见 [[artifact:file/notes.md]]" }]);
    await chat(session.id, { message: "再提一次" });

    expect(repairRequests()).toHaveLength(0);
    expect(readFileSync(join(sessionDirPath, "notes.md"), "utf8")).toBe("user bytes");
  });

  it("does not overwrite a file that is already there", async () => {
    const { session, sessionDirPath } = await freshSession();
    llm.setTurns([
      {
        content: "写入。",
        toolCalls: [{ name: "write_file", args: { path: "notes.md", content: "original" } }],
      },
      { content: "完成。" },
    ]);
    await chat(session.id, { message: "写个文件" });
    expect(readFileSync(join(sessionDirPath, "notes.md"), "utf8")).toBe("original");

    llm.setTurns([{ content: "见 [[artifact:file/notes.md]]" }]);
    const before = repairRequests().length;
    await chat(session.id, { message: "再提一次" });

    // The automatic pass skipped the existing file rather than replacing the user's bytes.
    expect(repairRequests().length).toBe(before);
    expect(readFileSync(join(sessionDirPath, "notes.md"), "utf8")).toBe("original");
    const persisted = await messagesOf(session.id);
    expect(persisted.at(-1)!.toolCalls ?? []).toHaveLength(0);
  });
});

describe("POST /api/sessions/:id/messages/:messageId/artifacts/repair", () => {
  it("completes one dangling marker by hand, in place", async () => {
    const { session, sessionDirPath } = await freshSession();
    llm.setTurns([{ content: "见图：\n\n[[artifact:diagram/late]]\n\n以上。" }]);
    await chat(session.id, { message: "画个图" });

    const assistant = (await messagesOf(session.id)).at(-1)!;
    const start = assistant.content.indexOf("[[artifact:diagram/late]]");
    expect(start).toBeGreaterThan(-1);

    llm.setTurns([
      {
        toolCalls: [
          { name: "ila_diagram", args: { name: "late", source: FLOW, summary: "手动的图" } },
        ],
      },
    ]);
    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${assistant.id}/artifacts/repair`,
      payload: { start },
    });

    expect(res.statusCode).toBe(200);
    const { message } = res.json<{ message: Message }>();
    expect(message.toolCalls).toHaveLength(1);
    expect(message.toolCalls![0]!.name).toBe("ila_diagram");
    expect(message.content).toContain("[[artifact:diagram/late]]");
    expect(existsSync(join(sessionDirPath, "late.mmd"))).toBe(true);

    // A second press is refused rather than producing a duplicate: the marker is answered now.
    const again = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${assistant.id}/artifacts/repair`,
      payload: { start },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("ARTIFACT_NOT_FOUND");
  });

  it("asks before overwriting a file that already exists", async () => {
    const { session, sessionDirPath } = await freshSession();
    llm.setTurns([
      {
        content: "写入。",
        toolCalls: [{ name: "write_file", args: { path: "notes.md", content: "original" } }],
      },
      { content: "完成。" },
    ]);
    await chat(session.id, { message: "写个文件" });

    llm.setTurns([{ content: "见 [[artifact:file/notes.md]]" }]);
    await chat(session.id, { message: "再提一次" });
    const assistant = (await messagesOf(session.id)).at(-1)!;
    const start = assistant.content.indexOf("[[artifact:file/notes.md]]");

    llm.setTurns([
      {
        toolCalls: [{ name: "write_file", args: { path: "notes.md", content: "repaired" } }],
      },
    ]);

    const refused = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${assistant.id}/artifacts/repair`,
      payload: { start },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("ARTIFACT_EXISTS");
    expect(readFileSync(join(sessionDirPath, "notes.md"), "utf8")).toBe("original");

    const accepted = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${assistant.id}/artifacts/repair`,
      payload: { start, overwrite: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(readFileSync(join(sessionDirPath, "notes.md"), "utf8")).toBe("repaired");
  });
});

describe("repairArtifactMarker", () => {
  it("refuses when the marker's tool is not assembled", async () => {
    await expect(
      repairArtifactMarker({
        userId: "u",
        workspaceSlug: "w",
        sessionId: "s",
        defaultLocation: "session",
        content: "[[artifact:diagram/x]]",
        marker: { kind: "diagram", handle: "x", start: 0, end: 22, startLine: 0 },
        tools: [],
        repairer: async () => ({ name: "x", source: "a", summary: "b" }),
      })
    ).rejects.toThrow(/not available/);
  });
});
