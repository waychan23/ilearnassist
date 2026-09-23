import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
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

/** The seed file a fresh install actually reads. Three levels up: test/ → server/ → apps/ → root. */
const SHIPPED_CONFIG = new URL("../../../config/config.yaml", import.meta.url);

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
      { server: { host: "127.0.0.1", port: 10471 }, keep: true },
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
    expect(config.server).toEqual({ host: "127.0.0.1", port: 10471 });
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
    // a string. Rejecting it silently fell back to 10471 — a config that is quietly ignored.
    expect(withDefaults({ server: { port: "9999" } }).server.port).toBe(9999);
    expect(withDefaults({ tools: { webFetch: { maxChars: "512" } } }).tools.webFetch.maxChars).toBe(512);
  });

  it("falls back for a numeric field that is empty or not a number", () => {
    // A missing env var resolves to "" — the field must not become NaN.
    expect(withDefaults({ server: { port: "" } }).server.port).toBe(10471);
    expect(withDefaults({ server: { port: "not a port" } }).server.port).toBe(10471);
    expect(withDefaults({ server: { port: null } }).server.port).toBe(10471);
    expect(withDefaults({ server: { port: Number.NaN } }).server.port).toBe(10471);
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

  it("reads a model's declared capabilities", () => {
    const config = withDefaults({
      providers: [
        {
          id: "p",
          baseURL: "http://x",
          models: [{ id: "glm-5.3", name: "GLM", capabilities: ["tool_use", "reasoning"] }],
        },
      ],
    });
    expect(config.providers[0]!.models[0]!.capabilities).toEqual(["tool_use", "reasoning"]);
  });

  it("leaves capabilities undefined so the id can be guessed", () => {
    const config = withDefaults({
      providers: [{ id: "p", baseURL: "http://x", models: [{ id: "m", name: "M" }] }],
    });
    expect(config.providers[0]!.models[0]!.capabilities).toBeUndefined();
  });

  it("refuses an unknown capability, naming the model", () => {
    // Dropped rather than thrown would be the quieter failure, and the worse one: a model
    // missing `vision` looks configured and silently stops seeing pictures.
    expect(() =>
      withDefaults({
        providers: [
          {
            id: "p",
            baseURL: "http://x",
            models: [{ id: "m1", name: "M1", capabilities: ["tool_use", "reasonig"] }],
          },
        ],
      })
    ).toThrow(/p\/m1.*reasonig/s);
  });

  it("refuses a capabilities node that is not a list", () => {
    expect(() =>
      withDefaults({
        providers: [{ id: "p", baseURL: "http://x", models: [{ id: "m", name: "M", capabilities: "vision" }] }],
      })
    ).toThrow(/capabilities must be a list/);
  });
});

