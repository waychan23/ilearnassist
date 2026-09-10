import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, Workspace } from "@guided-learning/shared";
import type { AppConfig, ProviderDef, WebFetchConfig, WebSearchConfig } from "../../src/config.js";
import { buildServer, type BuiltServer } from "../../src/server.js";
import type { FakeLlm } from "./fakeLlm.js";

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
  tools?: {
    webSearch?: Partial<WebSearchConfig>;
    webFetch?: Partial<WebFetchConfig>;
    fileTools?: { enabled?: boolean };
  };
}

export interface TestEnv {
  config: AppConfig;
  dataDir: string;
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
  const root = mkdtempSync(join(tmpdir(), "guided-learning-test-"));
  const dataDir = join(root, "data");
  const workspacesRoot = join(root, "workspaces");
  mkdirSync(dataDir, { recursive: true });

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
    workspaces: { rootDir: workspacesRoot },
    defaultProvider: options.defaultProvider ?? first.id,
    defaultModel: options.defaultModel ?? first.models[0]?.id ?? "",
    providers,
    tools: {
      webSearch,
      webFetch,
      fileTools: { enabled: options.tools?.fileTools?.enabled ?? true },
    },
  };

  const server = await buildServer({ config, dataDir, logger: false });
  await server.app.ready();

  return {
    config,
    dataDir,
    workspacesRoot,
    uploadsRoot: server.uploadsRoot,
    server,
    async cleanup() {
      await server.app.close();
      server.db.raw.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
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
