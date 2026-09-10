import type { StructuredToolInterface } from "@langchain/core/tools";
import type { WebFetchConfig, WebSearchConfig } from "../config.js";
import { buildFileTools } from "./fileTools.js";
import { buildWebFetchTool } from "./webFetch.js";
import { buildWebSearchTool } from "./webSearch.js";

/** Canonical list of tool names. Copilots may restrict a session to a subset of these. */
export const ALL_TOOL_NAMES = [
  "web_search",
  "web_fetch",
  "list_files",
  "read_file",
  "write_file",
  "create_directory",
  "delete_file",
] as const;

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

/** Tools that do not touch the workspace, and so survive `fileTools.enabled: false`. */
const NON_FILE_TOOLS = new Set<string>(["web_search", "web_fetch"]);

export interface BuildToolsInput {
  workspaceDir: string;
  webSearch: WebSearchConfig;
  webFetch: WebFetchConfig;
  fileToolsEnabled: boolean;
  /** When non-empty, only these tools are exposed (from a Copilot's `tools` list). */
  allowedNames?: string[];
}

/**
 * Assemble the tool set for a single agent run. File tools are always built
 * bound to the provided workspace directory; the web tools use whichever
 * providers are configured. Copilot-level and config-level gating is applied here.
 */
export function buildTools(input: BuildToolsInput): StructuredToolInterface[] {
  const files = buildFileTools(input.workspaceDir);
  const fileTools = [
    files.listFiles,
    files.readFile,
    files.writeFile,
    files.createDirectory,
    files.deleteFile,
  ];

  const all: StructuredToolInterface[] = [...fileTools, buildWebSearchTool(input.webSearch)];
  if (input.webFetch.enabled) all.push(buildWebFetchTool(input.webFetch));

  const allowed = input.allowedNames && input.allowedNames.length > 0
    ? new Set(input.allowedNames)
    : null;

  return all.filter((t) => {
    if (!input.fileToolsEnabled && !NON_FILE_TOOLS.has(t.name)) return false;
    if (allowed && !allowed.has(t.name)) return false;
    return true;
  });
}