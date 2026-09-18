import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_PREVIEW_BYTES,
  MAX_UPLOAD_CEILING_BYTES,
  MIN_UPLOAD_LIMIT_BYTES,
} from "@ilearnassist/shared";
import { rawFilePath } from "../src/resourcePaths.js";
import { captureWebPage } from "../src/webCapture.js";
import { DEFAULT_SESSION_TITLE } from "../src/db.js";
import { NO_SCOPE, resolveWorkspaceScope } from "../src/workspaceScope.js";
import type {
  ApiErrorBody,
  Attachment,
  Copilot,
  DirectoryListing,
  FileContent,
  ProviderConfig,
  PublicConfig,
  WorkResource,
  Session,
  Workspace,
} from "@ilearnassist/shared";
import {
  keylessProvider,
  newSession,
  newWorkspace,
  startTestServer,
  uploadAttachment,
  type TestEnv,
} from "./helpers/tempEnv.js";

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

  it("writes the description the create form was filled in with", async () => {
    /*
     * In the create request rather than a `PATCH` after it, which is the whole point: the
     * description is typed before the workspace exists, so a second write would be a window in
     * which the card is on screen without it — and a failure between the two leaves it that way
     * for good. Asserted through a *re-read* as well as the reply, because the reply is the row
     * the insert just produced and the list is what the card grid actually renders from.
     */
    const res = await inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Described", description: "线性代数的习题与讲义" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Workspace>().description).toBe("线性代数的习题与讲义");

    const listed = await inject({ method: "GET", url: "/api/workspaces" });
    expect(
      listed.json<Workspace[]>().find((w) => w.name === "Described")?.description
    ).toBe("线性代数的习题与讲义");
  });

  it("leaves the description empty when the form did not ask for one", async () => {
    // The column is `NOT NULL DEFAULT ''` and the two are the same claim: a workspace nobody
    // described reads as an empty string rather than as a missing row field.
    const res = await inject({ method: "POST", url: "/api/workspaces", payload: { name: "Plain" } });
    expect(res.statusCode).toBe(201);
    expect(res.json<Workspace>().description).toBe("");
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

  it("starts with no description and renames and describes in one request", async () => {
    const workspace = await newWorkspace(env, "Before");
    expect(workspace.description).toBe("");

    const patched = (
      await inject({
        method: "PATCH",
        url: `/api/workspaces/${workspace.id}`,
        payload: { name: "After", description: "线性代数的习题" },
      })
    ).json<Workspace>();
    expect(patched.name).toBe("After");
    expect(patched.description).toBe("线性代数的习题");
    // Display-only, as it always was: the directory keeps the slug it was created with.
    expect(patched.slug).toBe("before");

    // Independent fields: a rename does not clear the description, and the other way round.
    const renamed = (
      await inject({
        method: "PATCH",
        url: `/api/workspaces/${workspace.id}`,
        payload: { name: "Again" },
      })
    ).json<Workspace>();
    expect(renamed.description).toBe("线性代数的习题");
    expect(
      (
        await inject({
          method: "PATCH",
          url: `/api/workspaces/${workspace.id}`,
          payload: { description: "" },
        })
      ).json<Workspace>().name
    ).toBe("Again");
  });

  it("refuses an empty workspace name even when a description comes with it", async () => {
    const workspace = await newWorkspace(env, "Named");
    const res = await inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.id}`,
      payload: { name: "  ", description: "something" },
    });
    expect(res.statusCode).toBe(400);
    // Nothing landed: the refused request is refused whole, not partially applied.
    expect(env.server.db.getWorkspaceForUser(workspace.id, env.user.id)?.description).toBe("");
  });

  it("keeps the directory, and the rows under it, when the workspace is deleted", async () => {
    // The delete hides the workspace; nothing on disk or in the tables is dismantled. That is
    // what would make a restore possible, and it is also why a re-created name cannot land on
    // the same path — `uniqueSlug` sees the directory and mints the next one.
    const workspace = await newWorkspace(env, "Disposable");
    writeFileSync(join(workspace.dirPath, "note.txt"), "x");
    const session = await newSession(env, workspace.id);

    const res = await inject({ method: "DELETE", url: `/api/workspaces/${workspace.id}` });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(workspace.dirPath, "note.txt"))).toBe(true);

    const listed = await inject({ method: "GET", url: "/api/workspaces" });
    expect(listed.json().map((w: { id: string }) => w.id)).not.toContain(workspace.id);
    const gone = await inject({ method: "GET", url: `/api/workspaces/${workspace.id}` });
    expect(gone.statusCode).toBe(404);
    // The conversation went with it, without its row being touched.
    const sessions = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/sessions`,
    });
    expect(sessions.statusCode).toBe(404);
    expect(
      env.server.db.raw
        .prepare("SELECT deleted_at FROM sessions WHERE id = ?")
        .get(session.id)
    ).toMatchObject({ deleted_at: null });

    // A second workspace with the same name gets the next free directory rather than the
    // deleted one's.
    const again = await newWorkspace(env, "Disposable");
    expect(again.dirPath).not.toBe(workspace.dirPath);
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

  it("calls a binary binary without sending its bytes", async () => {
    const workspace = await seededWorkspace();
    writeFileSync(join(workspace.workdirPath, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const res = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/content?path=shot.png`,
    });
    // The bytes come from `/files/raw`, never from here — whether anything can draw them is the
    // client's question now, and this route's answer stops at "there is no text".
    expect(res.json<FileContent>()).toMatchObject({ kind: "binary", text: null });
  });

  /*
   * The byte route. Three things about it are load-bearing and none of them is visible from the
   * reply: the type is deliberately not the file's own, the size limit is a real status rather
   * than a 400, and the sandbox still applies. Asserted on headers rather than on bytes because
   * "the bytes arrived" is what the happy path already proves.
   */
  it("serves a file's bytes as an unusable type", async () => {
    const workspace = await seededWorkspace();
    writeFileSync(join(workspace.workdirPath, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const res = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/raw?path=doc.pdf`,
    });

    expect(res.statusCode).toBe(200);
    // Never `application/pdf`, and deliberately not the `mimeType` that `/api/resources/:id/raw`
    // serves: these bytes are re-materialised into our own DOM by the office plugins.
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.rawPayload.length).toBe(4);
  });

  it("answers 413 for a file past the preview limit", async () => {
    const workspace = await seededWorkspace();
    writeFileSync(join(workspace.workdirPath, "huge.mp4"), "");
    truncateSync(join(workspace.workdirPath, "huge.mp4"), MAX_FILE_PREVIEW_BYTES + 1);

    const res = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/raw?path=huge.mp4`,
    });

    // 413 rather than 400: it is the one failure on this route the caller could have avoided by
    // asking differently, and the only status here that is not a bad request or a missing file.
    expect(res.statusCode).toBe(413);
    expect(res.json<ApiErrorBody>().error.code).toBe("FILE_TOO_LARGE");
  });

  it("refuses a file past the configured upload limit, naming it", async () => {
    /*
     * The setting in force rather than a constant, and the *sentence* is asserted as well as the
     * status: the message used to be compiled against `MAX_ATTACHMENT_BYTES`, so a server that
     * refused at 1 MB while saying "10 MB" is exactly the failure a dynamic limit introduces.
     */
    const admin = await inject({ method: "PUT", url: "/api/upload-settings", payload: { maxUploadBytes: 1024 * 1024 } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json<PublicConfig>().maxUploadBytes).toBe(1024 * 1024);

    const workspace = await seededWorkspace();
    const session = await newSession(env, workspace.id);
    const res = await inject({
      method: "POST",
      url: `/api/sessions/${session.id}/resources`,
      payload: {
        name: "big.txt",
        mimeType: "text/plain",
        data: Buffer.alloc(2 * 1024 * 1024).toString("base64"),
      },
    });

    expect(res.statusCode).toBe(413);
    const error = res.json<ApiErrorBody>().error;
    expect(error.code).toBe("FILE_TOO_LARGE");
    expect(error.params).toMatchObject({ limitMb: 1 });

    // And the workspace upload route, which used to answer the same refusal *without* the number.
    const viaWorkspace = await inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/files/upload`,
      payload: { name: "big.txt", data: Buffer.alloc(2 * 1024 * 1024).toString("base64") },
    });
    expect(viaWorkspace.statusCode).toBe(413);
    expect(viaWorkspace.json<ApiErrorBody>().error.params).toMatchObject({ limitMb: 1 });

    // Put it back, or every later test in this file inherits a 1 MB cap.
    await inject({ method: "PUT", url: "/api/upload-settings", payload: { maxUploadBytes: MAX_ATTACHMENT_BYTES } });
  });

  it("refuses an upload limit outside the range, and one that is not a whole number", async () => {
    for (const maxUploadBytes of [
      MAX_UPLOAD_CEILING_BYTES + 1,
      MIN_UPLOAD_LIMIT_BYTES - 1,
      1024 * 1024 + 0.5,
      "1048576",
      undefined,
    ]) {
      const res = await inject({ method: "PUT", url: "/api/upload-settings", payload: { maxUploadBytes } });
      expect(res.statusCode, String(maxUploadBytes)).toBe(400);
      expect(res.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");
    }
    // Refused rather than clamped: a number outside the range is a request that did not mean
    // what it said, and storing the nearest legal value would report success and deliver
    // something else.
    expect((await inject({ method: "GET", url: "/api/config" })).json<PublicConfig>().maxUploadBytes).toBe(
      MAX_ATTACHMENT_BYTES
    );
  });

  it("keeps the upload setting to administrators", async () => {
    // An ordinary account may *read* the cap — its composer needs it — and may not set it.
    const bob = await env.asUser("UploadBob");
    expect(
      (await bob.inject({ method: "GET", url: "/api/config" })).json<PublicConfig>().maxUploadBytes
    ).toBe(MAX_ATTACHMENT_BYTES);

    const res = await bob.inject({
      method: "PUT",
      url: "/api/upload-settings",
      payload: { maxUploadBytes: 5 * 1024 * 1024 },
    });
    expect(res.statusCode).toBe(403);
    expect((await inject({ method: "GET", url: "/api/config" })).json<PublicConfig>().maxUploadBytes).toBe(
      MAX_ATTACHMENT_BYTES
    );
  });

  it("refuses a raw path that escapes the workspace", async () => {
    const workspace = await seededWorkspace();

    const res = await inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/files/raw?path=${encodeURIComponent("../../etc/passwd")}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("INVALID_FILE_PATH");
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
        payload: {
          name: "Tutor",
          systemPrompt: "Teach.",
          allTools: false,
          tools: ["read_file"],
          settings: { temperature: 0.5 },
        },
      })
    ).json<Copilot>();
    expect(created).toMatchObject({ name: "Tutor", allTools: false, tools: ["read_file"] });

    const updated = (
      await inject({
        method: "PUT",
        url: `/api/copilots/${created.id}`,
        payload: { name: "Coach", systemPrompt: "Coach.", allTools: true, tools: [], settings: {} },
      })
    ).json<Copilot>();
    expect(updated.name).toBe("Coach");
    // The flag came back on, and the list it overrode was dropped rather than stored inert.
    expect(updated).toMatchObject({ allTools: true, tools: [] });

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

  it("publishes nothing until asked, and attributes it to its owner", async () => {
    // Publishing is the whole of the "platform Copilot" idea — there is no admin tier — so it
    // is worth pinning that it is off by default and that the owner comes from the session
    // rather than from the request body.
    const created = (
      await inject({ method: "POST", url: "/api/copilots", payload: { name: "Private", systemPrompt: "" } })
    ).json<Copilot>();
    expect(created).toMatchObject({ visibility: "private", ownerName: "tester" });
    expect(created.userId).toBeTruthy();

    const published = (
      await inject({
        method: "PUT",
        url: `/api/copilots/${created.id}`,
        payload: { visibility: "public" },
      })
    ).json<Copilot>();
    expect(published.visibility).toBe("public");
  });
});

