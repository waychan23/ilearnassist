import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { DocumentParsePolicy, DocumentParserKind } from "@ilearnassist/shared";
import { isModelCapability, MODEL_CAPABILITIES, type ModelCapability } from "@ilearnassist/shared";

export type WebSearchProvider = "bing" | "tavily" | "duckduckgo" | "searxng";

export interface ModelDef {
  id: string;
  name: string;
  /**
   * What this model can do. **Declared here rather than guessed**, because the three
   * capabilities change behaviour and not just a badge: `vision` decides whether an image is
   * sent or becomes a placeholder, `reasoning` decides whether chain-of-thought is replayed
   * on tool-call messages, `tool_use` decides whether tools are offered.
   *
   * A vendor's model ids do not say any of that. `glm-5.3` and `glm-5v-turbo` differ by one
   * word and only the second sees pictures; `kimi-k3` always thinks while `kimi-k2.6` can be
   * told not to. A regex over ids guessed wrong quietly, which is how a seeded provider ends
   * up failing on every turn.
   *
   * Omitted means `guessCapabilities(modelId)` — right for a model id that names its family
   * (`gemini-…`, `gpt-5…`), and the fallback for an entry written before this field existed.
   */
  capabilities?: ModelCapability[];
}

export interface ProviderDef {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  models: ModelDef[];
}

export interface WebSearchConfig {
  provider: WebSearchProvider;
  maxResults: number;
  tavilyApiKey?: string;
  searxngBaseURL?: string;
  bingEndpoint?: string;
  duckduckgoEndpoint?: string;
}

export interface WebFetchConfig {
  enabled: boolean;
  /** Maximum characters of extracted page text handed back to the model. */
  maxChars: number;
}

/** Seed entry for a cloud document parser. Structurally mirrors `DocumentParserConfig`. */
export interface DocumentParserDef {
  id: string;
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  apiKey?: string;
  enabled?: boolean;
}

export interface DocumentParsingDefaults {
  localEnabled: boolean;
  policy: DocumentParsePolicy;
  fallbackEnabled: boolean;
  defaultParserId?: string | null;
}

/** Operational limits for text extraction. None of these are user-facing knobs. */
export interface DocumentsConfig {
  /** Above this, local extraction is skipped and the file is offered to a cloud parser. */
  localMaxBytes: number;
  /** Ceiling on stored extracted text, so one pathological file cannot fill the disk. */
  maxTextChars: number;
  /** How many documents parse at once. */
  concurrency: number;
  requestTimeoutMs: number;
  /** Total budget for one async cloud job, polling included. */
  jobTimeoutMs: number;
  pollIntervalMs: number;
}

export interface AppConfig {
  server: { host: string; port: number };
  defaultProvider: string;
  defaultModel: string;
  providers: ProviderDef[];
  documentParsers: DocumentParserDef[];
  documentParsing: DocumentParsingDefaults;
  tools: {
    webSearch: WebSearchConfig;
    webFetch: WebFetchConfig;
    fileTools: { enabled: boolean };
    documents: DocumentsConfig;
  };
}

/**
 * Root holding `config/` and `.env` — the *application's* writable state, as opposed to the
 * user's data, which lives under the chosen data root (`resolveDataRoot`) instead.
 *
 * Keeping them apart is what makes "move my data to a new machine" a copy of one directory:
 * the bundle is read-only, `config/` is seeded once and then belongs to the user, and the
 * database, workspaces and uploads are wherever they chose to put them. The two are not
 * interchangeable, and a backup that takes only one of them is incomplete.
 *
 * Defaults to the project root, derived from this file's own location
 * (`<root>/apps/server/src/config.ts`). That is right for a checkout and wrong for a
 * packaged desktop build, where the code sits in a read-only bundle — so the desktop shell
 * sets `ILA_PROJECT_ROOT` and this defers to it. Same contract as `ILA_DATA_DIR`: read once,
 * at import time, so it must be set before this module is first imported.
 */
