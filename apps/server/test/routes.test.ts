import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@ilearnassist/shared";
import type {
  ApiErrorBody,
  Attachment,
  Copilot,
  DirectoryListing,
  FileContent,
  ProviderConfig,
  Session,
  Workspace,
} from "@ilearnassist/shared";
import { keylessProvider, newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * API-level integration tests. The whole stack is real — Fastify, the sqlite database, the
 * workspace sandbox, the attachment store — with one throwaway temp directory per file.
 * `inject()` is used throughout, so no port is bound and nothing is written outside the
 * temp root.
 */

let env: TestEnv;

beforeAll(async () => {
  env = await startTestServer({
    providers: [keylessProvider("test"), { ...keylessProvider("second"), id: "second", name: "Second" }],
    defaultProvider: "test",
    defaultModel: "fake-model",
  });
});

afterAll(async () => {
  await env.cleanup();
});

/**
 * `TestEnv["server"]["app"]["inject"]` is overloaded, so its parameter type cannot be
 * derived with `Parameters<>`. Declaring the shape instead lets TypeScript pick the right
 * overload and keeps the response typed.
 */
const inject = (options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: object;
}) => env.inject(options);

describe("GET /api/health and /api/config", () => {
  it("reports health", async () => {
    const res = await inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("publishes the bootstrap config", async () => {
    const config = (await inject({ method: "GET", url: "/api/config" })).json<{
      defaultProvider: string;
      defaultModel: string;
      providers: ProviderConfig[];
      workspacesRootDir: string;
      webSearchProvider: string;
    }>();

    expect(config.defaultProvider).toBe("test");
    expect(config.defaultModel).toBe("fake-model");
    expect(config.workspacesRootDir).toBe(env.workspacesRoot);
    expect(config.webSearchProvider).toBe("bing");
    expect(config.providers.map((p) => p.id).sort()).toEqual(["second", "test"]);
  });

  it("never exposes an API key, only whether one is set", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "With Key", baseURL: "https://x.test/v1", apiKey: "super-secret" },
    });
    expect(res.statusCode).toBe(201);

    // Not in the create response…
    expect(res.body).not.toContain("super-secret");
    expect(res.json<ProviderConfig>().hasApiKey).toBe(true);
    // …and not in any listing either.
    const listed = await inject({ method: "GET", url: "/api/providers" });
    expect(listed.body).not.toContain("super-secret");
    expect(listed.json<ProviderConfig[]>().find((p) => p.name === "With Key")!.hasApiKey).toBe(true);
  });
});

