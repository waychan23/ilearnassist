import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { EXPLORE_KINDS } from "@ilearnassist/shared";
import { DEFAULT_SESSION_TITLE, createDb, type AppDb } from "../../src/db.js";
import type { ResolvedScope } from "../../src/workspaceScope.js";
import { buildExploreTool, EXPLORE_MESSAGE_MAX } from "../../src/tools/explore.js";

/**
 * `ila_explore` — the one tool that reads across workspaces, and therefore the one whose
 * boundary has to be right rather than merely close.
 *
 * Three claims are pinned here and they are different ones:
 *
 * 1. **It can only read.** Nothing in the module writes, and every path resolves against a
 *    granted workspace's shared folder — including through a symlink, which is the one case the
 *    file tools deliberately allow and this tool deliberately does not.
 * 2. **The grant is the gate.** A workspace id outside it is refused before a path exists, and a
 *    conversation outside it is refused even though it belongs to the caller: ownership and the
 *    grant are different questions and both are asked.
 * 3. **A transcript cannot blow the page.** Tool output and chain of thought are stripped rather
 *    than clipped, because both are unbounded and neither is what a reader came for.
 */

let root: string;
let db: AppDb;

const OWNER = "u1";
const GRANTED = "wGranted";
const CLOSED = "wClosed";
const SESSION_HERE = "sHere";

let scope: ResolvedScope;

/** Where the granted workspace's shared folder is, so the cases can put files in it. */
let grantedWorkdir: string;
/** Outside every granted workspace, and therefore reachable only through a symlink. */
let outsideDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-explore-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });

  const dirs: Record<string, string> = {};
  for (const [id, name, slug] of [
    [GRANTED, "Granted", "granted"],
    [CLOSED, "Closed", "closed"],
  ] as const) {
    const dirPath = join(root, slug);
    dirs[id] = dirPath;
    db.createWorkspace({ userId: OWNER, id, name, slug, dirPath });
  }
  grantedWorkdir = join(dirs[GRANTED]!, "workdir");
  outsideDir = join(root, "outside");
  mkdirSync(grantedWorkdir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  for (const [id, workspaceId] of [
    [SESSION_HERE, CLOSED],
    ["sGranted", GRANTED],
  ] as const) {
    db.createSession({
      id,
      workspaceId,
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: `Conversation ${id}`,
    });
  }

  scope = {
    all: false,
    workspaces: [{ id: GRANTED, name: "Granted", workdirPath: grantedWorkdir }],
  };
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/** The tool, invoked, with its answer parsed — every kind but `file` returns JSON. */
async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = buildExploreTool({ db, userId: OWNER, scope });
  return JSON.parse((await tool.invoke(args)) as string) as Record<string, unknown>;
}

/** The same, for the kinds whose answer is prose rather than JSON. */
async function callText(args: Record<string, unknown>): Promise<string> {
  const tool = buildExploreTool({ db, userId: OWNER, scope });
  return (await tool.invoke(args)) as string;
}

/** The refusal a rejected call produces, as the model would read it. */
async function refusal(args: Record<string, unknown>): Promise<string> {
  return callText(args).catch((e: Error) => e.message);
}

describe("ila_explore — the wire schema", () => {
  it("converts to a top-level object", () => {
    /*
     * The `ila_query` trap, restated for this tool: a `z.discriminatedUnion` serialises to
     * `{"anyOf": […], "type": null}`, and a strict OpenAI-compatible endpoint refuses it on
     * EVERY turn where the tool is offered — called or not. The flat object is the shape that
     * survives, and this is what says so.
     */
    const tool = buildExploreTool({ db, userId: OWNER, scope });
    const schema = toJsonSchema(tool.schema as never) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    const kind = (schema.properties as Record<string, { enum?: string[] }>).kind;
    expect(kind?.enum).toEqual([...EXPLORE_KINDS]);
  });

  it("refuses a field that belongs to another kind, naming it", () => {
    // Zod strips unknown keys, so without `checkFields` this would return the workspace list
    // and never say that the `path` went nowhere — a filter that looks applied and is not.
    return expect(call({ kind: "workspaces", path: "notes" })).rejects.toThrow(/"path"/);
  });
});