const PROJECT_ROOT = process.env.ILA_PROJECT_ROOT
  ? resolve(process.env.ILA_PROJECT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_DIR = resolve(PROJECT_ROOT, "config");

/** Replace `${VAR}` placeholders in a string from process.env (missing vars → empty). */
export function resolveEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    return v === undefined ? "" : v;
  });
}

/**
 * Load a project-root `.env` file (KEY=VALUE) into process.env. Only sets keys
 * that aren't already present, so real environment variables always win.
 *
 * Called once, at module scope and below, rather than from `loadConfig()` where it used to
 * live. The reason is ordering: `resolveDataRoot()` reads `ILA_DATA_DIR` from the
 * environment and is called by `main()` *before* the config is loaded, so a `.env` that
 * carries the data root would otherwise be read too late to be honoured. Idempotent, so
 * the move costs nothing.
 */
function loadDotEnv(): void {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// Deliberately here, one line below the definition, and deliberately before any reader of
// the environment below it: `resolveDataRoot` reads `ILA_DATA_DIR`, and `PROJECT_ROOT` —
// which is what locates the `.env` file in the first place — is already computed above.
loadDotEnv();

/** Recursively resolve env placeholders on any string value. */
function resolveEnvDeep(node: unknown): unknown {
  if (typeof node === "string") return resolveEnv(node);
  if (Array.isArray(node)) return node.map(resolveEnvDeep);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = resolveEnvDeep(value);
    return out;
  }
  return node;
}

/** Deep-merge `override` onto `base`; arrays are replaced rather than concatenated. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(override) || Array.isArray(base)) return override ?? base;
  if (
    base &&
    override &&
    typeof base === "object" &&
    typeof override === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(override)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out;
  }
  return override === undefined ? base : override;
}

function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/**
 * Read `<dataRoot>/config.patch.json`, the deployment's configuration overlay.
 *
 * Absent is the normal case and returns `{}`. **Malformed throws**, naming the file: a patch that
 * silently does nothing is exactly the failure this file exists to prevent, and a person who has
 * just edited it by hand is the one reader who most needs to be told. (An empty file is malformed
 * too, by the same argument — `JSON.parse("")` throws, and the error names the path.)
 *
 * `undefined` for the path means there is no data root to read from — the unit test suite's case —
 * which is deliberately *not* an error. See `loadConfig` for why the caller passes it rather than
 * this function resolving it.
 */
