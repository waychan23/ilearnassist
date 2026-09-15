import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_PATHS,
  THREAD_REASONING_ENV,
  deepMerge,
  insightReasoningSetting,
  INSIGHT_REASONING_ENV,
  parseReasoning,
  resolveDataRoot,
  resolveEnv,
  threadReasoningSetting,
  validateConfig,
  withDefaults,
  type AppConfig,
} from "../src/config.js";

describe("resolveEnv", () => {
  beforeEach(() => {
    vi.stubEnv("ILA_TEST_KEY", "sk-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("substitutes a known variable", () => {
    expect(resolveEnv("Bearer ${ILA_TEST_KEY}")).toBe("Bearer sk-secret");
  });

  it("substitutes every occurrence", () => {
    expect(resolveEnv("${ILA_TEST_KEY}-${ILA_TEST_KEY}")).toBe("sk-secret-sk-secret");
  });

  it("substitutes an unknown variable with an empty string rather than leaving the placeholder", () => {
    // Leaves no literal `${...}` behind for a provider to choke on.
    expect(resolveEnv("x${ILA_TOTALLY_UNSET}y")).toBe("xy");
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
    vi.stubEnv("ILA_CONFIG_KEY", "from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.ILA_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const path = join(dir, "config.yaml");
    writeFileSync(path, yaml);
    return path;
  }

  async function load(yaml: string) {
    process.env.ILA_CONFIG_PATH = writeConfig(yaml);
    const mod = await import("../src/config.js");
    return mod.loadConfig();
  }

  it("resolves ${ENV} placeholders from the environment", async () => {
    const config = await load(`
defaultProvider: p
defaultModel: m
providers:
  - id: p
    name: P
    baseURL: http://x
    apiKey: \${ILA_CONFIG_KEY}
    models: [{ id: m, name: M }]
`);
    expect(config.providers[0]!.apiKey).toBe("from-env");
  });

  it("caches the result for the life of the module", async () => {
    process.env.ILA_CONFIG_PATH = writeConfig(`
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

  it("lets ILA_HOST override the configured bind address", async () => {
    // The desktop shell's "open on your phone" switch rebinds the server to every
    // interface. It cannot do that by editing a config file — the overlay belongs to the
    // user once seeded — so the override has to come from the environment.
    vi.stubEnv("ILA_HOST", "0.0.0.0");
    const config = await load(`
server: { host: 127.0.0.1, port: 3720 }
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
    expect(config.server.host).toBe("0.0.0.0");
  });

  it("leaves the configured host alone when ILA_HOST is unset", async () => {
    const config = await load(`
server: { host: 127.0.0.1, port: 3720 }
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("ignores a blank ILA_HOST rather than binding to nothing", async () => {
    // An empty string would be passed straight to `listen`, which rejects it — turning an
    // unset-but-present variable into a boot failure.
    vi.stubEnv("ILA_HOST", "   ");
    const config = await load(`
server: { host: 127.0.0.1, port: 3720 }
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
    expect(config.server.host).toBe("127.0.0.1");
  });
});

describe("resolveDataRoot", () => {
  it("throws when the variable is unset, rather than inventing a path", () => {
    // Removing the default is the point: a path that decides how much of the user's work
    // survives an uninstall is not the code's to choose. Blank counts as unset — an empty
    // string would otherwise resolve to the working directory and look like a real answer.
    expect(() => resolveDataRoot({})).toThrow(/ILA_DATA_DIR is not set/);
    expect(() => resolveDataRoot({ ILA_DATA_DIR: "   " })).toThrow(/ILA_DATA_DIR is not set/);
  });

  it("resolves a relative path against the project root, not the working directory", () => {
    // A relative value in the project's `.env` has to mean the project's own directory.
    // `pnpm dev` runs the server script with its cwd set to `apps/server`, so resolving
    // against cwd would quietly scatter the data into a subdirectory of the package — and
    // give a different answer depending on who launched the process.
    //
    // Asserted against the project root rather than by comparing with `process.cwd()`,
    // because under this runner the two happen to be the same directory and a comparison
    // would pass whatever the rule was.
    const resolved = resolveDataRoot({ ILA_DATA_DIR: "./somewhere" });
    expect(resolved).toBe(resolve(PROJECT_PATHS.projectRoot, "somewhere"));
    expect(resolved.startsWith(PROJECT_PATHS.projectRoot + "/")).toBe(true);
  });

  it("takes an absolute path as given", () => {
    expect(resolveDataRoot({ ILA_DATA_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  });

  it("reads the real environment by default, which is the door `.env` comes in through", () => {
    // `loadDotEnv()` runs at module scope and writes only into `process.env`, so a value in
    // `.env` arrives here by exactly the same route as one exported by a shell — no separate
    // code path, and nothing to keep in step.
    vi.stubEnv("ILA_DATA_DIR", "/tmp/from-env");
    try {
      expect(resolveDataRoot()).toBe("/tmp/from-env");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the out-of-band reasoning switches", () => {
  const NAME = THREAD_REASONING_ENV;

  it("defaults to auto when the variable is absent or blank", () => {
    expect(parseReasoning(undefined, NAME)).toBe("auto");
    expect(parseReasoning(null, NAME)).toBe("auto");
    expect(parseReasoning("", NAME)).toBe("auto");
    expect(parseReasoning("   ", NAME)).toBe("auto");
    expect(threadReasoningSetting({})).toBe("auto");
    expect(insightReasoningSetting({})).toBe("auto");
  });

  it.each([
    ["on", "on"],
    ["ON", "on"],
    [" true ", "on"],
    ["1", "on"],
    ["enabled", "on"],
    ["yes", "on"],
    ["off", "off"],
    ["False", "off"],
    ["0", "off"],
    ["disabled", "off"],
    ["no", "off"],
    ["auto", "auto"],
  ])("parses %j as %s", (raw, expected) => {
    expect(parseReasoning(raw, NAME)).toBe(expected);
  });

  it("throws on an unrecognised value, naming the variable and the accepted values", () => {
    // A typo silently falling back to auto would run an A/B experiment whose knob did not
    // move; the boot-time error is the whole point.
    expect(() => parseReasoning("oops", NAME)).toThrow(new RegExp(`${NAME}.*auto, on, off`));
  });

  it("names the switch that was actually set, not whichever one is first", () => {
    // Two switches now share the parser, and the error is the only thing that tells an operator
    // which one they mistyped. A shared message naming the classifier's variable would send
    // them to the wrong line of their `.env`.
    expect(() => insightReasoningSetting({ [INSIGHT_REASONING_ENV]: "oops" })).toThrow(
      new RegExp(`${INSIGHT_REASONING_ENV}.*auto, on, off`)
    );
  });

  it("reads the real environment by default", () => {
    vi.stubEnv(THREAD_REASONING_ENV, "off");
    vi.stubEnv(INSIGHT_REASONING_ENV, "on");
    try {
      expect(threadReasoningSetting()).toBe("off");
      expect(insightReasoningSetting()).toBe("on");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the two switches independent", () => {
    // The whole reason for a second variable: tuning the classifier must not silently re-tune
    // the reflection pass, and vice versa.
    expect(threadReasoningSetting({ [INSIGHT_REASONING_ENV]: "off" })).toBe("auto");
    expect(insightReasoningSetting({ [THREAD_REASONING_ENV]: "off" })).toBe("auto");
  });
});