describe("ila_explore — the grant is the gate", () => {
  it("lists the granted workspaces, and says which ids address them", async () => {
    const out = await call({ kind: "workspaces" });
    expect(out.all).toBe(false);
    expect(out.workspaces).toEqual([{ id: GRANTED, name: "Granted" }]);
  });

  it("refuses a workspace that was not opened", async () => {
    const message = await refusal({ kind: "files", workspaceId: CLOSED });
    expect(message).toContain("not a workspace opened");
    expect(message).toContain(GRANTED);
  });

  it("refuses a conversation outside the grant, though it is the caller's own", async () => {
    // Ownership and the grant are two questions. This conversation belongs to the caller and is
    // in a workspace nobody opened, so it is unreachable — which is the difference between
    // `getSessionForUser` and the grant, and the reason both are asked.
    const message = await refusal({ kind: "messages", sessionId: SESSION_HERE });
    expect(message).toContain("not opened to this conversation");
  });

  it("refuses a conversation that does not exist at all", async () => {
    expect(await refusal({ kind: "messages", sessionId: "nope" })).toContain("No conversation");
  });
});

describe("ila_explore — sessions", () => {
  it("lists the conversations inside the granted workspace, and no others", async () => {
    const out = await call({ kind: "sessions" });
    const ids = (out.items as { sessionId: string }[]).map((s) => s.sessionId);
    expect(ids).toContain("sGranted");
    expect(ids).not.toContain(SESSION_HERE);
  });

  it("filters by title", async () => {
    db.updateSessionForUser("sGranted", OWNER, { title: "递归的入门" });
    expect((await call({ kind: "sessions", query: "递归" })).total).toBe(1);
    expect((await call({ kind: "sessions", query: "不存在的标题" })).total).toBe(0);
  });
});

