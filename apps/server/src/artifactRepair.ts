import { existsSync } from "node:fs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  DIAGRAM_TOOL_NAME,
  PLOT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  normalizeArtifactPath,
  type ArtifactMarker,
  type FileLocation,
  type ToolCall,
} from "@ilearnassist/shared";
import { newId, type AppDb } from "./db.js";
import type { ArtifactRepairer } from "./agent/artifactRepair.js";
import { renderPrompt } from "./prompts.js";
import { sessionFilePath, workspaceFilePath } from "./resources.js";
import { resolveInWorkspace } from "./workspace.js";

/**
 * Repairing one inline marker that no artifact tool call answered.
 *
 * The model wrote `[[artifact:diagram/x]]` (or plot/file) and then failed to call the tool —
 * the failure the inline-marker feature is most exposed to, because the marker is prose and
 * the call is a tool decision. This module turns that marker back into a real artifact: one
 * out-of-band call with only the named tool bound and forced (`agent/artifactRepair.ts`), then
 * the **real tool** is invoked with the arguments it returned, so validation, naming, the
 * database row and the file all go through the one writer the agent loop uses.
 *
 * The identity fields are **pinned from the marker** before the tool runs — the name for a
 * diagram/plot, the path and location for a file — so the call this produces is matched by the
 * marker that asked for it. That is what makes the card appear *in place* rather than beside a
 * dangling slot.
 */

/** Which tool produces the artifact a marker names. */
export function artifactToolName(kind: ArtifactMarker["kind"]): string {
  if (kind === "diagram") return DIAGRAM_TOOL_NAME;
  if (kind === "plot") return PLOT_TOOL_NAME;
  return WRITE_FILE_TOOL_NAME;
}

/** The marker's tool is not assembled for this conversation — switched off, or excluded. */
export class ArtifactToolUnavailableError extends Error {
  constructor(readonly toolName: string) {
    super(`The tool "${toolName}" is not available in this conversation.`);
    this.name = "ArtifactToolUnavailableError";
  }
}

/** Where a file marker's path lands, in the coordinates `files.path` stores. */
export interface MarkerFileLocation {
  location: FileLocation;
  /** The path relative to the sandbox root, normalized the way the tool writes it. */
  relPath: string;
  /** The path relative to the account root, as `getFileByPath` looks it up. */
  storedPath: string;
}

export function markerFileLocation(input: {
  workspaceSlug: string;
  sessionId: string;
  defaultLocation: FileLocation;
  marker: ArtifactMarker;
}): MarkerFileLocation {
  const location = input.marker.location ?? input.defaultLocation;
  const relPath = normalizeArtifactPath(input.marker.handle);
  const storedPath =
    location === "workspace"
      ? workspaceFilePath(input.workspaceSlug, relPath)
      : sessionFilePath(input.workspaceSlug, input.sessionId, relPath);
  return { location, relPath, storedPath };
}

/** The two sandbox roots a file marker can land in, when the caller wants the disk checked too. */
export interface MarkerRoots {
  workspaceDir: string;
  sessionDir: string;
}

/**
 * Whether a file marker's path already holds a file — a row, or bytes on disk.
 *
 * The one check that keeps a repair from silently overwriting content that is already there:
 * a file the model wrote in an earlier turn, or one the user put in the sandbox themselves.
 * A diagram or plot needs no equivalent — re-calling those tools with the same name is the
 * established revise, and the row is the only copy.
 *
 * The disk arm is not redundant with the row: a file dropped into a sandbox is not registered
 * until something walks the directory, and a repair that trusted only rows would overwrite a
 * file the user can see. The path goes through `resolveInWorkspace` before it is touched, the
 * same boundary the tools use, so a marker cannot probe outside the sandbox with `..`.
 */