export function readConfigPatch(path: string | undefined): Record<string, unknown> {
  if (!path || !existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `config.patch.json is not valid JSON: ${path}\n${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config.patch.json must hold a JSON object at its top level: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

/** Coerce an unknown config node into a plain object (or empty object). */
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
/**
 * Coerce a scalar to a number.
 *
 * Accepts numeric strings as well as numbers: an `${ENV}` placeholder is substituted
 * *after* YAML parsing, so `port: ${PORT}` arrives here as the string "3802". Without this
 * it silently fell back to the default, which is a confusing way for a config to be
 * ignored.
 */
function asNum(v: unknown, fallback: number): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}
function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Read a model's declared `capabilities`, or `undefined` for "let `guessCapabilities` decide".
 *
 * An unrecognised name **throws** rather than being dropped. Dropping is the wrong answer
 * here even though this file drops an unrecognised parser `kind`: a parser without a kind
 * cannot work at all, while a model missing one capability is a model that mostly works —
 * so a typo would cost one silent behaviour (images arriving as a placeholder, or thinking
 * never being replayed) and be found much later, if ever. `label` names the entry, because
 * "unknown capability" without saying which model is a message about nothing.
 */
function parseCapabilities(v: unknown, label: string): ModelCapability[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new Error(`Model ${label}: capabilities must be a list.`);
  }
  for (const entry of v) {
    if (!isModelCapability(entry)) {
      throw new Error(
        `Model ${label}: unknown capability ${JSON.stringify(entry)}. ` +
          `Expected one of ${MODEL_CAPABILITIES.join(", ")}.`
      );
    }
  }
  return v as ModelCapability[];
}

export function withDefaults(raw: Record<string, unknown>): AppConfig {
  const server = asObj(raw["server"]);
  const tools = asObj(raw["tools"]);
  const webSearch = asObj(tools["webSearch"]);
  const webFetch = asObj(tools["webFetch"]);
  const fileTools = asObj(tools["fileTools"]);
  const documents = asObj(tools["documents"]);
  const documentParsing = asObj(raw["documentParsing"]);

  return {
    server: {
      host: asStr(server["host"], "127.0.0.1"),
      port: asNum(server["port"], 3720),
    },
    defaultProvider: asStr(raw["defaultProvider"], "openai"),
    defaultModel: asStr(raw["defaultModel"], ""),
    providers: Array.isArray(raw["providers"])
      ? (raw["providers"] as unknown[]).map((p) => {
          const v = asObj(p);
          const models: ModelDef[] = Array.isArray(v["models"])
            ? (v["models"] as unknown[]).map((m) => {
                const mv = asObj(m);
                const declared = mv["capabilities"];
                return {
                  id: String(mv["id"]),
                  name: asStr(mv["name"], String(mv["id"])),
                  capabilities: parseCapabilities(
                    declared,
                    `${String(v["id"])}/${String(mv["id"])}`
                  ),
                };
              })
            : [];
          return {
            id: String(v["id"]),
            name: asStr(v["name"], String(v["id"])),
            baseURL: String(v["baseURL"]),
            apiKey: typeof v["apiKey"] === "string" ? v["apiKey"] : undefined,
            models,
          } as ProviderDef;
        })
      : [],
    documentParsers: Array.isArray(raw["documentParsers"])
      ? (raw["documentParsers"] as unknown[])
          .map((p) => {
            const v = asObj(p);
            const kind = asStr(v["kind"], "");
            return {
              id: String(v["id"]),
              name: asStr(v["name"], String(v["id"])),
              kind: kind as DocumentParserKind,
              // `asStr` rather than `String`: a missing baseURL must become "", not the
              // string "undefined", which is truthy and would survive the filter below.
              baseURL: asStr(v["baseURL"], ""),
              apiKey: typeof v["apiKey"] === "string" ? v["apiKey"] : undefined,
              enabled: v["enabled"] === undefined ? true : asBool(v["enabled"], true),
            } as DocumentParserDef;
          })
          // An unrecognised `kind` would fail at parse time, long after boot. Drop it here,
          // where the config is still being read, rather than shipping a broken record.
          .filter((p) => isParserKind(p.kind) && p.baseURL)
      : [],
    documentParsing: {
      localEnabled: asBool(documentParsing["localEnabled"], true),
      policy: isPolicy(documentParsing["policy"]) ? documentParsing["policy"] : "local-first",
      fallbackEnabled: asBool(documentParsing["fallbackEnabled"], true),
      defaultParserId:
        typeof documentParsing["defaultParserId"] === "string"
          ? documentParsing["defaultParserId"]
          : null,
    },
    tools: {
      webSearch: {
        provider: (webSearch["provider"] as WebSearchProvider) ?? "bing",
        maxResults: asNum(webSearch["maxResults"], 5),
        tavilyApiKey: typeof webSearch["tavilyApiKey"] === "string" ? webSearch["tavilyApiKey"] : undefined,
        searxngBaseURL: typeof webSearch["searxngBaseURL"] === "string" ? webSearch["searxngBaseURL"] : undefined,
        bingEndpoint: asStr(webSearch["bingEndpoint"], "https://www.bing.com/search"),
        duckduckgoEndpoint: asStr(
          webSearch["duckduckgoEndpoint"],
          "https://html.duckduckgo.com/html/"
        ),
      },
      webFetch: {
        enabled: asBool(webFetch["enabled"], true),
        maxChars: asNum(webFetch["maxChars"], 20_000),
      },
      fileTools: {
        enabled: asBool(fileTools["enabled"], true),
      },
      documents: {
        localMaxBytes: asNum(documents["localMaxBytes"], 20 * 1024 * 1024),
        maxTextChars: asNum(documents["maxTextChars"], 2_000_000),
        concurrency: Math.max(1, asNum(documents["concurrency"], 2)),
        requestTimeoutMs: asNum(documents["requestTimeoutMs"], 30_000),
        jobTimeoutMs: asNum(documents["jobTimeoutMs"], 300_000),
        pollIntervalMs: asNum(documents["pollIntervalMs"], 3_000),
      },
    },
  };
}

const PARSE_POLICIES: DocumentParsePolicy[] = [
  "local-only",
  "local-first",
  "cloud-first",
  "cloud-only",
];

function isPolicy(value: unknown): value is DocumentParsePolicy {
  return typeof value === "string" && (PARSE_POLICIES as string[]).includes(value);
}

function isParserKind(value: unknown): value is DocumentParserKind {
  return value === "sync" || value === "mineru" || value === "llamaparse";
}

let cached: AppConfig | undefined;

/**
 * Load the config (base + optional local override + the deployment's patch), resolving env
 * placeholders.
 *
 * `patch` is the deployment overlay, read from `<dataRoot>/config.patch.json` and handed in by the
 * caller rather than resolved here. That is the same rule `configureModelLog` follows, and for the
 * same reason: `ILA_DATA_DIR` reaches `process.env` through a checked-in `.env`, so a path resolved
 * inside this module would make the unit suite's results depend on whatever the machine running it
 * happens to have in its data folder. Every existing caller passes nothing and gets exactly what it
 * got before.
 *
 * It merges *before* env resolution and `withDefaults`, so `${ENV}` works inside a patch and the
 * result flows through the ordinary validation — a patch is not a second configuration system, it
 * is an earlier layer of the same one. Arrays replace rather than concatenate (`deepMerge`'s rule),
 * which is what makes "this list, not that one" expressible.
 *
 * A `prompts` section passes through this merge untouched and unread: the catalog is not part of
 * `AppConfig`, it is its own registry (`prompts.ts`), and the process entry point hands the same
 * section to `setPromptOverrides` as well. One file, two readers, each taking its own key — which
 * is what makes the patch a general mechanism rather than a prompt feature with a config-shaped
 * wrapper.
 */
export function loadConfig(patch: Record<string, unknown> = {}): AppConfig {
  if (cached) return cached;

  const basePath = resolve(CONFIG_DIR, "config.yaml");
  const localPath = process.env.ILA_CONFIG_PATH
    ? process.env.ILA_CONFIG_PATH
    : resolve(CONFIG_DIR, "config.local.yaml");

  const base = readYaml(basePath);
  const local = readYaml(localPath);

  const merged = resolveEnvDeep(deepMerge(deepMerge(base, local), patch)) as Record<string, unknown>;
  const config = withDefaults(merged);

  // `ILA_HOST` overrides the bind address, for the same reason `ILA_DATA_DIR` overrides the
  // data directory: the desktop shell changes it *at runtime*. Letting a phone on the same
  // network open the app means binding beyond loopback, and the two config files are both
  // disqualified — `config.yaml` is the shared bootstrap, and the `config.local.yaml`
  // overlay is seeded once and then belongs to the user, who may have put a port or a key
  // in it. An environment variable is the only channel that can differ per launch without
  // rewriting something the user owns.
  const host = process.env.ILA_HOST?.trim();
  if (host) config.server.host = host;

  validateConfig(config);
  cached = config;
  return config;
}

export function validateConfig(config: AppConfig): void {
  if (config.providers.length === 0) {
    throw new Error("No providers configured. Add at least one entry to config/config.yaml.");
  }
  const ids = new Set(config.providers.map((p) => p.id));
  if (!ids.has(config.defaultProvider)) {
    throw new Error(
      `defaultProvider "${config.defaultProvider}" does not match any configured provider id.`
    );
  }
  if (!config.defaultModel) {
    throw new Error("defaultModel must be set in config/config.yaml.");
  }

  /*
   * And that it is a model the provider actually has.
   *
   * `defaultProvider` has been checked against the provider list since the beginning; the model
   * half was not, and the hole is not theoretical — a *retired* model id read perfectly well as a
   * string while naming nothing, so a fresh install seeded a default that its own provider could
   * not serve, and the failure surfaced as a conversation that would not send rather than as a
   * config error. The two fields are seeded together from this file, so "the pair is coherent
   * here" is exactly the property a fresh install depends on.
   */
  const provider = config.providers.find((p) => p.id === config.defaultProvider);
  if (provider && !provider.models.some((m) => m.id === config.defaultModel)) {
    throw new Error(
      `defaultModel "${config.defaultModel}" is not one of ${config.defaultProvider}'s models ` +
        `(${provider.models.map((m) => m.id).join(", ") || "none"}).`
    );
  }

  // Document parser ids are primary keys; a duplicate would fail at seed time with an
  // opaque SQLite constraint error instead of naming the offending entry.
  const parserIds = new Set<string>();
  for (const parser of config.documentParsers) {
    if (parserIds.has(parser.id)) {
      throw new Error(`Duplicate documentParsers id "${parser.id}" in config/config.yaml.`);
    }
    parserIds.add(parser.id);
  }
  if (config.documentParsing.defaultParserId && !parserIds.has(config.documentParsing.defaultParserId)) {
    throw new Error(
      `documentParsing.defaultParserId "${config.documentParsing.defaultParserId}" does not match any configured documentParsers id.`
    );
  }
}

