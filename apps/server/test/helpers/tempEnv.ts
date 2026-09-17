import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// From `fastify`, which re-exports both, rather than from `light-my-request` directly: that
// package is a transitive dependency and is not something this one may name.
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { CLIENT_ID_HEADER } from "@ilearnassist/shared";
import type {
  Attachment,
  AuthResult,
  Session,
  User,
  UserCredentials,
  Workspace,
} from "@ilearnassist/shared";
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
import { createAdmin } from "../../src/adminCli.js";
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
  /** The account tests act as. A superadmin, created by the harness; see `asUser` for a second. */
  user: User;
  /**
   * That account's access token.
   *
   * For the handful of tests that are about the credential rather than about a request —
   * expiry, revocation, the wrong kind of token. Anything that is about a *route* should use
   * `inject`, which already carries it.
   */
  token: string;
  /** That account's tree — where its workspaces and (later) its sources live. */
  userLayout: UserLayout;
  /** Shorthand for `userLayout.workspacesRoot`, which is what most tests reach for. */
  workspacesRoot: string;
  server: BuiltServer;
  /**
   * `app.inject`, with the signed-in account's bearer token already attached.
   *
   * The point is that almost every test wants a request *as somebody* and none of them wants
   * to think about tokens — the session is the harness's business, not the assertion's. The
   * raw `server.app.inject` is still there for the tests that are about the gate itself,
   * where the missing header is the subject.
   */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  /**
   * Create a second account and sign in as it.
   *
   * Goes the whole way round — the console's create route, the first sign-in with the
   * password it was handed, then the password change that state demands. That is longer than
   * writing a row directly, and it is the point: an account made any other way would sit in a
   * state no real account is ever in, and every test using it would be testing that state.
   */
  asUser(username: string): Promise<{ user: User; inject: TestEnv["inject"] }>;
  /**
   * A **second client of the same account** — the same token, a different client id.
   *
   * This is the seam the session-lock tests need and the harness did not have: `asUser` makes a
   * second *account*, while two clients of one account is the situation a write lock is about
   * (a desktop and a phone, two tabs). Nothing about the account changes, so a request from this
   * one is authorized exactly as the first one's is, and only the lease tells them apart.
   */
  asClient(clientId: string): TestEnv["inject"];
  cleanup(): Promise<void>;
}

/** The header name a token travels in — lowercase, as Node's HTTP layer reports it. */
const AUTHORIZATION = "authorization";

/**
 * The password every harness account ends up with.
 *
 * Fixed rather than random so a failure names something a person can type, and comfortably
 * past `PASSWORD_MIN_LENGTH` so nothing here trips the policy it is meant to exercise.
 */
export const TEST_PASSWORD = "test-password-1234";

const bearer = (token: string): Record<string, string> => ({
  [AUTHORIZATION]: `Bearer ${token}`,
});

/** An `inject` that carries one account's token. */
/**
 * `app.inject`, as a named client of a named account.
 *
 * The client id is a **header** rather than part of the token, which is what makes "the same
 * account, two clients" expressible here at all: a session write is gated on a lease held by
 * whichever client asks, and a request that never says which client it is can never hold one. So
 * every harness request carries an id, and a test that wants a second client passes a second one
 * (`asClient`).
 *
 * A default rather than a requirement per call, because the choice is uninteresting to the ~40
 * tests that write to a conversation for some other reason — and a suite that had to name a
 * client in every `inject` would be a suite where the lock is everywhere and therefore invisible.
 */
const DEFAULT_CLIENT_ID = "test-client-1";

function injectAs(
  server: BuiltServer,
  token: string,
  clientId: string = DEFAULT_CLIENT_ID
): TestEnv["inject"] {
  return (opts) =>
    server.app.inject({
      ...opts,
      headers: { ...opts.headers, ...bearer(token), [CLIENT_ID_HEADER]: clientId },
    });
}

