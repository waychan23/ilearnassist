import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  artifactCallIdentity,
  isArtifactTool,
  isToolErrorOutput,
  matchArtifactMarkers,
  normalizeArtifactPath,
  type ArtifactKind,
  type FileLocation,
  type ToolCall,
} from "@ilearnassist/shared";
import type { AppDb } from "./db.js";
import { diagramFileName } from "./diagrams.js";
import { plotName } from "./plots.js";
import { resolveInWorkspace } from "./workspace.js";
import { sessionFilePath, workspaceFilePath } from "./resources.js";

/**
 * Programmatic verification of artifact generation — no LLM anywhere in this module.
 *
 * The question this answers is "did the thing actually get generated", and the answer comes
 * from the three places generation leaves evidence: the tool call's output, the database row
 * a write is supposed to land, and the bytes on disk. Only when this module reports a target
 * missing does the repair pass spend a model call (`artifactRepair.ts`).
 *
 * Detection used to be marker-presence only: a reply had to write `[[artifact:…]]`, and a tool
 * call that *failed* still consumed the marker because identity matching never read the output.
 * This module is the replacement worklist builder, covering failed calls and success-but-missing
 * entities whether or not a marker exists.
 */

/** One artifact whose generation must be (re)attempted; identity sourced from a marker or a call. */
export interface RepairTarget {
  kind: ArtifactKind;
  /** Diagram/plot: the model's name. File: the write path. */
  handle: string;
  /** File only: the sandbox named, when the source named one. */
  location?: FileLocation;
  /** Present when a marker produced this target — its offset, so the card lands in place. */
  markerStart?: number;
  /** Present when an existing call failed or its entity went missing. */
  callId?: string;
}

/** What presence verification needs: the database, the account coordinates, both sandbox roots. */
export interface ArtifactPresenceContext {
  db: AppDb;
  userId: string;
  sessionId: string;
  workspaceSlug: string;
  roots: { workspaceDir: string; sessionDir: string };
}

type TargetShape = { kind: ArtifactKind; handle: string; location?: FileLocation };

/*
 * Whether one file target's bytes exist — as a row or on disk — in one named sandbox.
 *
 * The same two arms `fileMarkerExists` has: the row for what the registry recorded, the
 * lexical-then-exists disk check for bytes a row does not know about. Paths go through
 * `resolveInWorkspace`, so this cannot be pointed outside the sandbox.
 */
function filePresentIn(ctx: ArtifactPresenceContext, relPath: string, location: FileLocation): boolean {
  const storedPath =
    location === "workspace"
      ? workspaceFilePath(ctx.workspaceSlug, relPath)
      : sessionFilePath(ctx.workspaceSlug, ctx.sessionId, relPath);
  if (ctx.db.getFileByPath(ctx.userId, storedPath)) return true;
  const root = location === "workspace" ? ctx.roots.workspaceDir : ctx.roots.sessionDir;
  const resolved = resolveInWorkspace(root, relPath);
  return resolved.ok && !!resolved.path && existsSync(resolved.path);
}

/**
 * Whether the artifact's material actually exists — diagram row plus its `.mmd`, plot row
 * plus a parseable spec, a file row or bytes in its sandbox.
 *
 * A file target that names no location is checked in **both** roots: marker matching accepts a
 * call in either, so checking only the default would report missing on bytes that are there
 * and trigger a repair that the overwrite guard would then refuse.
 */
export function artifactPresent(ctx: ArtifactPresenceContext, target: TargetShape): boolean {
  if (target.kind === "diagram") {
    const fileName = diagramFileName(target.handle);
    const row = ctx.db.getDiagramBySessionName(ctx.sessionId, fileName);
    return !!row && existsSync(join(ctx.roots.sessionDir, fileName));
  }
  if (target.kind === "plot") {
    const name = plotName(target.handle);
    const row = ctx.db.getPlotBySessionName(ctx.sessionId, name);
    if (!row) return false;
    try {
      JSON.parse(row.spec);
      return true;
    } catch {
      return false;
    }
  }
  const relPath = normalizeArtifactPath(target.handle);
  if (!relPath) return false;
  if (target.location) return filePresentIn(ctx, relPath, target.location);
  return (
    filePresentIn(ctx, relPath, "session") || filePresentIn(ctx, relPath, "workspace")
  );
}