export function fileMarkerExists(
  db: AppDb,
  input: {
    userId: string;
    workspaceSlug: string;
    sessionId: string;
    defaultLocation: FileLocation;
    marker: ArtifactMarker;
    roots?: MarkerRoots;
  }
): boolean {
  if (input.marker.kind !== "file") return false;
  const { storedPath, location, relPath } = markerFileLocation(input);
  if (db.getFileByPath(input.userId, storedPath)) return true;
  if (!input.roots) return false;
  const root = location === "workspace" ? input.roots.workspaceDir : input.roots.sessionDir;
  const resolved = resolveInWorkspace(root, relPath);
  return resolved.ok && !!resolved.path && existsSync(resolved.path);
}

export interface RepairArtifactInput {
  /** The account the artifact belongs to. */
  userId: string;
  workspaceSlug: string;
  sessionId: string;
  /** Where a file marker with no explicit location goes — the turn's effective default. */
  defaultLocation: FileLocation;
  /** The whole assistant reply the marker sits in; the repair call's primary context. */
  content: string;
  /** The user message the reply answers, when there is one — extra context for the repair. */
  userMessage?: string | null;
  marker: ArtifactMarker;
  /** The turn's assembled tools; the artifact tool must be among them. */
  tools: readonly StructuredToolInterface[];
  repairer: ArtifactRepairer;
}

/**
 * The tool-call id a repair for this marker carries.
 *
 * Per marker position, with a random tail, so two repairs of the same slot (or two messages
 * with a marker at the same offset) never share a row's `tool_call_id`.
 */
function artifactRepairCallId(marker: ArtifactMarker): string {
  return `repair_${marker.start}_${newId().slice(0, 8)}`;
}

/** Force the marker's own identity onto whatever arguments the model produced. */
function pinMarkerIdentity(
  args: Record<string, unknown>,
  marker: ArtifactMarker,
  defaultLocation: FileLocation
): Record<string, unknown> {
  if (marker.kind === "file") {
    return {
      ...args,
      path: normalizeArtifactPath(marker.handle),
      location: marker.location ?? defaultLocation,
    };
  }
  return { ...args, name: marker.handle };
}

/**
 * Generate the missing artifact and return the tool call that represents it.
 *
 * One retry, with the tool's refusal appended to the prompt: the common failure is a spec the
 * validator would not take, and the validator's own sentence is the best description of what
 * to fix. Throws when both attempts fail — callers decide whether that is a warning (auto
 * repair, where the marker simply stays dangling) or an error response (the manual button).
 */
export async function repairArtifactMarker(input: RepairArtifactInput): Promise<ToolCall> {
  const toolName = artifactToolName(input.marker.kind);
  const tool = input.tools.find((t) => t.name === toolName);
  if (!tool) throw new ArtifactToolUnavailableError(toolName);

  const systemPrompt = renderPrompt("artifact.repair.system", {
    kind: input.marker.kind,
    handle: input.marker.handle,
    toolName,
  });
  const userPrompt = [
    input.userMessage
      ? `<user_message>\n${input.userMessage}\n</user_message>`
      : "",
    `<assistant_reply>\n${input.content}\n</assistant_reply>`,
    `<missing_artifact kind="${input.marker.kind}" handle="${input.marker.handle}" />`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // One id for both attempts: the row a tool writes should carry the call the message ends
  // up holding, not an id belonging to a discarded attempt.
  const id = artifactRepairCallId(input.marker);

  let lastError = "You did not call the tool.";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? userPrompt
        : `${userPrompt}\n\nYour previous attempt failed: ${lastError}\nCall ${toolName} now with complete, valid arguments.`;

    const args = await input.repairer(systemPrompt, prompt, tool);
    if (!args) {
      lastError = "You did not call the tool.";
      continue;
    }

    const pinned = pinMarkerIdentity(args, input.marker, input.defaultLocation);
    try {
      const output = await tool.invoke(pinned, {
        configurable: { toolCallId: id },
      });
      return {
        id,
        name: toolName,
        input: JSON.stringify(pinned),
        output: typeof output === "string" ? output : JSON.stringify(output),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(lastError);
}
