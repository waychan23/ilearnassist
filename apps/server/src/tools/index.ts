import type { StructuredToolInterface } from "@langchain/core/tools";
// The canonical list lives in `shared` rather than here, because the *client* writes the
// allow-list this module filters by: Settings → Copilots checkboxes produce these names. Kept
// here as a re-export so the server's own callers and tests read it as a tool-assembly fact.
export { ALL_TOOL_NAMES, type ToolName } from "@ilearnassist/shared";
import type { WebFetchConfig, WebSearchConfig } from "../config.js";
import { buildAskUserTool } from "./askUser.js";
import { buildDocumentTool, type DocumentToolContext } from "./documentTools.js";
import { buildFileTools } from "./fileTools.js";
import { buildWebFetchTool } from "./webFetch.js";
import { buildWebSearchTool } from "./webSearch.js";

/**
 * Tools that do not touch the workspace, and so survive `fileTools.enabled: false`.
 * `read_document` reads attachments from the uploads tree, not the workspace, so it
 * belongs here rather than being switched off with the file tools. `ask_user` reads
 * nothing at all.
 */
const NON_FILE_TOOLS = new Set<string>(["web_search", "web_fetch", "read_document", "ask_user"]);

export interface BuildToolsInput {
  workspaceDir: string;
  webSearch: WebSearchConfig;
  webFetch: WebFetchConfig;
  fileToolsEnabled: boolean;
  /**
   * The tools to expose. **Absent means every tool; an empty array means none.**
   *
   * The distinction is the whole reason `allTools` exists on a Copilot — see `BuildTools`'s
   * callers — so do not "simplify" this back to a single "empty means unrestricted" case.
   */
  allowedNames?: string[];
  /**
   * Present only when this conversation can read a document at all — that is, when its
   * whitelist is non-empty. The tool is left out entirely otherwise, so the common case
   * carries no tool for a capability it has no use for, and the model cannot call it against
   * a document that does not exist.
   *
   * The gate is "the whitelist is non-empty" rather than "this turn has attachments", which
   * is the same widening the tool itself got: a conversation with a PDF from last week can
   * still page through it on a turn that attaches nothing.
   */
  documents?: DocumentToolContext;
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

  // `ask_user` depends on no config and reads nothing, so it is assembled like a file
  // tool rather than behind a feature switch — the only thing that ever removes it is a
  // Copilot whose tool list does not name it.
  const all: StructuredToolInterface[] = [
    ...fileTools,
    buildWebSearchTool(input.webSearch),
    buildAskUserTool(),
  ];
  if (input.webFetch.enabled) all.push(buildWebFetchTool(input.webFetch));
  if (input.documents && input.documents.sources.length > 0) {
    all.push(buildDocumentTool(input.documents));
  }

  // Absent means "no restriction"; an empty array means "no tools". The two used to be the same
  // thing — `length > 0` was the test — which made a Copilot with no tools checked silently
  // become a Copilot with every tool, and left "deny everything" unrepresentable.
  const allowed = input.allowedNames ? new Set(input.allowedNames) : null;

  return all.filter((t) => {
    if (!input.fileToolsEnabled && !NON_FILE_TOOLS.has(t.name)) return false;
    if (allowed && !allowed.has(t.name)) return false;
    return true;
  });
}