describe("validateConfig", () => {
  /*
   * The provider has the model it defaults to, which the fixture used not to say — a provider with
   * no models whose default named one is a config that cannot work, and it sat here looking fine
   * until the check below was added and refused it.
   */
  const base: AppConfig = withDefaults({
    providers: [{ id: "p", name: "P", baseURL: "http://x", models: [{ id: "m", name: "M" }] }],
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

  it("rejects a defaultModel the default provider does not have", () => {
    /*
     * The hole a retired model id goes through: `deepseek-v4-pro` was still a perfectly good
     * string after DeepSeek retired it, so nothing objected — and a fresh install seeded a default
     * its own provider could not serve, which surfaces as a conversation that will not send rather
     * than as a config error. The two fields are seeded together from this file, so their
     * coherence here is what a first run depends on.
     */
    const withModels: AppConfig = withDefaults({
      providers: [{ id: "p", name: "P", baseURL: "http://x", models: [{ id: "m1", name: "M1" }] }],
      defaultProvider: "p",
      defaultModel: "m1",
    });
    expect(() => validateConfig(withModels)).not.toThrow();

    expect(() => validateConfig({ ...withModels, defaultModel: "retired-model" })).toThrow(
      /defaultModel "retired-model" is not one of p's models \(m1\)/
    );
  });

  it("names no models at all when the provider has none", () => {
    // The message has to stay readable for the empty case, which is what a half-written provider
    // entry looks like.
    const empty = withDefaults({
      providers: [{ id: "p", name: "P", baseURL: "http://x", models: [] }],
      defaultProvider: "p",
      defaultModel: "m",
    });
    expect(() => validateConfig(empty)).toThrow(/\(none\)/);
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
server: { host: 127.0.0.1, port: 10471 }
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
    expect(config.server.host).toBe("0.0.0.0");
  });

  it("leaves the configured host alone when ILA_HOST is unset", async () => {
    const config = await load(`
server: { host: 127.0.0.1, port: 10471 }
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("lets ILA_PORT override the configured port", async () => {
    // The panel owns the fixed port and changes it at runtime, like the bind address.
    vi.stubEnv("ILA_PORT", "4567");
    const config = await load(`
server: { host: 127.0.0.1, port: 10471 }
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
    expect(config.server.port).toBe(4567);
  });

  it("ignores a blank or unusable ILA_PORT rather than coercing it", async () => {
    // 0, 70000, "x", "3.5", and whitespace all leave the configured port alone — never an
    // OS-assigned port from a coerced value. Modules reset between cases because
    // `loadConfig` caches for the life of the module.
    for (const bad of ["   ", "0", "70000", "x", "3.5"]) {
      vi.resetModules();
      vi.stubEnv("ILA_PORT", bad);
      const config = await load(`
server: { host: 127.0.0.1, port: 10471 }
defaultProvider: p
defaultModel: m
providers: [{ id: p, name: P, baseURL: http://x, models: [{ id: m, name: M }] }]
`);
      expect(config.server.port, bad).toBe(10471);
    }
  });

  it("ignores a blank ILA_HOST rather than binding to nothing", async () => {
    // An empty string would be passed straight to `listen`, which rejects it — turning an
    // unset-but-present variable into a boot failure.
    vi.stubEnv("ILA_HOST", "   ");
    const config = await load(`
server: { host: 127.0.0.1, port: 10471 }
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
    // Two switches share the parser, and the error is the only thing that tells an operator
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

/**
 * The shipped seed, read as the code reads it.
 *
 * Everything else here tests `withDefaults` against a YAML string written in the test. This
 * group reads `config/config.yaml` itself, because that file is the one nobody exercises
 * until a user boots: an unknown capability name, a duplicated provider id or a
 * `defaultProvider` naming an entry that was renamed all fail at boot and nowhere earlier.
 * A test that parses the real file turns each of those into a red suite instead.
 */
describe("config/config.yaml", () => {
  const config = (() => {
    const raw = parse(readFileSync(SHIPPED_CONFIG, "utf8")) as Record<string, unknown>;
    return withDefaults(raw);
  })();

  it("parses, and validates against its own defaultProvider/defaultModel", () => {
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("seeds the built-in providers", () => {
    expect(config.providers.map((p) => p.id)).toEqual([
      "deepseek",
      "zhipu",
      "zhipu-intl",
      "qwen",
      "qwen-intl",
      "kimi",
      "kimi-intl",
      "minimax",
      "minimax-intl",
      "openai",
      "gemini",
    ]);
  });

  it("gives every seeded model at least tool_use", () => {
    // A model without `tool_use` is one the agent cannot call a tool on, which for a seeded
    // entry is always a mistake rather than a decision.
    for (const provider of config.providers) {
      expect(provider.models.length, `${provider.id} has no models`).toBeGreaterThan(0);
      for (const model of provider.models) {
        expect(model.capabilities, `${provider.id}/${model.id}`).toContain("tool_use");
      }
    }
  });

  it("states capabilities rather than leaving the built-ins to a guess", () => {
    // The point of the field. `glm-5.3` is the case that makes it necessary: the id says
    // nothing about reasoning, so a guess reads it as a plain chat model and DeepSeek-shaped
    // providers never get their chain-of-thought replayed.
    for (const provider of config.providers) {
      for (const model of provider.models) {
        expect(model.capabilities, `${provider.id}/${model.id} relies on the guess`).toBeDefined();
      }
    }
  });

  it("gives the same models to both regions of a vendor", () => {
    // The pairs exist so a user picks by network, not by capability. Two lists that drift
    // would make the choice mean something it does not say.
    const pairs: [string, string][] = [
      ["zhipu", "zhipu-intl"],
      ["qwen", "qwen-intl"],
      ["kimi", "kimi-intl"],
      ["minimax", "minimax-intl"],
    ];
    const ids = (id: string) =>
      config.providers
        .find((p) => p.id === id)!
        .models.map((m) => `${m.id}:${m.capabilities!.join(",")}`);

    for (const [cn, intl] of pairs) {
      expect(ids(cn), `${cn} vs ${intl}`).toEqual(ids(intl));
    }
  });

  it("does not declare reasoning for providers that cannot replay it", () => {
    // OpenAI and Gemini are reached through an OpenAI-compatibility layer that has no
    // `reasoning_content` field. Declaring the capability is what makes this app put the
    // field on the wire, so the omission is the point — see the comment on those entries.
    for (const id of ["openai", "gemini"]) {
      for (const model of config.providers.find((p) => p.id === id)!.models) {
        expect(model.capabilities, `${id}/${model.id}`).not.toContain("reasoning");
      }
    }
  });
});
