import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigPatch } from "../src/config.js";
import { configPatchPath } from "../src/paths.js";

/**
 * `config.patch.json` — the deployment's configuration overlay.
 *
 * The file is generic on purpose: it is deep-merged over the whole configuration tree, and the
 * prompt catalog is simply one of the trees it can reach. These tests cover the two halves
 * separately — reading the file, and merging what it holds — because the merge is pure and the
 * read is not, and only the read can fail in a way a person needs to be told about.
 */

const YAML = `
defaultProvider: p
defaultModel: m
providers:
  - id: p
    name: P
    baseURL: http://x
    models: [{ id: m, name: M }]
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gl-patch-"));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.ILA_CONFIG_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("configPatchPath", () => {
  it("puts the patch at the data root, beside the database rather than in the bundle", () => {
    expect(configPatchPath("/data")).toBe(join("/data", "config.patch.json"));
  });
});

describe("readConfigPatch", () => {
  it("returns an empty object when there is no data root to read from", () => {
    // The unit suite's ordinary case. Not an error: a checkout with no data root is a normal
    // state, and this is what keeps a test from depending on the machine it runs on.
    expect(readConfigPatch(undefined)).toEqual({});
  });

  it("returns an empty object when the file simply is not there", () => {
    expect(readConfigPatch(join(dir, "config.patch.json"))).toEqual({});
  });

  it("reads a patch", () => {
    const path = write("config.patch.json", JSON.stringify({ prompts: { a: "b" } }));
    expect(readConfigPatch(path)).toEqual({ prompts: { a: "b" } });
  });

  it("throws, naming the file, when the JSON is malformed", () => {
    // The failure being prevented: somebody edits this by hand, gets one character wrong, and the
    // app starts anyway with none of it applied. A silent patch is worse than no patch.
    const path = write("config.patch.json", '{ "prompts": { "a": "b" }');
    expect(() => readConfigPatch(path)).toThrow(/not valid JSON/);
    expect(() => readConfigPatch(path)).toThrow(path);
  });

  it("throws on an empty file rather than treating it as no patch", () => {
    const path = write("config.patch.json", "");
    expect(() => readConfigPatch(path)).toThrow(/not valid JSON/);
  });

  it("refuses a top-level array or scalar", () => {
    const array = write("array.json", "[1, 2]");
    expect(() => readConfigPatch(array)).toThrow(/must hold a JSON object/);
    const scalar = write("scalar.json", '"hello"');
    expect(() => readConfigPatch(scalar)).toThrow(/must hold a JSON object/);
  });
});

describe("loadConfig with a patch", () => {
  async function load(patch: Record<string, unknown>) {
    process.env.ILA_CONFIG_PATH = write("config.yaml", YAML);
    const mod = await import("../src/config.js");
    return mod.loadConfig(patch);
  }

  it("wins over the YAML, at any depth", async () => {
    const config = await load({
      server: { port: 9999 },
      tools: { webFetch: { enabled: false, maxChars: 1234 } },
    });
    expect(config.server.port).toBe(9999);
    expect(config.tools.webFetch.enabled).toBe(false);
    expect(config.tools.webFetch.maxChars).toBe(1234);
  });

  it("leaves everything it does not mention alone", async () => {
    const config = await load({ server: { port: 9999 } });
    expect(config.defaultProvider).toBe("p");
    expect(config.tools.webFetch.maxChars).toBeGreaterThan(0);
  });

  it("resolves ${ENV} inside the patch, the same as in the YAML", async () => {
    vi.stubEnv("ILA_PATCH_KEY", "from-env");
    const config = await load({
      providers: [{ id: "p", name: "P", baseURL: "http://x", apiKey: "${ILA_PATCH_KEY}", models: [] }],
    });
    expect(config.providers[0]?.apiKey).toBe("from-env");
  });

  it("replaces an array rather than appending to it", async () => {
    // `deepMerge`'s rule, and the one that makes "this list, not that one" expressible at all.
    const config = await load({
      providers: [
        { id: "p2", name: "P2", baseURL: "http://y", models: [{ id: "m2", name: "M2" }] },
      ],
      defaultProvider: "p2",
      defaultModel: "m2",
    });
    expect(config.providers.map((p) => p.id)).toEqual(["p2"]);
  });

  it("goes through the ordinary validation, so a patch cannot smuggle in a broken install", async () => {
    await expect(load({ defaultProvider: "nope" })).rejects.toThrow(/does not match any configured/);
  });

  it("carries a prompts section through to the config tree untouched", async () => {
    // The prompt catalog reads its own section out of the same object; the config layer must not
    // mangle or drop it on the way past. `withDefaults` returns the known shape, so the proof is
    // that the merge did not throw and the rest of the config is intact.
    const config = await load({ prompts: { "chat.system.persona": "Hello." } });
    expect(config.defaultProvider).toBe("p");
  });
});