export function getProviderConfig(config: AppConfig, providerId?: string): ProviderDef {
  const id = providerId ?? config.defaultProvider;
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/** The environment variable naming the data root. Spelled once, used by the error below. */
export const DATA_DIR_ENV = "ILA_DATA_DIR";

/**
 * The runtime data root, which holds the database, every user's workspaces and their
 * uploaded files. **Required, with no default.**
 *
 * There is deliberately nothing to fall back to. The previous default was
 * `<PROJECT_ROOT>/data`, which for a packed build is inside the application bundle — so
 * uninstalling or updating the app took the user's notes, conversations and documents with
 * it. A path that decides how much of their work survives is the user's to choose, and a
 * default is only ever the choice nobody made.
 *
 * Read from the environment rather than from `config.yaml`, for the same reason `ILA_HOST`
 * is: the launcher sets it *per launch* (the desktop panel asks, then passes it to the
 * child), and a value in a config file cannot differ between two runs of the same install.
 * `.env` counts as the environment, which is what lets a checkout take the checked-in
 * default in `config/config.yaml` without the code carrying one — `loadDotEnv()` runs at
 * import time, above.
 *
 * A *relative* value resolves against the project root, not the working directory.
 * `ILA_DATA_DIR=./data` in the project's `.env` has to mean the project's `data/`, and the
 * working directory is not that: `pnpm dev` runs the server script with its cwd set to
 * `apps/server`, so resolving against cwd would quietly put the data in a subdirectory of the
 * package. The project root is also the stable answer — it does not depend on who launched
 * the process.
 *
 * Throws rather than exiting, so the caller decides how to report it. Called by `main()` and
 * never at module scope: this file is imported by the test suite, and a top-level throw
 * would take out every test that never starts a server.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[DATA_DIR_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `${DATA_DIR_ENV} is not set. ilearnassist keeps its database, uploaded documents and ` +
        `workspaces in a directory you choose, so it will not guess one — and it must live ` +
        `outside the application bundle, or uninstalling the app would take your data with ` +
        `it. Set ${DATA_DIR_ENV} to a path, or launch the desktop app, which asks for one and ` +
        `passes it down. A checkout can put it in .env (see .env.example).`
    );
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(PROJECT_ROOT, raw);
}

/** The environment variable that overrides the thread classifier's reasoning mode. */
export const THREAD_REASONING_ENV = "ILA_THREAD_REASONING";

/**
 * The environment variable that overrides the insight pass's reasoning mode.
 *
 * A **second switch rather than a reuse** of the classifier's, and the docblock on that one is
 * the reason: it changes "this classifier call alone", by design. Overloading it would make
 * tuning the topic classifier silently re-tune the reflection pass, and the two want different
 * answers — the classifier judges, while an insight pass is the kind of thinking that benefits
 * from time.
 */
export const INSIGHT_REASONING_ENV = "ILA_INSIGHT_REASONING";

/**
 * Whether an out-of-band model call may run chain-of-thought.
 *
 * - `auto` (unset): follow the model record — a model with the `reasoning` capability thinks
 *   (the provider's own default; nothing is sent), any other model never does.
 * - `on` / `off`: an explicit override sent on the wire as `thinking.type` (the DeepSeek /
 *   Ark shape). Still gated on the model's `reasoning` capability, so a provider that does
 *   not know the field is never sent it.
 */
export type OutOfBandReasoningSetting = "auto" | "on" | "off";

const THREAD_REASONING_ALIASES: Record<string, OutOfBandReasoningSetting> = {
  auto: "auto",
  on: "on",
  off: "off",
  enabled: "on",
  disabled: "off",
  true: "on",
  false: "off",
  "1": "on",
  "0": "off",
  yes: "on",
  no: "off",
};

/**
 * Parse a reasoning override: blank/absent is `auto`, anything unrecognised throws.
 *
 * `name` is the variable being read, so the error names the switch the operator actually set —
 * there are two of them now, and "expected one of auto, on, off" under the wrong name is a
 * message about a setting nobody touched.
 */
export function parseReasoning(
  raw: string | undefined | null,
  name: string
): OutOfBandReasoningSetting {
  const value = raw?.trim().toLowerCase();
  if (!value) return "auto";
  const setting = THREAD_REASONING_ALIASES[value];
  if (!setting) {
    throw new Error(
      `${name} has an invalid value ${JSON.stringify(value)}: ` +
        "expected one of auto, on, off (or true/false, 1/0, enabled/disabled)."
    );
  }
  return setting;
}

/** Read the thread-classifier reasoning override from the process environment. */
export function threadReasoningSetting(
  env: NodeJS.ProcessEnv = process.env
): OutOfBandReasoningSetting {
  return parseReasoning(env[THREAD_REASONING_ENV], THREAD_REASONING_ENV);
}

/** Read the insight pass's reasoning override. Defaults to `auto`, like the classifier's. */
export function insightReasoningSetting(
  env: NodeJS.ProcessEnv = process.env
): OutOfBandReasoningSetting {
  return parseReasoning(env[INSIGHT_REASONING_ENV], INSIGHT_REASONING_ENV);
}

/**
 * The built frontend (`apps/web/dist`), which this server also serves so the whole app
 * answers on one origin with no reverse proxy in front of it.
 *
 * Two ways it can be absent, and both are normal: a plain checkout has no `dist/` until
 * `pnpm build` has run, and a packed desktop bundle carries its own copy elsewhere and
 * points `ILA_WEB_DIR` at it. When there is no `index.html` to serve, the server is
 * API-only, exactly as it was before.
 */
const WEB_DIR = process.env.ILA_WEB_DIR
  ? resolve(process.env.ILA_WEB_DIR)
  : resolve(PROJECT_ROOT, "apps/web/dist");

export const PROJECT_PATHS = {
  projectRoot: PROJECT_ROOT,
  configDir: CONFIG_DIR,
  webDir: WEB_DIR,
} as const;