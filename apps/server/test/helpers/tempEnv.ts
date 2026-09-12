import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Session, User, Workspace } from "@ilearnassist/shared";
import type {
  AppConfig,
  DocumentParserDef,
  DocumentParsingDefaults,
  DocumentsConfig,
  ProviderDef,
  WebFetchConfig,
  WebSearchConfig,
} from "../../src/config.js";
import type { UserLayout } from "../../src/paths.js";
import { buildServer, type BuiltServer } from "../../src/server.js";
import type { FakeLlm } from "./fakeLlm.js";
import type { FakeParser } from "./fakeParser.js";

/**
 * Boots the real server against a throwaway directory tree.
 *
 * Nothing here may touch the repo's own `data/` or `workspaces/` — every test file gets
 * its own temp root, torn down at the end. That isolation is the only reason it is safe
 * to run the whole suite (and the e2e) against a real sqlite database.
 */

export interface TestServerOptions {
  providers?: ProviderDef[];
  defaultProvider?: string;
  defaultModel?: string;
  documentParsers?: DocumentParserDef[];
  documentParsing?: Partial<DocumentParsingDefaults>;
  /**
   * A built frontend to serve alongside the API. Omitted by default, and that is the point:
   * whether the machine running the tests happens to have run `pnpm build` must not change
   * what they assert about routing.
   */
  webDir?: string;
  /**
   * Boot against an existing data root instead of a fresh one.
   *
   * The default (a new temp directory per boot) is what keeps tests independent. Passing
   * one is how a test asks the question a restart asks: what happens on the *second* boot
   * of a root that already has state in it.
   */
  dataRoot?: string;
  tools?: {
    webSearch?: Partial<WebSearchConfig>;
    webFetch?: Partial<WebFetchConfig>;
    fileTools?: { enabled?: boolean };
    documents?: Partial<DocumentsConfig>;
  };
}

/** A parser record pointing at a fake parser service. */
export function parserFor(
  parser: FakeParser,
  overrides: Partial<DocumentParserDef> = {}
): DocumentParserDef {
  return {
    id: overrides.id ?? "fake-parser",
    name: overrides.name ?? "Fake Parser",
    kind: overrides.kind ?? "sync",
    // MinerU's base URL carries the API version (`https://mineru.net/api/v4`) and the
    // driver appends `/file-urls/batch` — mirror that here so the fake is addressed the
    // way a real deployment would be.
    baseURL: overrides.baseURL ?? (overrides.kind === "mineru" ? `${parser.baseURL}/api/v4` : parser.baseURL),
    apiKey: overrides.apiKey ?? (overrides.kind === "sync" ? undefined : "test-key"),
    enabled: overrides.enabled ?? true,
  };
}

export interface TestEnv {
  config: AppConfig;
  /** The chosen data root. `users/` and `db/` live here, and nothing writes above it. */
  dataRoot: string;
  /** The running user's tree — where its workspaces and (later) its sources live. */
  userLayout: UserLayout;
  /** The running user, created by the server on boot. See `ensureBootstrapUser`. */
  user: User;
  /** Shorthand for `userLayout.workspacesRoot`, which is what most tests reach for. */
  workspacesRoot: string;
  uploadsRoot: string;
  server: BuiltServer;
  cleanup(): Promise<void>;
}

/** A provider record pointing at a fake LLM. `apiKey` is required by `buildModel`. */
export function providerFor(
  llm: FakeLlm,
  overrides: { id?: string; name?: string; modelId?: string; apiKey?: string } = {}
): ProviderDef {
  const modelId = overrides.modelId ?? "fake-model";
  return {
    id: overrides.id ?? "fake",
    name: overrides.name ?? "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: overrides.apiKey ?? "test-key",
    models: [{ id: modelId, name: modelId }],
  };
}

