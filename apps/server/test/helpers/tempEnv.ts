import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// From `fastify`, which re-exports both, rather than from `light-my-request` directly: that
// package is a transitive dependency and is not something this one may name.
import type { InjectOptions, LightMyRequestResponse } from "fastify";
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
import { userLayout, type UserLayout } from "../../src/paths.js";
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
  /** The name to sign in as. Defaults to `tester`; a second account is `env.asUser`. */
  username?: string;
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
  /** The account tests act as. Created by signing in; see `asUser` for a second one. */
  user: User;
  /** That account's tree — where its workspaces and (later) its sources live. */
  userLayout: UserLayout;
  /** Shorthand for `userLayout.workspacesRoot`, which is what most tests reach for. */
  workspacesRoot: string;
  server: BuiltServer;
  /**
   * `app.inject`, with the signed-in account's cookie already attached.
   *
   * The point is that almost every test wants a request *as somebody* and none of them wants
   * to think about cookies — the session is the harness's business, not the assertion's. The
   * raw `server.app.inject` is still there for the tests that are about the gate itself,
   * where the missing cookie is the subject.
   */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  /** Sign in as another account, creating it if it is new. */
  asUser(username: string): Promise<{ user: User; inject: TestEnv["inject"] }>;
  cleanup(): Promise<void>;
}

/** The header name the cookie travels in — lowercase, as Node's HTTP layer reports it. */
const COOKIE = "cookie";

/**
 * Sign in over the real route and keep the cookie.
 *
 * Deliberately the real route rather than a hand-built cookie: the signing, the response
 * header and the parsing are exactly the parts a test would get subtly wrong if it made its
 * own, and the login route is one of the things worth exercising.
 */
async function signIn(
  server: BuiltServer,
  username: string
): Promise<{ user: User; cookie: string; inject: TestEnv["inject"] }> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username },
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-in failed for "${username}": ${res.statusCode} ${res.body}`);
  }

  const header = res.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new Error(`sign-in for "${username}" returned no cookie`);
  // Only the `name=value` pair: the attributes (`Path`, `Max-Age`, …) are instructions to a
  // browser, and sending them back is not what a cookie header looks like.
  const cookie = String(raw).split(";")[0] ?? "";

  return {
    user: res.json<User>(),
    cookie,
    inject: (opts) =>
      server.app.inject({ ...opts, headers: { ...opts.headers, [COOKIE]: cookie } }),
  };
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

  // Signing in is what creates the account, so the harness has somebody to be before any
  // test runs — and it goes through the real route, which means the cookie in `inject` is a
  // cookie the server actually issued.
  const signedIn = await signIn(server, options.username ?? "tester");
  const userLayout_ = userLayout(server.layout, signedIn.user.slug);

  return {
    config,
    dataRoot,
    user: signedIn.user,
    userLayout: userLayout_,
    workspacesRoot: userLayout_.workspacesRoot,
    server,
    inject: signedIn.inject,
    async asUser(username) {
      const other = await signIn(server, username);
      return { user: other.user, inject: other.inject };
    },
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
 * has to wait for a background job rather than for a response. It polls the conversation's
 * sources — the same rows the browser reads — rather than any file, so the assertion observes
 * exactly what a user would.
 */
export async function waitForParsing(
  env: TestEnv,
  sessionId: string,
  timeoutMs = 15_000
): Promise<void> {
  const isBusy = (): boolean =>
    env.server.db
      .listSessionSources(env.user.id, sessionId)
      .some((s) => s.parseStatus === "pending" || s.parseStatus === "parsing");

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (!isBusy()) {
      // One extra tick so a queued job that just left the queue has written its state.
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!isBusy()) return;
    }
    if (Date.now() > deadline) throw new Error(`parsing did not settle within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Upload a file through the real route and return the message snapshot it answers with.
 *
 * The snapshot rather than the source, because that is what a caller has: this is the same
 * object the client would put on a message and send back on the next turn.
 */
export async function uploadAttachment(
  env: TestEnv,
  sessionId: string,
  file: { name: string; mimeType: string; data: Buffer }
): Promise<Attachment> {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/sources`,
    payload: { name: file.name, mimeType: file.mimeType, data: file.data.toString("base64") },
  });
  if (res.statusCode !== 201) {
    throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  }
  return res.json<Attachment>();
}

/* ------------------------------- API shorthands ------------------------------ */

export async function newWorkspace(env: TestEnv, name = "Test Workspace"): Promise<Workspace> {
  const res = await env.inject({
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
  const res = await env.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/sessions`,
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`create session failed: ${res.statusCode} ${res.body}`);
  return res.json<Session>();
}