/**
 * Sign in over the real route and keep the access token.
 *
 * Deliberately the real route rather than a hand-built header: the hashing, the reply shape
 * and the token's own lookup are exactly the parts a test would get subtly wrong if it made
 * its own, and the login route is one of the things worth exercising.
 */
async function authenticate(
  server: BuiltServer,
  username: string,
  password: string
): Promise<{ user: User; token: string; inject: TestEnv["inject"] }> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-in failed for "${username}": ${res.statusCode} ${res.body}`);
  }
  const body = res.json<AuthResult>();
  return {
    user: body.user,
    token: body.tokens.accessToken,
    inject: injectAs(server, body.tokens.accessToken),
  };
}

/**
 * Make this root's first administrator, the way the control panel does.
 *
 * Through `createAdmin`, which is the *only* implementation of the bootstrap in the product —
 * the same function the CLI wraps. Nothing here writes a user row behind its back, so a test
 * root is in a state a real one can be in, and a change to the rules is a change these tests
 * see.
 *
 * The sign-in that follows is a real one, so the token `inject` carries is a token the server
 * issued rather than one built for the harness.
 */
async function bootstrapAdmin(
  server: BuiltServer,
  username: string
): Promise<{ user: User; token: string; inject: TestEnv["inject"] }> {
  const outcome = await createAdmin({
    dataRoot: server.dataRoot,
    username,
    password: TEST_PASSWORD,
  });
  if (!outcome.ok) {
    throw new Error(`creating the administrator failed: ${JSON.stringify(outcome.body)}`);
  }
  return authenticate(server, username, TEST_PASSWORD);
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

/** The server on its own, with no account in it. What `startTestServer` builds on. */
export interface BareServer {
  config: AppConfig;
  dataRoot: string;
  server: BuiltServer;
  cleanup(): Promise<void>;
}

/**
 * Boot the server against a throwaway root and stop there.
 *
 * For the tests that are about the state a root *starts* in: the first-run screen is only
 * reachable while no account has a password, so a harness that had already created one would
 * be the thing standing in the way of the assertion. Everything else wants
 * `startTestServer`, which calls this and then signs somebody in.
 */
export async function startBareServer(options: TestServerOptions = {}): Promise<BareServer> {
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
    server,
    async cleanup() {
      await server.app.close();
      server.db.raw.close();
      if (ownsRoot) rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestEnv> {
  const bare = await startBareServer(options);

  // A fresh data root has nobody in it, so the harness creates the first administrator before
  // any test runs — through the real first-run route, which means the token in `inject` is one
  // the server actually issued.
  const signedIn = await bootstrapAdmin(bare.server, options.username ?? "tester");
  const userLayout_ = userLayout(bare.server.layout, signedIn.user.slug);

  return {
    ...bare,
    user: signedIn.user,
    token: signedIn.token,
    userLayout: userLayout_,
    workspacesRoot: userLayout_.workspacesRoot,
    inject: signedIn.inject,
    async asUser(username) {
      const created = await signedIn.inject({
        method: "POST",
        url: "/api/admin/users",
        payload: { username },
      });
      if (created.statusCode !== 200) {
        throw new Error(`creating "${username}" failed: ${created.statusCode} ${created.body}`);
      }
      const { password } = created.json<UserCredentials>();

      // Signing in leaves the account owing a password change, which is a state every other
      // route refuses. Spending it here is what makes the returned `inject` usable, and it
      // exercises the forced-change path on every second account the suite makes.
      const first = await authenticate(bare.server, username, password);
      const settled = await first.inject({
        method: "POST",
        url: "/api/auth/password",
        payload: { oldPassword: password, newPassword: TEST_PASSWORD },
      });
      if (settled.statusCode !== 200) {
        throw new Error(`changing "${username}"'s password failed: ${settled.statusCode} ${settled.body}`);
      }
      const { tokens } = settled.json<AuthResult>();
      return { user: first.user, inject: injectAs(bare.server, tokens.accessToken) };
    },
    asClient(clientId) {
      return injectAs(bare.server, signedIn.token, clientId);
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
