import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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

export interface AppConfig {
  server: { host: string; port: number };
  workspaces: { rootDir: string };
  defaultProvider: string;
  defaultModel: string;
  providers: ProviderDef[];
  tools: {
    webSearch: WebSearchConfig;
    webFetch: WebFetchConfig;
    fileTools: { enabled: boolean };
  };
}

/** Project root resolved relative to this file (<root>/apps/server/src/config.ts). */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_DIR = resolve(PROJECT_ROOT, "config");

/** Replace `${VAR}` placeholders in a string from process.env (missing vars → empty). */
function resolveEnv(value: string): string {
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
function deepMerge(base: unknown, override: unknown): unknown {
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
function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}
function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function withDefaults(raw: Record<string, unknown>): AppConfig {
  const server = asObj(raw["server"]);
  const workspaces = asObj(raw["workspaces"]);
  const tools = asObj(raw["tools"]);
  const webSearch = asObj(tools["webSearch"]);
  const webFetch = asObj(tools["webFetch"]);
  const fileTools = asObj(tools["fileTools"]);

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
    },
  };
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

function validateConfig(config: AppConfig): void {
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
}

export function getProviderConfig(config: AppConfig, providerId?: string): ProviderDef {
  const id = providerId ?? config.defaultProvider;
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export const PROJECT_PATHS = {
  projectRoot: PROJECT_ROOT,
  configDir: CONFIG_DIR,
  dataDir: resolve(PROJECT_ROOT, "data"),
} as const;