/** A provider with no key — `buildModel` rejects it synchronously. */
export function keylessProvider(id = "keyless"): ProviderDef {
  return {
    id,
    name: "Keyless Provider",
    baseURL: "http://127.0.0.1:1/v1",
    models: [{ id: "fake-model", name: "fake-model" }],
  };
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestEnv> {
  // Only a root this helper created is removed on cleanup. One the caller named is theirs,
  // which is what lets a test boot the same tree twice and watch the second boot find what
  // the first one left behind.
  const ownsRoot = options.dataRoot === undefined;
  const dataRoot = options.dataRoot ?? mkdtempSync(join(tmpdir(), "ilearnassist-test-"));
  // Nothing is created here: `createDb` makes the database's directory and the server makes
  // the running user's tree, both recursively. A temp root that pre-built the layout could
  // hide a missing `mkdir` in the code that is supposed to do it.

  const providers = options.providers ?? [keylessProvider("test")];
  const first = providers[0]!;

  const webSearch: WebSearchConfig = {
    provider: "bing",
    maxResults: 5,
    bingEndpoint: "https://www.bing.com/search",
    duckduckgoEndpoint: "https://html.duckduckgo.com/html/",
    ...options.tools?.webSearch,
  };
  const webFetch: WebFetchConfig = { enabled: true, maxChars: 20_000, ...options.tools?.webFetch };

  const config: AppConfig = {
    // The port is unused here — `buildServer` never binds. Tests that need a real
    // socket call `listen({ port: 0 })` and read the assigned port back.
    server: { host: "127.0.0.1", port: 0 },
    defaultProvider: options.defaultProvider ?? first.id,
    defaultModel: options.defaultModel ?? first.models[0]?.id ?? "",
    providers,
    documentParsers: options.documentParsers ?? [],
    documentParsing: {
      localEnabled: true,
      policy: "local-first",
      fallbackEnabled: true,
      defaultParserId: null,
      ...options.documentParsing,
    },
    tools: {
      webSearch,
      webFetch,
      fileTools: { enabled: options.tools?.fileTools?.enabled ?? true },
      documents: {
        localMaxBytes: 20 * 1024 * 1024,
        maxTextChars: 2_000_000,
        concurrency: 2,
        requestTimeoutMs: 5_000,
        jobTimeoutMs: 10_000,
        // Tests must not wait seconds per poll; the production default is 3s.
        pollIntervalMs: 20,
        ...options.tools?.documents,
      },
    },
  };

  const server = await buildServer({ config, dataRoot, logger: false, webDir: options.webDir });
  await server.app.ready();

  return {
    config,
    dataRoot,
    userLayout: server.userLayout,
    user: server.user,
    workspacesRoot: server.userLayout.workspacesRoot,
    uploadsRoot: server.uploadsRoot,
    server,
    async cleanup() {
      await server.app.close();
      server.db.raw.close();
      if (ownsRoot) rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Wait until a session has no parse still pending or running, or the budget runs out.
 *
 * Extraction is deliberately off the request path, so every test that uploads a document
 * has to wait for a background job rather than for a response. Polling the sidecar keeps
 * the assertion honest: it observes the same state the browser does.
 */
export async function waitForParsing(
  env: TestEnv,
  sessionId: string,
  timeoutMs = 15_000
): Promise<void> {
  const { listParseRecords } = await import("../../src/documents/store.js");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const records = await listParseRecords(env.uploadsRoot, sessionId);
    const busy = [...records.values()].some(
      (r) => r.status === "pending" || r.status === "parsing"
    );
    if (!busy) {
      // One extra tick so a queued job that just left the queue has written its record.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const settled = await listParseRecords(env.uploadsRoot, sessionId);
      const stillBusy = [...settled.values()].some(
        (r) => r.status === "pending" || r.status === "parsing"
      );
      if (!stillBusy) return;
    }
    if (Date.now() > deadline) throw new Error(`parsing did not settle within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Upload a file through the real route and return the created attachment. */
export async function uploadAttachment(
  env: TestEnv,
  sessionId: string,
  file: { name: string; mimeType: string; data: Buffer }
): Promise<Attachment> {
  const res = await env.server.app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/attachments`,
    payload: { name: file.name, mimeType: file.mimeType, data: file.data.toString("base64") },
  });
  if (res.statusCode !== 201) {
    throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  }
  return res.json<Attachment>();
}

/* ------------------------------- API shorthands ------------------------------ */

export async function newWorkspace(env: TestEnv, name = "Test Workspace"): Promise<Workspace> {
  const res = await env.server.app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`create workspace failed: ${res.statusCode} ${res.body}`);
  return res.json<Workspace>();
}

export async function newSession(
  env: TestEnv,
  workspaceId: string,
  payload: Record<string, unknown> = {}
): Promise<Session> {
  const res = await env.server.app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/sessions`,
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`create session failed: ${res.statusCode} ${res.body}`);
  return res.json<Session>();
}
