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
import type { RepairTarget } from "./artifactVerify.js";

/**
 * Repairing one artifact a reply left missing — whether a marker no call answered, a call
 * that failed, or a call whose entity is not actually there.
 *
 * The programmatic detection lives in `artifactVerify.ts`; this module turns one reported
 * target back into a real artifact: one out-of-band call with only the named tool bound
 * (`agent/artifactRepair.ts`), then the **real tool** is invoked with the arguments it
 * returned, so validation, naming, the database row and the file all go through the one
 * writer the agent loop uses.
 *
 * The identity fields are **pinned from the target** before the tool runs — the name for a
 * diagram/plot, the path and location for a file — so the call this produces is matched by
 * the marker or the failed call that asked for it. That is what makes the card appear *in
 * place* rather than beside a dangling slot.
 */

/** Which tool produces the artifact a target names. */
export function artifactToolName(kind: RepairTarget["kind"]): string {
  if (kind === "diagram") return DIAGRAM_TOOL_NAME;
  if (kind === "plot") return PLOT_TOOL_NAME;
  return WRITE_FILE_TOOL_NAME;
}

/** The target's tool is not assembled for this conversation — switched off, or excluded. */
export class ArtifactToolUnavailableError extends Error {
  constructor(readonly toolName: string) {
    super(`The tool "${toolName}" is not available in this conversation.`);
    this.name = "ArtifactToolUnavailableError";
  }
}

/** Where a file target's path lands, in the coordinates `files.path` stores. */
export interface TargetFileLocation {
  location: FileLocation;
  /** The path relative to the sandbox root, normalized the way the tool writes it. */
  relPath: string;
  /** The path relative to the account root, as `getFileByPath` looks it up. */
  storedPath: string;
}

export function targetFileLocation(input: {
  workspaceSlug: string;
  sessionId: string;
  defaultLocation: FileLocation;
  target: RepairTarget;
}): TargetFileLocation {
  const location = input.target.location ?? input.defaultLocation;
  const relPath = normalizeArtifactPath(input.target.handle);
  const storedPath =
    location === "workspace"
      ? workspaceFilePath(input.workspaceSlug, relPath)
      : sessionFilePath(input.workspaceSlug, input.sessionId, relPath);
  return { location, relPath, storedPath };
}

/** The two sandbox roots a file target can land in, when the caller wants the disk checked too. */
export interface TargetRoots {
  workspaceDir: string;
  sessionDir: string;
}

/**
 * Whether a file target's path already holds a file — a row, or bytes on disk.
 *
 * The one check that keeps a repair from silently overwriting content that is already there:
 * a file the model wrote in an earlier turn, or one the user put in the sandbox themselves.
 * A diagram or plot needs no equivalent — re-calling those tools with the same name is the
 * established revise, and the row is the only copy.
 *
 * The disk arm is not redundant with the row: a file dropped into a sandbox is not registered
 * until something walks the directory, and a repair that trusted only rows would overwrite a
 * file the user can see. The path goes through `resolveInWorkspace` before it is touched, the
 * same boundary the tools use, so a target cannot probe outside the sandbox with `..`.
 */
export function fileTargetExists(
  db: AppDb,
  input: {
    userId: string;
    workspaceSlug: string;
    sessionId: string;
    defaultLocation: FileLocation;
    target: RepairTarget;
    roots?: TargetRoots;
  }
): boolean {
  if (input.target.kind !== "file") return false;
  const { storedPath, location, relPath } = targetFileLocation(input);
  if (db.getFileByPath(input.userId, storedPath)) return true;
  if (!input.roots) return false;
  const root = location === "workspace" ? input.roots.workspaceDir : input.roots.sessionDir;
  const resolved = resolveInWorkspace(root, relPath);
  return resolved.ok && !!resolved.path && existsSync(resolved.path);
}

/** Marker-shaped wrapper — the overwrite guard addressed from a dangling marker slot. */
export function fileMarkerExists(
  db: AppDb,
  input: {
    userId: string;
    workspaceSlug: string;
    sessionId: string;
    defaultLocation: FileLocation;
    marker: ArtifactMarker;
    roots?: TargetRoots;
  }
): boolean {
  return fileTargetExists(db, {
    ...input,
    target: {
      kind: input.marker.kind,
      handle: input.marker.handle,
      ...(input.marker.location ? { location: input.marker.location } : {}),
      markerStart: input.marker.start,
    },
  });
}

export interface RepairArtifactInput {
  /** The account the artifact belongs to. */
  userId: string;
  workspaceSlug: string;
  sessionId: string;
  /** Where a file target with no explicit location goes — the turn's effective default. */
  defaultLocation: FileLocation;
  /** The whole assistant reply the target sits in; the repair call's primary context. */
  content: string;
  /** The user message the reply answers, when there is one — extra context for the repair. */
  userMessage?: string | null;
  target: RepairTarget;
  /** The turn's assembled tools; the artifact tool must be among them. */
  tools: readonly StructuredToolInterface[];
  repairer: ArtifactRepairer;
}

/**
 * The tool-call id a repair for this target carries.
 *
 * Marker repairs keep the marker offset in the id so two repairs of the same slot (or two
 * messages with a marker at the same offset) never share a row's `tool_call_id`; the random
 * tail covers everything else.
 */
function artifactRepairCallId(target: RepairTarget): string {
  const base = target.markerStart !== undefined ? `repair_${target.markerStart}` : "repair";
  return `${base}_${newId().slice(0, 8)}`;
}

/** Force the target's own identity onto whatever arguments the model produced. */
function pinTargetIdentity(
  args: Record<string, unknown>,
  target: RepairTarget,
  defaultLocation: FileLocation
): Record<string, unknown> {
  if (target.kind === "file") {
    return {
      ...args,
      path: normalizeArtifactPath(target.handle),
      location: target.location ?? defaultLocation,
    };
  }
  return { ...args, name: target.handle };
}

/**
 * Generate the missing artifact and return the tool call that represents it.
 *
 * One retry, with the tool's refusal appended to the prompt: the common failure is a spec the
 * validator would not take, and the validator's own sentence is the best description of what
 * to fix. Throws when both attempts fail — callers decide whether that is a warning (auto
 * repair, where the target simply stays missing) or an error response (the manual button).
 */
export async function repairArtifactMarker(input: RepairArtifactInput): Promise<ToolCall> {
  const toolName = artifactToolName(input.target.kind);
  const tool = input.tools.find((t) => t.name === toolName);
  if (!tool) throw new ArtifactToolUnavailableError(toolName);

  const systemPrompt = renderPrompt("artifact.repair.system", {
    kind: input.target.kind,
    handle: input.target.handle,
    toolName,
  });
  const userPrompt = [
    input.userMessage
      ? `<user_message>\n${input.userMessage}\n</user_message>`
      : "",
    `<assistant_reply>\n${input.content}\n</assistant_reply>`,
    `<missing_artifact kind="${input.target.kind}" handle="${input.target.handle}" />`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // One id for both attempts: the row a tool writes should carry the call the message ends
  // up holding, not an id belonging to a discarded attempt.
  const id = artifactRepairCallId(input.target);

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

    const pinned = pinTargetIdentity(args, input.target, input.defaultLocation);
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