describe("ila_explore — messages", () => {
  beforeEach(() => {
    db.createMessage({
      id: "m1",
      sessionId: "sGranted",
      role: "user",
      content: "什么是递归？",
    });
    db.createMessage({
      id: "m2",
      sessionId: "sGranted",
      role: "assistant",
      content: "递归就是自己调用自己。",
      reasoning: "SECRET-CHAIN-OF-THOUGHT",
      toolCalls: [
        // A call that ran to completion: it carries an `output` and no `status`, because
        // `status` is the *suspension* lifecycle and only a suspended call has one.
        {
          id: "call_1",
          name: "read_file",
          input: JSON.stringify({ path: "big.txt" }),
          output: "X".repeat(40_000),
        },
      ],
      attachments: [
        { id: "att-1", resourceId: "res-1", name: "lecture.pdf", mimeType: "application/pdf", size: 1, kind: "file" },
      ],
    });
  });

  it("reads a conversation's messages in order", async () => {
    const out = await call({ kind: "messages", sessionId: "sGranted" });
    const items = out.items as { id: string; role: string; content: string }[];
    expect(items.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(items[1]!.content).toContain("自己调用自己");
  });

  it("strips tool output, which is the one unbounded thing in a transcript", async () => {
    // A single `read_file` result is up to 40 000 characters, and a long conversation is full
    // of them. The name and whether it produced a result say what happened; the result itself
    // is re-readable where it ran.
    const raw = await callText({ kind: "messages", sessionId: "sGranted" });
    expect(raw).not.toContain("XXXX");
    expect(raw).not.toContain("big.txt");
    expect(raw).toContain("read_file");
    expect(raw).toContain('"completed": true');
  });

  it("never returns chain of thought", async () => {
    // Display-only everywhere else in the app and never replayed into a model's context.
    // Returning it here would be the one place it leaks into one.
    expect(await callText({ kind: "messages", sessionId: "sGranted" })).not.toContain(
      "SECRET-CHAIN-OF-THOUGHT"
    );
  });

  it("keeps an attachment's id, because that is what read_document takes", async () => {
    const out = await call({ kind: "messages", sessionId: "sGranted" });
    const items = out.items as { attachments?: { id: string; name: string }[] }[];
    expect(items[1]!.attachments).toEqual([{ id: "att-1", name: "lecture.pdf" }]);
  });

  it("clips a message body rather than the page", async () => {
    db.createMessage({
      id: "m3",
      sessionId: "sGranted",
      role: "user",
      content: "长".repeat(5_000),
    });
    const out = await call({ kind: "messages", sessionId: "sGranted", limit: 3 });
    const items = out.items as { content: string }[];
    expect(items[2]!.content.length).toBeLessThanOrEqual(EXPLORE_MESSAGE_MAX + 1);
  });

  it("pages, and says so when it has", async () => {
    const page = await call({ kind: "messages", sessionId: "sGranted", limit: 1 });
    expect(page.returned).toBe(1);
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(true);
    expect(String(page.note)).toContain("offset");

    const second = await call({ kind: "messages", sessionId: "sGranted", limit: 1, offset: 1 });
    expect((second.items as { id: string }[])[0]!.id).toBe("m2");
  });
});

describe("ila_explore — files", () => {
  beforeEach(() => {
    writeFileSync(join(grantedWorkdir, "notes.md"), "# 递归");
    mkdirSync(join(grantedWorkdir, "sub"), { recursive: true });
    writeFileSync(join(grantedWorkdir, "sub", "deep.txt"), "深层");
  });

  it("lists one directory level, directories first", async () => {
    const out = await call({ kind: "files", workspaceId: GRANTED });
    expect((out.entries as { name: string }[]).map((e) => e.name)).toEqual(["sub", "notes.md"]);
  });

  it("lists a subdirectory by path", async () => {
    const out = await call({ kind: "files", workspaceId: GRANTED, path: "sub" });
    expect((out.entries as { name: string }[])[0]!.name).toBe("sub/deep.txt");
  });

  it("refuses a path that climbs out of the workspace", async () => {
    expect(await refusal({ kind: "files", workspaceId: GRANTED, path: ".." })).toContain(
      "outside the workspace sandbox"
    );
  });

  it("refuses a symlink that points out of the workspace", async () => {
    /*
     * The one place this tool is *stricter* than the file tools, and it has to be.
     *
     * `resolveInWorkspace` is purely lexical and its docblock justifies that with "the model has
     * no tool that makes a symlink, so one can only be there because the user put it there" —
     * an argument about the user's own machine. It does not survive this feature: a symlink in a
     * granted workspace becomes a read path out of somebody else's conversation into material
     * they deliberately did not open.
     */
    writeFileSync(join(outsideDir, "secret.txt"), "SECRET");
    symlinkSync(outsideDir, join(grantedWorkdir, "escape"));

    expect(await refusal({ kind: "files", workspaceId: GRANTED, path: "escape" })).toContain(
      "outside that workspace"
    );
    expect(
      await refusal({ kind: "file", workspaceId: GRANTED, path: "escape/secret.txt" })
    ).toContain("outside that workspace");
  });
});

describe("ila_explore — file", () => {
  beforeEach(() => {
    writeFileSync(join(grantedWorkdir, "notes.md"), "0123456789".repeat(10));
    writeFileSync(join(grantedWorkdir, "binary.bin"), "PK  binary");
  });

  it("reads a text file, naming what it read", async () => {
    const out = await callText({ kind: "file", workspaceId: GRANTED, path: "notes.md" });
    expect(out).toContain("Granted/notes.md");
    expect(out).toContain("0123456789");
  });

  it("pages a long file and says where to continue", async () => {
    const out = await callText({
      kind: "file",
      workspaceId: GRANTED,
      path: "notes.md",
      limit: 30,
    });
    expect(out).toContain("read 0–30 of 100 characters");
    expect(out).toContain("offset=30");
  });

  it("says where the end is instead of inviting another call", async () => {
    const out = await callText({
      kind: "file",
      workspaceId: GRANTED,
      path: "notes.md",
      offset: 90,
      limit: 50,
    });
    expect(out).toContain("end of file");
    expect(out).not.toContain("Call again");
  });

  it("refuses a file with a NUL byte, whatever its extension claims", async () => {
    // Bytes handed to a model as mojibake are worse than a file reported unreadable. Same test
    // the file browser's sniff uses.
    expect(await refusal({ kind: "file", workspaceId: GRANTED, path: "binary.bin" })).toContain(
      "not a text file"
    );
  });

  it("refuses a directory, pointing at the kind that lists it", async () => {
    mkdirSync(join(grantedWorkdir, "sub"), { recursive: true });
    expect(await refusal({ kind: "file", workspaceId: GRANTED, path: "sub" })).toContain(
      'use kind "files"'
    );
    // The root is the same answer arriving by a different route — the sandbox refuses it as "a
    // target path is required", which is true and unhelpful, so the tool says which kind lists
    // a folder instead.
    expect(await refusal({ kind: "file", workspaceId: GRANTED, path: "." })).toContain(
      'use kind "files"'
    );
  });

  it("requires a path", async () => {
    expect(await refusal({ kind: "file", workspaceId: GRANTED })).toContain("needs a `path`");
  });
});