describe("sessions", () => {
  it("404s for an unknown workspace", async () => {
    expect((await inject({ method: "GET", url: "/api/workspaces/nope/sessions" })).statusCode).toBe(404);
    expect(
      (await inject({ method: "POST", url: "/api/workspaces/nope/sessions", payload: {} })).statusCode
    ).toBe(404);
  });

  it("copies the whole copilot in, and stays put when the copilot is edited", async () => {
    const workspace = await newWorkspace(env);
    const copilot = (
      await inject({
        method: "POST",
        url: "/api/copilots",
        payload: {
          name: "WithDefaults",
          systemPrompt: "Be terse.",
          allTools: false,
          tools: ["read_file"],
          settings: { temperature: 0.2, maxSteps: 4 },
        },
      })
    ).json<Copilot>();

    const session = await newSession(env, workspace.id, { copilotId: copilot.id });
    // The placeholder a caller that names nothing gets. The web client sends its own, in the
    // language being read — see `createSession` in `stores/app.ts`.
    expect(session.title).toBe(DEFAULT_SESSION_TITLE);
    expect(session.titleSource).toBe("auto");
    // All four parts of the Copilot, not just the generation settings.
    expect(session).toMatchObject({
      copilotId: copilot.id,
      copilotName: "WithDefaults",
      systemPrompt: "Be terse.",
      tools: ["read_file"],
      settings: { temperature: 0.2, maxSteps: 4 },
    });

    // Copied, not referenced: editing the Copilot must not move a conversation already
    // underway. That is the promise the UI makes in so many words, and the reason the prompt is
    // no longer read from the Copilot on every turn.
    await inject({
      method: "PUT",
      url: `/api/copilots/${copilot.id}`,
      payload: { systemPrompt: "Write essays.", tools: [], settings: { temperature: 1.5 } },
    });

    const reread = (await inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions` })).json<Session[]>();
    expect(reread.find((s) => s.id === session.id)).toMatchObject({
      systemPrompt: "Be terse.",
      tools: ["read_file"],
      settings: { temperature: 0.2, maxSteps: 4 },
    });
  });

  it("refuses a copilot id that is not usable, rather than quietly ignoring it", async () => {
    const workspace = await newWorkspace(env);
    const res = await inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/sessions`,
      payload: { copilotId: "no-such-copilot" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets a conversation hold its own prompt, apart from the copilot's", async () => {
    const workspace = await newWorkspace(env);
    const copilot = (
      await inject({
        method: "POST",
        url: "/api/copilots",
        payload: { name: "Tutor", systemPrompt: "You teach." },
      })
    ).json<Copilot>();
    const session = await newSession(env, workspace.id, { copilotId: copilot.id });

    const updated = (
      await inject({
        method: "PATCH",
        url: `/api/sessions/${session.id}`,
        payload: { systemPrompt: "Be terse." },
      })
    ).json<Session>();

    expect(updated.systemPrompt).toBe("Be terse.");
    // The Copilot is untouched, so the edit is the conversation's alone.
    const rereadCopilot = (await inject({ method: "GET", url: "/api/copilots" })).json<Copilot[]>();
    expect(rereadCopilot.find((c) => c.id === copilot.id)!.systemPrompt).toBe("You teach.");
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

  it("pins and unpins a conversation", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    const pinned = (
      await inject({ method: "PATCH", url: `/api/sessions/${session.id}/pin`, payload: { pinned: true } })
    ).json<Session>();
    expect(pinned.pinned).toBe(true);
    // Returned as the row now reads rather than as an acknowledgement, so the sidebar can
    // replace what it holds without a second read.
    expect(pinned.id).toBe(session.id);
    expect(pinned.updatedAt).toBe(session.updatedAt);

    const unpinned = (
      await inject({ method: "PATCH", url: `/api/sessions/${session.id}/pin`, payload: { pinned: false } })
    ).json<Session>();
    expect(unpinned.pinned).toBe(false);
  });

  it("refuses a pin that is not a boolean, and a session that is not there", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    /*
     * `"false"` is the case this exists for. Coerced, it is truthy — so a body that asked to
     * *unpin* would pin, which is the same trap `disabled` is spelled out against on the admin
     * routes. An absent field is refused too: the two states are both deliberate, so there is no
     * absent value that could mean either.
     */
    for (const payload of [{ pinned: "false" }, { pinned: 1 }, {}]) {
      const res = await inject({ method: "PATCH", url: `/api/sessions/${session.id}/pin`, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("INVALID_FIELD");
    }
    expect(
      (await inject({ method: "PATCH", url: "/api/sessions/nope/pin", payload: { pinned: true } })).statusCode
    ).toBe(404);
  });

  it("refuses to pin another account's conversation", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);
    // A name of its own: `asUser` creates the account on first use and refuses a second under the
    // same name, so a spec that shared "Bob" with the sources test would pass or fail depending
    // on which of the two ran first.
    const bob = await env.asUser("PinBob");

    /*
     * "Not yours" and "does not exist" are one answer — a 404 either way — so an id cannot be
     * probed for existence by the status it comes back with. Asserted against the *same* id
     * twice, once by Bob and once with an id nobody has, because a route that answered 403 for
     * the first would tell Bob the conversation is real.
     */
    const theirs = await bob.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/pin`,
      payload: { pinned: true },
    });
    expect(theirs.statusCode).toBe(404);
    expect((await inject({ method: "PATCH", url: "/api/sessions/nope/pin", payload: { pinned: true } })).statusCode).toBe(404);

    // And nothing was written on the way out.
    expect((await inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions` })).json<Session[]>()[0]?.pinned).toBe(false);
  });

  it("numbers a duplicate title at creation rather than refusing it", async () => {
    const workspace = await newWorkspace(env);

    const first = await newSession(env, workspace.id, { title: "学习计划" });
    const second = await newSession(env, workspace.id, { title: "学习计划" });
    const third = await newSession(env, workspace.id, { title: "学习计划" });

    expect([first.title, second.title, third.title]).toEqual([
      "学习计划",
      "学习计划 (2)",
      "学习计划 (3)",
    ]);
  });

  it("numbers a duplicate rename, and leaves the renamed session's own name alone", async () => {
    const workspace = await newWorkspace(env);
    await newSession(env, workspace.id, { title: "学习计划" });
    const other = await newSession(env, workspace.id, { title: "别的东西" });

    const renamed = (
      await inject({
        method: "PATCH",
        url: `/api/sessions/${other.id}`,
        payload: { title: "学习计划" },
      })
    ).json<Session>();
    expect(renamed.title).toBe("学习计划 (2)");

    // Re-saving under the name it now holds must not walk it to `(3)`: the session itself is
    // not one of the siblings it is checked against.
    const resaved = (
      await inject({
        method: "PATCH",
        url: `/api/sessions/${other.id}`,
        payload: { title: "学习计划 (2)" },
      })
    ).json<Session>();
    expect(resaved.title).toBe("学习计划 (2)");
  });

  it("numbers within one workspace, not across the account's workspaces", async () => {
    const a = await newWorkspace(env);
    const b = await newWorkspace(env);

    expect((await newSession(env, a.id, { title: "Plan" })).title).toBe("Plan");
    // A different workspace has its own list, so the name is free there.
    expect((await newSession(env, b.id, { title: "Plan" })).title).toBe("Plan");
  });

  it("stores a description on a session, independently of its title", async () => {
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id, { title: "Keep Me" });

    const described = (
      await inject({
        method: "PATCH",
        url: `/api/sessions/${session.id}`,
        payload: { description: "第三章的复习" },
      })
    ).json<Session>();
    expect(described.description).toBe("第三章的复习");
    expect(described.title).toBe("Keep Me");
    // A description is not a name, so writing one does not silence the auto-titler.
    expect(described.titleSource).toBe("auto");

    // Empty clears it; omitting it leaves it alone — the absent/empty distinction.
    expect(
      (
        await inject({
          method: "PATCH",
          url: `/api/sessions/${session.id}`,
          payload: { settings: { maxSteps: 2 } },
        })
      ).json<Session>().description
    ).toBe("第三章的复习");
    expect(
      (
        await inject({
          method: "PATCH",
          url: `/api/sessions/${session.id}`,
          payload: { description: "" },
        })
      ).json<Session>().description
    ).toBe("");
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

  it("stores an `@` grant, and refuses a malformed one by name", async () => {
    /*
     * `settings` is otherwise passed straight through — it is a JSON blob the client owns. A
     * grant is the exception, because it decides what a model may read: a malformed one is
     * refused rather than stored and left to resolve to something nobody chose.
     *
     * `"true"` is the case worth naming. It is truthy, so a coerced value would store a grant
     * the caller never asked for, on the one field where that means reading somebody's material.
     * Same discipline as refusing an unknown role rather than guessing it.
     */
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    const bad = await inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { settings: { workspaceScope: { all: "true" } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");
    // Nothing landed, including the fields around it.
    expect(env.server.db.getSessionForUser(session.id, env.user.id)?.session.settings).not.toMatchObject(
      { workspaceScope: { all: "true" } }
    );

    const ok = await inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { settings: { workspaceScope: { all: true } } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Session>().settings).toMatchObject({ workspaceScope: { all: true } });
  });

  it("stores a grant naming a workspace the caller does not own, and resolves it to nothing", async () => {
    // Ownership is checked where the grant is *read*, not where it is written, and that is
    // deliberate: a workspace can be deleted between the chip being drawn and the save landing,
    // and failing the save for that would fail it for something that is not the user's fault.
    // An id that is not theirs is stored and then resolves to nothing.
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    const res = await inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { settings: { workspaceScope: { workspaceIds: ["not-a-workspace"] } } },
    });
    expect(res.statusCode).toBe(200);

    const stored = env.server.db.getSessionForUser(session.id, env.user.id)!;
    expect(resolveWorkspaceScope(env.server.db, env.user.id, stored.session).workspaces).toEqual([]);
  });

  it("404s message listing for an unknown session", async () => {
    expect((await inject({ method: "GET", url: "/api/sessions/nope/messages" })).statusCode).toBe(404);
  });

  it("cascades messages away with the session, and leaves the uploaded files alone", async () => {
    // The behaviour this pins is the one that *changed*: a conversation delete used to take
    // its uploads with it, because the bytes lived inside the session's directory. A source
    // belongs to the account now, so deleting a conversation removes its references and
    // nothing else — another conversation may be reading the same file, and a file the user
    // uploaded is not something to delete as a side effect of tidying up a chat.
    const workspace = await newWorkspace(env);
    const session = await newSession(env, workspace.id);

    const attachment = await uploadAttachment(env, session.id, {
      name: "a.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello"),
    });
    const rawPath = rawFilePath(env.userLayout, attachment.id, attachment.mimeType);
    expect(existsSync(rawPath)).toBe(true);

    await inject({ method: "DELETE", url: `/api/sessions/${session.id}` });

    expect(existsSync(rawPath)).toBe(true);
    // And it is gone from the *conversation*, which is the half a delete is for.
    expect((await inject({ method: "GET", url: `/api/sessions/${session.id}/messages` })).statusCode).toBe(404);
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

describe("sources", () => {
  let workspace: Workspace;
  let session: Session;

  beforeEach(async () => {
    workspace = await newWorkspace(env);
    session = await newSession(env, workspace.id);
  });

  const upload = (payload: object) =>
    inject({ method: "POST", url: `/api/sessions/${session.id}/resources`, payload });

  /** The bytes as the server stored them, which is what the assertions care about. */
  const rawPathOf = (attachment: Attachment) =>
    rawFilePath(env.userLayout, attachment.id, attachment.mimeType);

  it("404s for an unknown session", async () => {
    const res = await inject({
      method: "POST",
      url: "/api/sessions/nope/resources",
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
    expect(readFileSync(rawPathOf(attachment), "utf8")).toBe("hello");
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

  it("stores identical bytes once, however many names they arrive under", async () => {
    // The dedupe this change is about. The *message* keeps the name that upload used — the
    // source keeps the first one it ever saw — so the two chips can legitimately differ.
    const before = readdirSync(env.userLayout.rawDir).length;
    // Bytes nothing else in this file uses, so the dedupe is exercised by *these* two uploads
    // rather than by an earlier test having happened to store the same content.
    const bytes = Buffer.from("dedupe-me-please").toString("base64");

    const first = (await upload({ name: "original.txt", mimeType: "text/plain", data: bytes })).json<Attachment>();
    const second = (await upload({ name: "copy.txt", mimeType: "text/plain", data: bytes })).json<Attachment>();

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("copy.txt");
    expect(first.name).toBe("original.txt");
    // One new file, not two: the second upload wrote nothing. Counted rather than asserted
    // outright, because the data root is shared with every other test in this file.
    expect(readdirSync(env.userLayout.rawDir)).toHaveLength(before + 1);
  });

  it("makes a file readable from another conversation in the same workspace", async () => {
    // What the workspace reference buys, and the whole reason the whitelist has a workspace arm:
    // a document uploaded here is readable from a sibling conversation, while `read_file` could
    // never reach it at all (it is outside every workspace sandbox).
    const attachment = await uploadAttachment(env, session.id, {
      name: "shared.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4").valueOf(),
    });
    const sibling = await newSession(env, workspace.id);

    const readable = env.server.db.listReadableWorkResources(
      env.user.id,
      sibling.id,
      workspace.id,
      NO_SCOPE
    );
    expect(readable.map((r) => r.resourceId)).toContain(attachment.id);
  });

  it("serves the bytes back with the right type and a long cache", async () => {
    const attachment = (
      await upload({ name: "a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") })
    ).json<Attachment>();

    const res = await inject({ method: "GET", url: `/api/files/${attachment.id}/raw` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.body).toBe("hello");
  });

  it("404s for an unknown source", async () => {
    expect((await inject({ method: "GET", url: "/api/files/nope/raw" })).statusCode).toBe(404);
    expect((await inject({ method: "GET", url: "/api/resources/nope/preview" })).statusCode).toBe(404);
  });

  /*
   * A source's preview, which is what makes an uploaded file openable at all: it lives outside
   * every workspace, so the file browser's routes cannot address it.
   *
   * The point of these assertions is that a source is described by the *same* classification a
   * workspace file gets — the two call one function — so the same dialog renders both.
   */
  it("describes an uploaded file the way the file browser would", async () => {
    /*
     * The body is distinctive on purpose. Sources are deduped by content, so bytes another test
     * already uploaded come back under *that* test's name — documented behaviour, and a fine way
     * to write a test that fails for a reason about a neighbouring fixture. The e2e's `seedSource`
     * carries the same warning.
     */
    const body = "%PDF-1.4 source-preview-classification";
    const attachment = (
      await upload({
        name: "doc.pdf",
        mimeType: "application/pdf",
        data: Buffer.from(body).toString("base64"),
      })
    ).json<Attachment>();

    const res = await inject({ method: "GET", url: `/api/resources/${attachment.resourceId}/preview` });
    expect(res.statusCode).toBe(200);
    expect(res.json<FileContent>()).toMatchObject({
      // The stored name, not the uuid the bytes sit under on disk.
      name: "doc.pdf",
      kind: "binary",
      text: null,
      truncated: false,
      size: body.length,
    });
  });

  it("carries the page's URL when the source is one, and nothing when it is not", async () => {
    /*
     * The preview dialog's "open in browser" control is gated on this field, so the two halves are
     * asserted together: a page says where it came from, and every other file says nothing rather
     * than an empty string — the same "absent means nowhere to go" the listing rows render on.
     *
     * The page is captured through `captureWebPage` with a stubbed cache, because the other branch
     * of that function goes through `web_fetch`'s SSRF guard and refuses loopback by design — the
     * same reason `webCapture.test.ts` drives it this way.
     */
    const url = "https://example.com/kept-page";
    const page = await captureWebPage(env.server.db, {
      user: env.userLayout,
      userId: env.user.id,
      owner: { kind: "workspace", id: workspace.id },
      url,
      cache: new Map([
        [
          url,
          {
            finalUrl: url,
            body: "<html><head><title>Kept</title></head><body><p>正文</p></body></html>",
            contentType: "text/html",
          },
        ],
      ]),
    });

    // `page.id` is the **reference**; `page.resourceId` is the page behind it.
    const preview = await inject({ method: "GET", url: `/api/resources/${page.id}/preview` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<FileContent>()).toMatchObject({ kind: "text", url });

    // The other half: an upload has no page behind it, and the field must be absent rather than
    // empty — a client gating on `url` would offer the control for `""` if this were written the
    // lazy way.
    const attachment = (
      await upload({
        name: "no-page.txt",
        mimeType: "text/plain",
        data: Buffer.from(`plain ${Date.now()}`).toString("base64"),
      })
    ).json<Attachment>();
    const plain = await inject({ method: "GET", url: `/api/resources/${attachment.resourceId}/preview` });
    expect(plain.json<FileContent>().url).toBeUndefined();
  });

  it("sends an uploaded text file's contents", async () => {
    // The half a viewer cannot do: a `.md` upload is text, so it renders through the same
    // markdown path a workspace file does rather than being handed to a plugin registry.
    const attachment = (
      await upload({
        name: "preview-notes.md",
        mimeType: "text/markdown",
        data: Buffer.from("# Source preview").toString("base64"),
      })
    ).json<Attachment>();

    const res = await inject({ method: "GET", url: `/api/resources/${attachment.resourceId}/preview` });
    expect(res.json<FileContent>()).toMatchObject({
      kind: "markdown",
      text: "# Source preview",
    });
  });

  it("never tells a client where a file lives, or who owns it", async () => {
    // `SourceRecord` carries `rawPath` and `userId`, and both are for the server only — a path
    // is a map of a directory the client is not allowed to browse. Regression: the first
    // version spread the whole record, so `rawPath` appeared in the upload response.
    const uploaded = await upload({
      name: "a.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello").toString("base64"),
    });

    expect(uploaded.body).not.toContain("rawPath");
    expect(uploaded.body).not.toContain("userId");
    expect(uploaded.body).not.toContain(env.userLayout.rawDir);
    expect(uploaded.body).not.toContain(env.user.id);

    const listed = await inject({ method: "GET", url: `/api/sessions/${session.id}/resources` });
    expect(listed.body).not.toContain("rawPath");
    expect(listed.body).not.toContain("userId");
    expect(listed.body).not.toContain(env.userLayout.rawDir);
  });

  it("refuses a traversal attempt in the source id", async () => {
    // The id is a path segment, so this is the shape a hostile client would try. It cannot
    // reach a file either way: the path is a validated column, and the id never becomes one.
    const res = await inject({
      method: "GET",
      url: `/api/files/${encodeURIComponent("../../../../etc/passwd")}/raw`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists what a conversation can read, with the parse state as it is now", async () => {
    // Parse state is a column on the source rather than a snapshot folded into each message,
    // so this is where a reparse becomes visible — in every conversation that shares the
    // file, at once.
    const attachment = (
      await upload({ name: "a.txt", mimeType: "text/plain", data: "aGk=" })
    ).json<Attachment>();

    const listed = (await inject({ method: "GET", url: `/api/sessions/${session.id}/resources` })).json<
      { resourceId: string }[]
    >();
    expect(listed.map((r) => r.resourceId)).toEqual([attachment.id]);
  });

  it("lists a file once when its conversation and its workspace both hold it", async () => {
    /*
     * A conversation's own reference *is* its membership — there is no link table to union in a
     * second row, so a file appearing twice is unrepresentable rather than merely avoided. The
     * case is still worth pinning because the previous design got it wrong: an upload wrote two
     * link rows from two `now()` calls, and a `UNION` only collapsed them while the two
     * timestamps happened to agree.
     *
     * The second conversation uploads the *same bytes*, so `UNIQUE (user_id, sha256)` makes this
     * one file with two references — which the whitelist's session arm must not double-count.
     */
    const first = (
      await upload({ name: "dup.txt", mimeType: "text/plain", data: "aGk=" })
    ).json<Attachment>();

    const other = await newSession(env, workspace.id);
    await uploadAttachment(env, other.id, {
      name: "dup.txt",
      mimeType: "text/plain",
      data: Buffer.from("hi"),
    });

    const listed = (await inject({ method: "GET", url: `/api/sessions/${other.id}/resources` })).json<
      { resourceId: string }[]
    >();

    expect(listed.map((r) => r.resourceId)).toEqual([first.id]);
  });

  it("lists the account's files, newest first, across every conversation", async () => {
    // Account-wide rather than per-conversation: this is the list the library dialog manages,
    // and the only place a file with no remaining references is still visible.
    const first = await uploadAttachment(env, session.id, {
      name: "older.txt",
      mimeType: "text/plain",
      data: Buffer.from("one"),
    });
    const other = await newSession(env, workspace.id);
    const second = await uploadAttachment(env, other.id, {
      name: "newer.txt",
      mimeType: "text/plain",
      data: Buffer.from("two"),
    });

    const listed = (await inject({ method: "GET", url: "/api/resources" })).json<WorkResource[]>();
    // Rows are **references**, so the id a caller addresses one by is `resourceId`.
    const ids = listed.map((r) => r.resourceId);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    // Newest first, so the file just uploaded is the one at the top.
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(listed.find((r) => r.resourceId === second.id)?.title).toBe("newer.txt");
  });

  it("does not list another account's files", async () => {
    const mine = await uploadAttachment(env, session.id, {
      name: "mine.txt",
      mimeType: "text/plain",
      data: Buffer.from("private"),
    });

    const bob = await env.asUser("Bob");
    const theirs = (await bob.inject({ method: "GET", url: "/api/resources" })).json<WorkResource[]>();
    expect(theirs.map((r) => r.resourceId)).not.toContain(mine.id);

    // And Bob's empty list is empty, not a 404 — he has an account, it just holds nothing.
    expect(theirs).toEqual([]);
  });

  it("removes this conversation's reference, and leaves the file alone", async () => {
    /*
     * The v4 split, and the behaviour that makes it worth having.
     *
     * Deleting from the library removes a **reference**, not a file. The bytes, the file's row
     * and every *other* owner's reference are untouched — which is what stops one conversation
     * tidying up from taking a document out of another conversation that is working from it.
     * Removing the bytes is the file manager's job, and it moves them to the trash.
     *
     * The chips are the second half: a message sent with a file keeps showing what was sent, so
     * the snapshot survives the reference it came from.
     */
    const attachment = await uploadAttachment(env, session.id, {
      name: "doomed.txt",
      mimeType: "text/plain",
      data: Buffer.from("bye"),
    });

    // The same file, in a second conversation: one file, two references.
    const other = await newSession(env, workspace.id);
    const also = await uploadAttachment(env, other.id, {
      name: "doomed.txt",
      mimeType: "text/plain",
      data: Buffer.from("bye"),
    });
    expect(also.id).toBe(attachment.id);
    expect(also.resourceId).not.toBe(attachment.resourceId);

    const res = await inject({
      method: "DELETE",
      url: `/api/resources/${attachment.resourceId}`,
    });
    expect(res.statusCode).toBe(200);

    // Gone from the library as the row this conversation held...
    const all = (await inject({ method: "GET", url: "/api/resources" })).json<
      { id: string; resourceId: string }[]
    >();
    expect(all.map((r) => r.id)).not.toContain(attachment.resourceId);
    // ...and still there for the conversation that did not delete it.
    expect(all.map((r) => r.id)).toContain(also.resourceId);
    expect(existsSync(rawPathOf(attachment))).toBe(true);
    expect(
      (await inject({ method: "GET", url: `/api/files/${attachment.id}/raw` })).statusCode
    ).toBe(200);

    /*
     * And the conversation can **still read the file** — through the sibling's reference, which
     * the whitelist admits because both conversations are in one workspace. That is not a loose
     * end: it is the same rule that makes a document uploaded next door readable here, and it is
     * why "remove my reference" and "delete the file" have to be two different actions.
     */
    const still = (await inject({ method: "GET", url: `/api/sessions/${session.id}/resources` })).json<
      { resourceId: string }[]
    >();
    expect(still.map((r) => r.resourceId)).toEqual([attachment.id]);
  });

  it("re-uploading deleted bytes revives the file, and makes a fresh reference", async () => {
    /*
     * The soft delete's other half: `UNIQUE (user_id, sha256)` means the same bytes cannot
     * become a second *file*, so a re-upload after the file itself was deleted has to bring
     * that row back — with its bytes and its summary, which is what makes it the same file
     * rather than a lookalike. The reference is per conversation and is always new, because
     * the old one may still be live for somebody else.
     */
    const attachment = await uploadAttachment(env, session.id, {
      name: "doomed.txt",
      mimeType: "text/plain",
      data: Buffer.from("bye again"),
    });

    // Deleting the *file*, the way the file manager does.
    env.server.db.softDeleteFileForUser(attachment.id, env.user.id);
    expect(env.server.db.getFileForUser(env.user.id, attachment.id)).toBeUndefined();

    const revived = await uploadAttachment(env, session.id, {
      name: "doomed.txt",
      mimeType: "text/plain",
      data: Buffer.from("bye again"),
    });
    expect(revived.id).toBe(attachment.id);
    expect(
      (await inject({ method: "GET", url: `/api/sessions/${session.id}/resources` })).json<
        { id: string; resourceId: string }[]
      >()
    ).toMatchObject([{ id: revived.resourceId, resourceId: revived.id }]);
  });
});