describe("workspaces", () => {
  it("requires a name", async () => {
    expect((await inject({ method: "POST", url: "/api/workspaces", payload: {} })).statusCode).toBe(400);
    expect(
      (await inject({ method: "POST", url: "/api/workspaces", payload: { name: "   " } })).statusCode
    ).toBe(400);
  });

  it("creates a workspace and its directory on disk", async () => {
    const res = await inject({ method: "POST", url: "/api/workspaces", payload: { name: "My Notes" } });
    expect(res.statusCode).toBe(201);

    const workspace = res.json<Workspace>();
    expect(workspace.slug).toBe("my-notes");
    expect(workspace.dirPath).toBe(join(env.workspacesRoot, "my-notes"));
    expect(existsSync(workspace.dirPath)).toBe(true);
  });

  it("de-duplicates a colliding slug", async () => {
    const first = (await inject({ method: "POST", url: "/api/workspaces", payload: { name: "Dup" } })).json<Workspace>();
    const second = (await inject({ method: "POST", url: "/api/workspaces", payload: { name: "Dup" } })).json<Workspace>();
    expect(second.slug).toBe("dup-1");
    expect(second.dirPath).not.toBe(first.dirPath);
  });

  it("lists workspaces and returns 404 for a missing one on delete", async () => {
    expect((await inject({ method: "GET", url: "/api/workspaces" })).json<Workspace[]>().length).toBeGreaterThan(0);
    expect((await inject({ method: "DELETE", url: "/api/workspaces/nope" })).statusCode).toBe(404);
  });

  it("removes the directory when the workspace is deleted", async () => {
    const workspace = await newWorkspace(env, "Disposable");
    writeFileSync(join(workspace.dirPath, "note.txt"), "x");

    const res = await inject({ method: "DELETE", url: `/api/workspaces/${workspace.id}` });
    expect(res.statusCode).toBe(200);
    expect(existsSync(workspace.dirPath)).toBe(false);
  });

  /**
   * The workspace cards are built from these two numbers, so they are asserted at the API
   * boundary rather than only through the query that produces them.
   */
  it("reports each workspace's conversation count and last activity", async () => {
    const empty = await newWorkspace(env, "Nothing Here");
    const busy = await newWorkspace(env, "Talked In");
    await newSession(env, busy.id);
    await newSession(env, busy.id);

    const listed = (await inject({ method: "GET", url: "/api/workspaces" })).json<Workspace[]>();
    const emptyEntry = listed.find((w) => w.id === empty.id)!;
    const busyEntry = listed.find((w) => w.id === busy.id)!;

    // The LEFT JOIN is what keeps the empty one in the list at all — it is exactly the
    // workspace a user has just made and is looking for.
    expect(emptyEntry).toBeDefined();
    expect(emptyEntry.sessionCount).toBe(0);
    expect(emptyEntry.lastActivityAt).toBeNull();

    expect(busyEntry.sessionCount).toBe(2);
    expect(busyEntry.lastActivityAt).toBeTruthy();
  });

  it("renames a workspace without moving it on disk", async () => {
    const workspace = await newWorkspace(env, "Before");
    await newSession(env, workspace.id);

    const res = await inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.id}`,
      payload: { name: "  After  " },
    });
    expect(res.statusCode).toBe(200);

    const renamed = res.json<Workspace>();
    expect(renamed.name).toBe("After");
    // The slug and the directory are the workspace's identity: a rename that moved files
    // would break every path the agent had already written into a conversation.
    expect(renamed.slug).toBe(workspace.slug);
    expect(renamed.dirPath).toBe(workspace.dirPath);
    expect(existsSync(workspace.dirPath)).toBe(true);
    // And the response carries the card's numbers, so replacing the entry in the store does
    // not blank the count the user was just looking at.
    expect(renamed.sessionCount).toBe(1);

    const listed = (await inject({ method: "GET", url: "/api/workspaces" })).json<Workspace[]>();
    expect(listed.find((w) => w.id === workspace.id)?.name).toBe("After");
  });

  it("refuses a blank rename, and 404s an unknown workspace", async () => {
    const workspace = await newWorkspace(env, "Keep");

    const blank = await inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.id}`,
      payload: { name: "   " },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json<ApiErrorBody>().error.code).toBe("NAME_REQUIRED");

    const missing = await inject({
      method: "PATCH",
      url: "/api/workspaces/nope",
      payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);

    // The blank attempt left the name alone.
    const listed = (await inject({ method: "GET", url: "/api/workspaces" })).json<Workspace[]>();
    expect(listed.find((w) => w.id === workspace.id)?.name).toBe("Keep");
  });
});

