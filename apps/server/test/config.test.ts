import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepMerge, resolveEnv, validateConfig, withDefaults, type AppConfig } from "../src/config.js";

describe("resolveEnv", () => {
  beforeEach(() => {
    vi.stubEnv("GL_TEST_KEY", "sk-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("substitutes a known variable", () => {
    expect(resolveEnv("Bearer ${GL_TEST_KEY}")).toBe("Bearer sk-secret");
  });

  it("substitutes every occurrence", () => {
    expect(resolveEnv("${GL_TEST_KEY}-${GL_TEST_KEY}")).toBe("sk-secret-sk-secret");
  });

  it("substitutes an unknown variable with an empty string rather than leaving the placeholder", () => {
    // Leaves no literal `${...}` behind for a provider to choke on.
    expect(resolveEnv("x${GL_TOTALLY_UNSET}y")).toBe("xy");
  });

  it("leaves strings without placeholders alone", () => {
    expect(resolveEnv("plain value")).toBe("plain value");
  });
});

describe("deepMerge", () => {
  it("merges nested objects, with the override winning", () => {
    const merged = deepMerge(
      { server: { host: "127.0.0.1", port: 3720 }, keep: true },
      { server: { port: 4000 } }
    );
    expect(merged).toEqual({ server: { host: "127.0.0.1", port: 4000 }, keep: true });
  });

  it("replaces arrays instead of concatenating them", () => {
    // Load-bearing: a local override must be able to *reduce* the provider list.
    const merged = deepMerge({ providers: [{ id: "a" }, { id: "b" }] }, { providers: [{ id: "c" }] });
    expect(merged).toEqual({ providers: [{ id: "c" }] });
  });

  it("keeps the base value when the override is undefined", () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it("adds keys that only the override has", () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("treats an object/array mismatch as a replacement", () => {
    expect(deepMerge({ a: { b: 1 } }, { a: [1] })).toEqual({ a: [1] });
    expect(deepMerge({ a: [1] }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });
});

describe("withDefaults", () => {
  it("fills in every default for an empty config", () => {
    const config = withDefaults({});
    expect(config.server).toEqual({ host: "127.0.0.1", port: 3720 });
    expect(config.defaultProvider).toBe("openai");
    expect(config.defaultModel).toBe("");
    expect(config.providers).toEqual([]);
    expect(config.tools.webSearch.provider).toBe("bing");
    expect(config.tools.webSearch.maxResults).toBe(5);
    expect(config.tools.webFetch).toEqual({ enabled: true, maxChars: 20_000 });
  });

  it("nests the fallback workspaces dir under the project root", () => {
    expect(withDefaults({}).workspaces.rootDir).toMatch(/\/workspaces$/);
  });

  it("honours explicit values over the defaults", () => {
    const config = withDefaults({
      server: { host: "0.0.0.0", port: 9999 },
      tools: { webFetch: { enabled: false, maxChars: 100 } },
    });
    expect(config.server).toEqual({ host: "0.0.0.0", port: 9999 });
    expect(config.tools.webFetch).toEqual({ enabled: false, maxChars: 100 });
  });

  it("parses a numeric field written as an ${ENV} placeholder", () => {
    // Placeholders are substituted after YAML parsing, so `port: ${PORT}` reaches here as
    // a string. Rejecting it silently fell back to 3720 — a config that is quietly ignored.
    expect(withDefaults({ server: { port: "9999" } }).server.port).toBe(9999);
    expect(withDefaults({ tools: { webFetch: { maxChars: "512" } } }).tools.webFetch.maxChars).toBe(512);
  });

  it("falls back for a numeric field that is empty or not a number", () => {
    // A missing env var resolves to "" — the field must not become NaN.
    expect(withDefaults({ server: { port: "" } }).server.port).toBe(3720);
    expect(withDefaults({ server: { port: "not a port" } }).server.port).toBe(3720);
    expect(withDefaults({ server: { port: null } }).server.port).toBe(3720);
    expect(withDefaults({ server: { port: Number.NaN } }).server.port).toBe(3720);
  });

  it("keeps an absolute workspaces rootDir as-is", () => {
    expect(withDefaults({ workspaces: { rootDir: "/tmp/somewhere" } }).workspaces.rootDir).toBe(
      "/tmp/somewhere"
    );
  });

  it("maps providers and their models", () => {
    const config = withDefaults({
      providers: [{ id: "p", name: "P", baseURL: "http://x", apiKey: "k", models: [{ id: "m", name: "M" }] }],
    });
    expect(config.providers).toEqual([
      { id: "p", name: "P", baseURL: "http://x", apiKey: "k", models: [{ id: "m", name: "M" }] },
    ]);
  });

  it("names an unnamed provider after its id", () => {
    const config = withDefaults({ providers: [{ id: "p", baseURL: "http://x", models: [] }] });
    expect(config.providers[0]!.name).toBe("p");
  });

  it("ignores a non-array providers node", () => {
    expect(withDefaults({ providers: "nope" }).providers).toEqual([]);
  });
});

describe("validateConfig", () => {
  const base: AppConfig = withDefaults({
    providers: [{ id: "p", name: "P", baseURL: "http://x", models: [] }],
    defaultProvider: "p",
    defaultModel: "m",
  });

  it("accepts a complete config", () => {
    expect(() => validateConfig(base)).not.toThrow();
  });

  it("rejects a config with no providers", () => {
    expect(() => validateConfig({ ...base, providers: [] })).toThrow(/No providers configured/);
  });

  it("rejects a defaultProvider that matches nothing", () => {
    expect(() => validateConfig({ ...base, defaultProvider: "nope" })).toThrow(
      /does not match any configured provider id/
    );
  });

  it("rejects an empty defaultModel", () => {
    expect(() => validateConfig({ ...base, defaultModel: "" })).toThrow(/defaultModel must be set/);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gl-config-"));
    vi.resetModules();
    vi.stubEnv("GL_CONFIG_KEY", "from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.GL_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const path = join(dir, "config.yaml");
    writeFileSync(path, yaml);
    return path;
  }

  async function load(yaml: string) {
    process.env.GL_CONFIG_PATH = writeConfig(yaml);
    const mod = await import("../src/config.js");
    return mod.loadConfig();
  }

  it("resolves ${ENV} placeholders from the environment", async () => {
    const config = await load(`
workspaces: { rootDir: ${dir}/ws }
defaultProvider: p
defaultModel: m
providers:
  - id: p
    name: P
    baseURL: http://x
    apiKey: \${GL_CONFIG_KEY}
    models: [{ id: m, name: M }]
`);
    expect(config.providers[0]!.apiKey).toBe("from-env");
  });

  it("caches the result for the life of the module", async () => {
    process.env.GL_CONFIG_PATH = writeConfig(`
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
    const mod = await import("../src/config.js");
    expect(mod.loadConfig()).toBe(mod.loadConfig());
  });

  it("surfaces a config error instead of booting half-configured", async () => {
    await expect(load("providers: []\n")).rejects.toThrow(/No providers configured/);
  });
});
