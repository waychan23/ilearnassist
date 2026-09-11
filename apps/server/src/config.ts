import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { DocumentParsePolicy, DocumentParserKind } from "@guided-learning/shared";

export type WebSearchProvider = "bing" | "tavily" | "duckduckgo" | "searxng";

export interface ModelDef {
  id: string;
  name: string;
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
  workspaces: { rootDir: string };
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

/** Project root resolved relative to this file (<root>/apps/server/src/config.ts). */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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

export function withDefaults(raw: Record<string, unknown>): AppConfig {
  const server = asObj(raw["server"]);
  const workspaces = asObj(raw["workspaces"]);
  const tools = asObj(raw["tools"]);
  const webSearch = asObj(tools["webSearch"]);
  const webFetch = asObj(tools["webFetch"]);
  const fileTools = asObj(tools["fileTools"]);
  const documents = asObj(tools["documents"]);
  const documentParsing = asObj(raw["documentParsing"]);

  const rootDirRaw = asStr(workspaces["rootDir"], "./workspaces");
  const rootDir = resolve(PROJECT_ROOT, rootDirRaw);

  return {
    server: {
      host: asStr(server["host"], "127.0.0.1"),
      port: asNum(server["port"], 3720),
    },
    workspaces: { rootDir },
    defaultProvider: asStr(raw["defaultProvider"], "openai"),
    defaultModel: asStr(raw["defaultModel"], ""),
    providers: Array.isArray(raw["providers"])
      ? (raw["providers"] as unknown[]).map((p) => {
          const v = asObj(p);
          const models = Array.isArray(v["models"]) ? (v["models"] as ModelDef[]) : [];
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

/** Load the config (base + optional local override), resolving env placeholders. */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  loadDotEnv();

  const basePath = resolve(CONFIG_DIR, "config.yaml");
  const localPath = process.env.GL_CONFIG_PATH
    ? process.env.GL_CONFIG_PATH
    : resolve(CONFIG_DIR, "config.local.yaml");

  const base = readYaml(basePath);
  const local = readYaml(localPath);

  const merged = resolveEnvDeep(deepMerge(base, local)) as Record<string, unknown>;
  const config = withDefaults(merged);

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

/**
 * Runtime data root — the sqlite database and the uploads tree live here.
 *
 * `GL_DATA_DIR` redirects it, which is what keeps the test suite and the e2e
 * harness from writing into the repo's real `data/` directory. It must be set
 * before this module is first imported: the value is read once, at import time.
 */
const DATA_DIR = process.env.GL_DATA_DIR
  ? resolve(process.env.GL_DATA_DIR)
  : resolve(PROJECT_ROOT, "data");

export const PROJECT_PATHS = {
  projectRoot: PROJECT_ROOT,
  configDir: CONFIG_DIR,
  dataDir: DATA_DIR,
} as const;