describe("workspace files", () => {
  /**
   * A workspace with a couple of things in it, written straight into `workdir/`.
   *
   * That is the directory the browser lists and the agent is sandboxed to — not the
   * workspace's own directory above it, which holds `workdir/` and `sessions/` and is
   * therefore not something the browser ever shows.
   */
  async function seededWorkspace() {
    const workspace = await newWorkspace(env, "Files");
    writeFileSync(join(workspace.workdirPath, "notes.md"), "# Notes\n");
    writeFileSync(join(workspace.workdirPath, "app.ts"), "export const x = 1;\n");
    return workspace;
  }

  it("lists the workspace root", async () => {
    const workspace = await seededWorkspace();

    const res = await inject({ method: "GET", url: `/api/workspaces/${workspace.id}/files` });
    expect(res.statusCode).toBe(200);

    const listing = res.json<DirectoryListing>();
    expect(listing.path).toBe("");
    expect(listing.entries.map((e) => e.name)).toEqual(["app.ts", "notes.md"]);
    expect(listing.truncated).toBe(false);
  });

  it("lists one level, keyed by the path it was asked for", async () => {
    const workspace = await seededWorkspace();
    mkdirSync(join(workspace.workdirPath, "src"));
    writeFileSync(join(workspace.workdirPath, "src", "index.ts"), "x");

    const res = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files?path=${encodeURIComponent("src")}`,
    });
    expect(res.json<DirectoryListing>().entries.map((e) => e.path)).toEqual(["src/index.ts"]);
  });

  it("returns a text file and a markdown file differently", async () => {
    const workspace = await seededWorkspace();

    const md = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/content?path=notes.md`,
    });
    expect(md.json<FileContent>()).toMatchObject({ kind: "markdown", text: "# Notes\n" });

    const ts = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/content?path=app.ts`,
    });
    expect(ts.json<FileContent>()).toMatchObject({ kind: "text", truncated: false });
  });

  it("reports a file it will not render without sending its bytes", async () => {
    const workspace = await seededWorkspace();
    writeFileSync(join(workspace.workdirPath, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const res = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/content?path=shot.png`,
    });
    expect(res.json<FileContent>()).toMatchObject({ kind: "unsupported", text: null });
  });

  it("404s a workspace that does not exist", async () => {
    const res = await inject({ method: "GET", url: "/api/workspaces/nope/files" });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiErrorBody>().error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("400s a path that escapes the workspace, and a missing file differently", async () => {
    const workspace = await seededWorkspace();

    const escape = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files?path=${encodeURIComponent("../..")}`,
    });
    expect(escape.statusCode).toBe(400);
    expect(escape.json<ApiErrorBody>().error.code).toBe("INVALID_FILE_PATH");

    const missing = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/content?path=gone.txt`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiErrorBody>().error.code).toBe("FILE_NOT_FOUND");
  });

  it("400s asking a file for its children", async () => {
    const workspace = await seededWorkspace();
    const res = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files?path=notes.md`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("NOT_A_DIRECTORY");
  });
});

describe("copilots", () => {
  it("requires a name", async () => {
    expect((await inject({ method: "POST", url: "/api/copilots", payload: {} })).statusCode).toBe(400);
  });

  it("creates, updates and deletes", async () => {
    const created = (
      await inject({
        method: "POST",
        url: "/api/copilots",
        payload: { name: "Tutor", systemPrompt: "Teach.", tools: ["read_file"], settings: { temperature: 0.5 } },
      })
    ).json<Copilot>();
    expect(created).toMatchObject({ name: "Tutor", tools: ["read_file"] });

    const updated = (
      await inject({
        method: "PUT",
        url: `/api/copilots/${created.id}`,
        payload: { name: "Coach", systemPrompt: "Coach.", tools: [], settings: {} },
      })
    ).json<Copilot>();
    expect(updated.name).toBe("Coach");

    expect((await inject({ method: "DELETE", url: `/api/copilots/${created.id}` })).statusCode).toBe(200);
    expect((await inject({ method: "GET", url: "/api/copilots" })).json<Copilot[]>().some((c) => c.id === created.id)).toBe(false);
  });

  it("returns 404 when updating a missing copilot", async () => {
    const res = await inject({
      method: "PUT",
      url: "/api/copilots/nope",
      payload: { name: "x", systemPrompt: "" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("sessions", () => {
  it("404s for an unknown workspace", async () => {
    expect((await inject({ method: "GET", url: "/api/workspaces/nope/sessions" })).statusCode).toBe(404);
    expect(
      (await inject({ method: "POST", url: "/api/workspaces/nope/sessions", payload: {} })).statusCode
    ).toBe(404);
  });

  it("starts untitled and copies the copilot's defaults in", async () => {
    const workspace = await newWorkspace(env);
    const copilot = (
      await inject({
        method: "POST",
        url: "/api/copilots",
        payload: { name: "WithDefaults", systemPrompt: "", settings: { temperature: 0.2, maxSteps: 4 } },
      })
    ).json<Copilot>();

    const session = await newSession(env, workspace.id, { copilotId: copilot.id });
    expect(session.title).toBe("New conversation");
    expect(session.titleSource).toBe("auto");
    expect(session.settings).toMatchObject({ temperature: 0.2, maxSteps: 4 });

    // Copied, not referenced: editing the Copilot must not move existing conversations.
    await inject({
      method: "PUT",
      url: `/api/copilots/${copilot.id}`,
      payload: { name: "WithDefaults", systemPrompt: "", settings: { temperature: 1.5 } },
    });
    const reread = (await inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions` })).json<Session[]>();
    expect(reread.find((s) => s.id === session.id)!.settings).toMatchObject({ temperature: 0.2 });
  });

  it("accepts a title at creation time", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id, { title: "  Named Up Front  " });
    expect(session.title).toBe("Named Up Front");
  });

  it("renames and marks the session as user-titled", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    const renamed = (
      await inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "  Hand Written  " } })
    ).json<Session>();
    expect(renamed.title).toBe("Hand Written");
    expect(renamed.titleSource).toBe("user");
  });

  it("rejects an empty title and a missing session", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    expect(
      (await inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "   " } })).statusCode
    ).toBe(400);
    expect((await inject({ method: "PATCH", url: "/api/sessions/nope", payload: { title: "x" } })).statusCode).toBe(404);
  });

  it("updates settings without touching the title", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id, { title: "Keep Me" });

    const updated = (
      await inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { settings: { maxSteps: 3 } } })
    ).json<Session>();
    expect(updated.title).toBe("Keep Me");
    expect(updated.settings).toMatchObject({ maxSteps: 3 });
  });

  it("404s message listing for an unknown session", async () => {
    expect((await inject({ method: "GET", url: "/api/sessions/nope/messages" })).statusCode).toBe(404);
  });

  it("cascades messages and uploads away with the session", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    const attachment = (
      await inject({
        method: "POST",
        url: `/api/sessions/${session.id}/attachments`,
        payload: { name: "a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
      })
    ).json<Attachment>();
    expect(existsSync(join(env.uploadsRoot, session.id))).toBe(true);

    await inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
    expect(existsSync(join(env.uploadsRoot, session.id))).toBe(false);
    expect(attachment.id).toBeTruthy();
  });
});

