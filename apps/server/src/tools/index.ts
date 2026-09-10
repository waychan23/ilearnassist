import type { StructuredToolInterface } from "@langchain/core/tools";
import type { WebSearchConfig } from "../config.js";
import { buildFileTools } from "./fileTools.js";
import { buildWebSearchTool } from "./webSearch.js";

/** Canonical list of tool names. Copilots may restrict a session to a subset of these. */
export const ALL_TOOL_NAMES = [
  "web_search",
  "list_files",
  "read_file",
  "write_file",
  "create_directory",
  "delete_file",
] as const;

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

export interface BuildToolsInput {
  workspaceDir: string;
  webSearch: WebSearchConfig;
  fileToolsEnabled: boolean;
  /** When non-empty, only these tools are exposed (from a Copilot's `tools` list). */
  allowedNames?: string[];
}

/**
 * Assemble the tool set for a single agent run. File tools are always built
 * bound to the provided workspace directory; the web-search tool uses whichever
 * provider is configured. Copilot-level and config-level gating is applied here.
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
  const webTool = buildWebSearchTool(input.webSearch);

  const all = [...fileTools, webTool];
  const allowed = input.allowedNames && input.allowedNames.length > 0
    ? new Set(input.allowedNames)
    : null;

  return all.filter((t) => {
    if (!input.fileToolsEnabled && t.name !== "web_search") return false;
    if (allowed && !allowed.has(t.name)) return false;
    return true;
  });
}