/** Canonical dedup key, through the same naming the writers use. */
function dedupKey(t: TargetShape): string {
  if (t.kind === "diagram") return `diagram:${diagramFileName(t.handle)}`;
  if (t.kind === "plot") return `plot:${plotName(t.handle)}`;
  return `file:${normalizeArtifactPath(t.handle)}:${t.location ?? ""}`;
}

/** Read a tool call's arguments, or `null` when they are not a JSON object. */
function parseCallArgs(tc: ToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(tc.input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Build the repair worklist for one finished reply, purely programmatically.
 *
 * Three target sources:
 * 1. Each marker the reply wrote — with no call, with a **failed** call, or with a call whose
 *    entity is missing. (`matchArtifactMarkers` alone could not see the last two.)
 * 2. Every artifact call a marker did not consume — retried when it failed or its entity is
 *    missing, so a failure the model never marked still gets one automatic regeneration.
 *    Only the **latest** call per identity counts: an earlier failure superseded by a later
 *    call has already been judged.
 * 3. Deduplicated by canonical identity, marker sources first — one repair per artifact, and
 *    a marker-sourced repair renders its card in place.
 */
export function collectRepairTargets(
  content: string,
  toolCalls: readonly ToolCall[],
  present: (target: TargetShape) => boolean
): RepairTarget[] {
  const { matches, consumedCallIds } = matchArtifactMarkers(content, toolCalls);
  const targets: RepairTarget[] = [];

  for (const { marker, call } of matches) {
    let needed = !call;
    if (call && !needed) {
      needed =
        isToolErrorOutput(call.output) ||
        !present({ kind: marker.kind, handle: marker.handle, location: marker.location });
    }
    if (!needed) continue;
    targets.push({
      kind: marker.kind,
      handle: marker.handle,
      ...(marker.location ? { location: marker.location } : {}),
      markerStart: marker.start,
      ...(call ? { callId: call.id } : {}),
    });
  }

  /*
   * Latest call per identity across the whole message — the same superseding the client
   * renderer applies. Once a later same-identity call exists, an earlier failure has been
   * judged: a repair is owed only when the latest call is itself failed or missing.
   */
  const identityLatest = new Map<string, number>();
  toolCalls.forEach((tc, index) => {
    if (!isArtifactTool(tc.name)) return;
    const id = artifactCallIdentity(tc);
    if (id) identityLatest.set(`${id.kind}:${id.key}:${id.location ?? ""}`, index);
  });

  for (let index = 0; index < toolCalls.length; index++) {
    const tc = toolCalls[index]!;
    if (!isArtifactTool(tc.name) || consumedCallIds.has(tc.id)) continue;
    const identity = artifactCallIdentity(tc);
    const args = parseCallArgs(tc);
    if (!identity || !args) continue;
    if (
      identityLatest.get(
        `${identity.kind}:${identity.key}:${identity.location ?? ""}`
      ) !== index
    ) {
      // Superseded by a later call of one identity — marker or latest handles the artifact.
      continue;
    }

    let handle: string;
    let location: FileLocation | undefined;
    if (identity.kind === "file") {
      const path = args.path;
      if (typeof path !== "string" || !path.trim()) continue;
      handle = path;
      location = identity.location;
    } else {
      const name = args.name;
      if (typeof name !== "string" || !name.trim()) continue;
      handle = name;
    }

    const failed = isToolErrorOutput(tc.output);
    if (!failed && present({ kind: identity.kind, handle, location })) continue;
    targets.push({
      kind: identity.kind,
      handle,
      ...(location ? { location } : {}),
      callId: tc.id,
    });
  }

  // Marker-sourced entries first, then first occurrence per canonical identity.
  const ordered = [...targets].sort(
    (a, b) => Number(b.markerStart !== undefined) - Number(a.markerStart !== undefined)
  );
  const seen = new Set<string>();
  return ordered.filter((t): boolean => {
    const key = dedupKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