describe("providers", () => {
  it("validates name and baseURL", async () => {
    expect((await inject({ method: "POST", url: "/api/providers", payload: { baseURL: "https://x" } })).statusCode).toBe(400);
    expect((await inject({ method: "POST", url: "/api/providers", payload: { name: "x" } })).statusCode).toBe(400);
  });

  it("creates a provider together with its models", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "Fresh",
        baseURL: "https://fresh.test/v1",
        models: [{ modelId: "m1", name: "M1", contextWindow: 8192, capabilities: ["tool_use"] }],
      },
    });

    const provider = res.json<ProviderConfig>();
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]).toMatchObject({ modelId: "m1", contextWindow: 8192 });
  });

  it("rejects a model payload with no modelId", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "Bad", baseURL: "https://bad.test", models: [{ name: "no id" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown provider", async () => {
    expect((await inject({ method: "PUT", url: "/api/providers/nope", payload: { name: "x" } })).statusCode).toBe(404);
    expect((await inject({ method: "DELETE", url: "/api/providers/nope" })).statusCode).toBe(404);
    expect((await inject({ method: "DELETE", url: "/api/providers/nope/models/m" })).statusCode).toBe(404);
  });

  it("keeps the stored key when the update omits the field", async () => {
    // This is what lets the UI edit a provider whose key it is never allowed to read back.
    const provider = (
      await inject({ method: "POST", url: "/api/providers", payload: { name: "Keeper", baseURL: "https://k.test", apiKey: "k1" } })
    ).json<ProviderConfig>();

    const updated = (
      await inject({ method: "PUT", url: `/api/providers/${provider.id}`, payload: { name: "Renamed" } })
    ).json<ProviderConfig>();
    expect(updated.name).toBe("Renamed");
    expect(updated.hasApiKey).toBe(true);

    // An explicitly empty key clears it.
    const cleared = (
      await inject({ method: "PUT", url: `/api/providers/${provider.id}`, payload: { apiKey: "" } })
    ).json<ProviderConfig>();
    expect(cleared.hasApiKey).toBe(false);
  });

  it("adds and edits models in one PUT", async () => {
    const provider = (
      await inject({
        method: "POST",
        url: "/api/providers",
        payload: { name: "Multi", baseURL: "https://multi.test", models: [{ modelId: "a" }] },
      })
    ).json<ProviderConfig>();

    const existingId = provider.models[0]!.id;
    const updated = (
      await inject({
        method: "PUT",
        url: `/api/providers/${provider.id}`,
        payload: { models: [{ id: existingId, modelId: "a-renamed" }, { modelId: "b" }] },
      })
    ).json<ProviderConfig>();

    expect(updated.models.map((m) => m.modelId).sort()).toEqual(["a-renamed", "b"]);
  });

  it("rejects a model id that does not belong to this provider", async () => {
    const provider = (
      await inject({ method: "POST", url: "/api/providers", payload: { name: "Own", baseURL: "https://own.test" } })
    ).json<ProviderConfig>();

    const res = await inject({
      method: "PUT",
      url: `/api/providers/${provider.id}`,
      payload: { models: [{ id: "someone-elses-model", modelId: "x" }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to delete the only provider", async () => {
    // Everything else in this file depends on at least one provider existing, so this
    // uses a dedicated server rather than mutating the shared one.
    const solo = await startTestServer({ providers: [keylessProvider("only")], defaultProvider: "only", defaultModel: "fake-model" });
    try {
      const res = await solo.inject({ method: "DELETE", url: "/api/providers/only" });
      expect(res.statusCode).toBe(409);
      expect(res.json<ApiErrorBody>().error.code).toBe("ONLY_PROVIDER");
    } finally {
      await solo.cleanup();
    }
  });

  it("refuses to delete the default provider", async () => {
    const res = await inject({ method: "DELETE", url: "/api/providers/test" });
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiErrorBody>().error.code).toBe("DEFAULT_PROVIDER");
  });

  it("deletes a non-default provider and its models", async () => {
    const provider = (
      await inject({
        method: "POST",
        url: "/api/providers",
        payload: { name: "Doomed", baseURL: "https://doomed.test", models: [{ modelId: "m" }] },
      })
    ).json<ProviderConfig>();
    const modelId = provider.models[0]!.id;

    expect((await inject({ method: "DELETE", url: `/api/providers/${provider.id}` })).statusCode).toBe(200);
    // The model went with it, so deleting it again is a 404.
    expect((await inject({ method: "DELETE", url: `/api/providers/${provider.id}/models/${modelId}` })).statusCode).toBe(404);
  });

  it("deletes a single model and returns the updated provider", async () => {
    const provider = (
      await inject({
        method: "POST",
        url: "/api/providers",
        payload: { name: "Trimmer", baseURL: "https://trim.test", models: [{ modelId: "keep" }, { modelId: "drop" }] },
      })
    ).json<ProviderConfig>();

    const dropId = provider.models.find((m) => m.modelId === "drop")!.id;
    const after = (
      await inject({ method: "DELETE", url: `/api/providers/${provider.id}/models/${dropId}` })
    ).json<ProviderConfig>();
    expect(after.models.map((m) => m.modelId)).toEqual(["keep"]);

    expect((await inject({ method: "DELETE", url: `/api/providers/${provider.id}/models/nope` })).statusCode).toBe(404);
  });
});

describe("PUT /api/defaults", () => {
  it("rejects an unknown provider", async () => {
    const res = await inject({ method: "PUT", url: "/api/defaults", payload: { providerId: "nope" } });
    expect(res.statusCode).toBe(400);
  });

  it("switches the default provider and model", async () => {
    const config = (
      await inject({ method: "PUT", url: "/api/defaults", payload: { providerId: "second", modelId: "m9" } })
    ).json<{ defaultProvider: string; defaultModel: string }>();
    expect(config.defaultProvider).toBe("second");
    expect(config.defaultModel).toBe("m9");

    // Put it back so later tests see the original default.
    await inject({ method: "PUT", url: "/api/defaults", payload: { providerId: "test", modelId: "fake-model" } });
  });
});

describe("attachments", () => {
  let session: Session;

  beforeEach(async () => {
    const workspace = await newWorkspace(env);
    session = await newSession(env, workspace.id);
  });

  const upload = (payload: object) =>
    inject({ method: "POST", url: `/api/sessions/${session.id}/attachments`, payload });

  it("404s for an unknown session", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/sessions/nope/attachments",
      payload: { name: "a.txt", mimeType: "text/plain", data: "aGk=" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires a name and data", async () => {
    expect((await upload({ mimeType: "text/plain", data: "aGk=" })).statusCode).toBe(400);
    expect((await upload({ name: "a.txt", mimeType: "text/plain" })).statusCode).toBe(400);
  });

  it("rejects an unsupported file type", async () => {
    const res = await upload({ name: "archive.zip", mimeType: "application/zip", data: "aGk=" });
    expect(res.statusCode).toBe(415);
    const body = res.json<ApiErrorBody>();
    expect(body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    // The client renders the parameter itself, so it must survive the trip.
    expect(body.error.params).toEqual({ mimeType: "application/zip" });
  });

  it("falls back to the extension when the browser sends no usable MIME type", async () => {
    const res = await upload({
      name: "notes.md",
      mimeType: "application/octet-stream",
      data: Buffer.from("# Title").toString("base64"),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Attachment>()).toMatchObject({ mimeType: "text/markdown", kind: "file" });
  });

  it("stores the bytes and reports the size", async () => {
    const attachment = (
      await upload({ name: "a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") })
    ).json<Attachment>();

    expect(attachment).toMatchObject({ name: "a.txt", mimeType: "text/plain", size: 5, kind: "file" });
    expect(readFileSync(join(env.uploadsRoot, session.id, `${attachment.id}.txt`), "utf8")).toBe("hello");
  });

  it("classifies an image as an image", async () => {
    const attachment = (
      await upload({ name: "p.png", mimeType: "image/png", data: Buffer.from("png").toString("base64") })
    ).json<Attachment>();
    expect(attachment.kind).toBe("image");
  });

  it("rejects data that decodes to nothing", async () => {
    // `Buffer.from(x, 'base64')` never throws — it drops unmappable characters — so
    // garbage surfaces as an empty file rather than as a decode error.
    const res = await upload({ name: "a.txt", mimeType: "text/plain", data: "!!!!" });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("EMPTY_FILE");
  });

  it("rejects a file over the size cap", async () => {
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "a").toString("base64");
    const res = await upload({ name: "big.txt", mimeType: "text/plain", data: oversized });
    expect(res.statusCode).toBe(413);
  });

  it("serves the bytes back with the right type and a long cache", async () => {
    const attachment = (
      await upload({ name: "a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") })
    ).json<Attachment>();

    const res = await inject({
      method: "GET",
      url: `/api/sessions/${session.id}/attachments/${attachment.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.body).toBe("hello");
  });

  it("404s for an unknown attachment", async () => {
    expect((await inject({ method: "GET", url: `/api/sessions/${session.id}/attachments/nope` })).statusCode).toBe(404);
  });

  it("refuses a traversal attempt in the attachment id", async () => {
    const res = await inject({
      method: "GET",
      url: `/api/sessions/${session.id}/attachments/${encodeURIComponent("../../../../etc/passwd")}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
