import {
  DIAGRAM_TOOL_NAME,
  PLOT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  isArtifactTool,
  slugifyName,
  type FileLocation,
  type ToolCall,
} from "../api/types";
import { parseBlockLines, type BlockTokenLine } from "./markdown";

/**
 * Inline rendering of artifact-producing tool calls.
 *
 * The model may write an inline marker at the exact point the artifact belongs; when it
 * writes none, the call's recorded `contentOffset` places the card at the end of its
 * step's text. Both resolve here to one ordered list of parts — text segments interleaved
 * with artifact slots. Calls that have neither a marker nor a usable offset stay in
 * `legacyCalls` and keep the old above-text placement.
 */

export type ArtifactKind = "diagram" | "plot" | "file";
export type SlotStatus = "pending" | "running" | "done" | "error" | "dangling";

/** One marker as written in the content, with its char range. */
export interface ArtifactMarker {
  kind: ArtifactKind;
  /** Handle text, trimmed, as the model wrote it. */
  handle: string;
  /** File only: the write location named in the marker. */
  location?: FileLocation;
  /** Char range of the full marker in the content. */
  start: number;
  end: number;
  startLine: number;
}

export interface TextSegment {
  kind: "text";
  text: string;
}

export interface ArtifactSlot {
  kind: "slot";
  status: SlotStatus;
  marker?: ArtifactMarker;
  toolCall?: ToolCall;
}

export type InlinePart = TextSegment | ArtifactSlot;

export interface BuildResult {
  parts: InlinePart[];
  /** Artifact calls with no marker and no usable offset — above-text placement. */
  legacyCalls: ToolCall[];
  /** Tool-call ids consumed by an inline slot. */
  consumedCallIds: ReadonlySet<string>;
}

export interface ArtifactCallIdentity {
  kind: ArtifactKind;
  key: string;
  location?: FileLocation;
}

const MARKER_SCAN_REGEX = /\[\[artifact:(diagram|plot|file)\/([^\]\n]+?)(?:\?location=(workspace|session))?\]\]/g;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/** Strip a diagram file extension from a name before it is slugified. */
function diagramBaseName(handle: string): string {
  return handle.replace(/\.(mmd|mermaid)$/i, "").trim();
}

/** Normalize a file handle/path to POSIX form, the way a relative write path is compared. */
function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

/**
 * Every marker in content, found outside code fences, with character offsets.
 *
 * Fence-aware: marker-like text inside a code block is content and is not returned.
 */
export function parseArtifactMarkers(content: string): ArtifactMarker[] {
  const lines = content.split("\n");
  const markers: ArtifactMarker[] = [];
  let offset = 0;
  let fence: "`" | "~" | null = null;

  lines.forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;

    const fenceMatch = line.match(FENCE_LINE);
    if (fenceMatch) {
      const mark = fenceMatch[1]![0] === "~" ? "~" : "`";
      if (fence === null) fence = mark;
      else if (mark === fence) fence = null;
      return;
    }
    if (fence !== null) return;

    for (const match of line.matchAll(MARKER_SCAN_REGEX)) {
      if (match.index === undefined) continue;
      const kind = match[1] as ArtifactKind;
      const handle = match[2]!.trim();
      const location = match[3] as FileLocation | undefined;
      const start = lineStart + match.index;
      markers.push({
        kind,
        handle,
        ...(location ? { location } : {}),
        start,
        end: start + match[0].length,
        startLine: index,
      });
    }
  });

  return markers;
}

/**
 * The identity an artifact tool call is matched by, or `null` when its input cannot be
 * read or does not name the artifact.
 */
export function artifactCallIdentity(tc: ToolCall): ArtifactCallIdentity | null {
  let args: unknown;
  try {
    args = JSON.parse(tc.input);
  } catch {
    return null;
  }

  if (tc.name === DIAGRAM_TOOL_NAME) {
    const name = (args as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return null;
    return { kind: "diagram", key: slugifyName(diagramBaseName(name), "diagram") };
  }
  if (tc.name === PLOT_TOOL_NAME) {
    const name = (args as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return null;
    return { kind: "plot", key: slugifyName(name, "plot") };
  }
  if (tc.name === WRITE_FILE_TOOL_NAME) {
    const path = (args as { path?: unknown }).path;
    if (typeof path !== "string" || !path.trim()) return null;
    const location = (args as { location?: unknown }).location;
    return {
      kind: "file",
      key: normalizePath(path),
      ...(location === "session" || location === "workspace" ? { location } : {}),
    };
  }
  return null;
}

/** The identity a marker is matched by. */
export function markerIdentity(marker: ArtifactMarker): {
  key: string;
  location?: FileLocation;
} {
  if (marker.kind === "diagram") {
    return { key: slugifyName(diagramBaseName(marker.handle), "diagram") };
  }
  if (marker.kind === "plot") {
    return { key: slugifyName(marker.handle, "plot") };
  }
  return {
    key: normalizePath(marker.handle),
    ...(marker.location ? { location: marker.location } : {}),
  };
}

/** Table-internal token types. */
const TABLE_TOKENS = new Set([
  "tr_open",
  "thead_open",
  "tbody_open",
  "th_open",
  "td_open",
]);

/**
 * End line of the table region containing targetLine.
 *
 * `table_open` carries no line map, so the region is reconstructed from the `tr_open`
 * spans: from the row containing the line, extend through contiguous rows (tolerating the
 * one delimiter line between the header and the body). Tables are separated by prose, so
 * the region cannot run into another table.
 */
function tableRegionEnd(
  tokens: readonly BlockTokenLine[],
  targetLine: number
): number | null {
  const rows = tokens
    .filter((t) => t.type === "tr_open")
    .sort((a, b) => a.startLine - b.startLine);
  const first = rows.find((r) => targetLine >= r.startLine && targetLine < r.endLine);
  if (!first) return null;

  let end = first.endLine;
  for (const row of rows) {
    if (row.startLine < first.startLine) continue;
    if (row.startLine <= end + 1) end = Math.max(end, row.endLine);
  }
  return end;
}

/**
 * Move an insertion offset to a safe block boundary.
 *
 * An offset already on a block start or sitting on a blank line is returned as is. Inside
 * an unsplittable block — code, quote, table — it snaps **forward** past the block;
 * inside a list, to the end of the current item; inside a paragraph or heading, forward to
 * the block end. Forward on purpose: the reference sentence the card is wanted beside
 * comes before the call, so a backward snap would put the card above the words that point
 * at it.
 */
export function snapToBlockBoundary(content: string, offset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  if (offset >= content.length) return content.length;

  const lines = content.split("\n");
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStarts.push(at);
    at += line.length + 1;
  }

  // The line containing the offset.
  let targetLine = 0;
  for (let i = 0; i < lines.length; i++) {
    targetLine = i;
    const start = lineStarts[i]!;
    if (offset >= start && offset <= start + lines[i]!.length) break;
  }

  const tokens = parseBlockLines(content);

  // Exactly at a block start: a safe cut point already.
  for (const token of tokens) {
    if (offset === lineStarts[token.startLine]) return offset;
  }

  // Innermost token containing the target line: latest starting, then smallest span.
  const containing = tokens
    .filter((t) => targetLine >= t.startLine && targetLine < t.endLine)
    .sort(
      (a, b) =>
        b.startLine - a.startLine ||
        a.endLine - a.startLine - (b.endLine - b.startLine)
    )[0];

  if (!containing) return offset;

  // Table region reconstructed from row spans (table_open itself has no line map).
  const tableEnd = TABLE_TOKENS.has(containing.type)
    ? tableRegionEnd(tokens, targetLine)
    : null;

  let snapLine: number;
  if (tableEnd !== null) {
    snapLine = tableEnd;
  } else switch (containing.type) {
    case "fence":
    case "code_block":
    case "html_block":
    case "blockquote_open":
    case "table_open":
      // Never split: forward past the whole block.
      snapLine = containing.endLine;
      break;
    case "list_item_open":
      snapLine = containing.endLine;
      break;
    case "ordered_list_open":
    case "bullet_list_open": {
      const nextItem = tokens.find(
        (t) => t.type === "list_item_open" && t.startLine > targetLine
      );
      snapLine = nextItem ? nextItem.startLine : containing.endLine;
      break;
    }
    default:
      // Paragraph/heading: forward to block end.
      snapLine = containing.endLine;
  }

  const char = lineStarts[snapLine] ?? content.length;
  return Math.min(Math.max(char, 0), content.length);
}

/**
 * Build the ordered parts of one assistant message.
 *
 * Markers are matched to calls one-to-one (diagram/plot on kind+key; file path-only
 * unless the marker names a location, then strict). Artifact calls left unmatched get an
 * offset slot, or fall back to legacy above-text placement.
 */
export function buildInlineParts(
  content: string,
  toolCalls: readonly ToolCall[],
  options: { settled: boolean }
): BuildResult {
  const markers = parseArtifactMarkers(content);

  interface ArtifactEntry {
    tc: ToolCall;
    identity: ArtifactCallIdentity | null;
  }
  const entries: ArtifactEntry[] = toolCalls
    .filter((tc) => isArtifactTool(tc.name))
    .map((tc) => ({ tc, identity: artifactCallIdentity(tc) }));

  const markerMatched = new Set<string>();
  const markerSlots: Array<{ marker: ArtifactMarker; tc?: ToolCall }> = [];

  for (const marker of markers) {
    const mid = markerIdentity(marker);
    const entry = entries.find((e): boolean => {
      const id = e.identity;
      if (!id || markerMatched.has(e.tc.id)) return false;
      if (id.kind !== marker.kind || id.key !== mid.key) return false;
      if (marker.kind === "file" && marker.location && id.location !== marker.location) {
        return false;
      }
      return true;
    });
    if (entry) markerMatched.add(entry.tc.id);
    markerSlots.push({ marker, ...(entry ? { tc: entry.tc } : {}) });
  }

  const consumedCallIds = new Set(markerMatched);
  const offsetSlots: Array<{ tc: ToolCall; position: number; order: number }> = [];
  const legacyCalls: ToolCall[] = [];

  for (const entry of entries) {
    if (markerMatched.has(entry.tc.id)) continue;
    const offset = entry.tc.contentOffset;
    if (
      entry.identity &&
      typeof offset === "number" &&
      Number.isFinite(offset) &&
      offset >= 0 &&
      offset <= content.length
    ) {
      consumedCallIds.add(entry.tc.id);
      offsetSlots.push({
        tc: entry.tc,
        position: snapToBlockBoundary(content, offset),
        order: offsetSlots.length,
      });
    } else {
      legacyCalls.push(entry.tc);
    }
  }

  const lines = content.split("\n");
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStarts.push(at);
    at += line.length + 1;
  }

  interface Event {
    position: number;
    removeEnd: number;
    rank: number;
    order: number;
    slot: ArtifactSlot;
  }
  const events: Event[] = [];

  markerSlots.forEach(({ marker, tc }, order) => {
    const raw = content.slice(marker.start, marker.end);
    const lineText = lines[marker.startLine] ?? "";
    // A marker alone on its line takes the line and its newline with it.
    const wholeLine = lineText.trim() === raw;
    const position = wholeLine ? lineStarts[marker.startLine]! : marker.start;
    const removeEnd = wholeLine
      ? Math.min((lineStarts[marker.startLine] ?? 0) + lineText.length + 1, content.length)
      : marker.end;
    events.push({
      position,
      removeEnd,
      rank: 0,
      order,
      slot: {
        kind: "slot",
        ...(tc ? { toolCall: tc } : { marker }),
        status: !tc
          ? options.settled
            ? "dangling"
            : "pending"
          : tc.output === undefined
            ? "running"
            : "done",
      },
    });
  });

  offsetSlots.forEach(({ tc, position, order }) => {
    events.push({
      position,
      removeEnd: position,
      rank: 1,
      order,
      slot: {
        kind: "slot",
        toolCall: tc,
        status: tc.output === undefined ? "running" : "done",
      },
    });
  });

  events.sort(
    (a, b) => a.position - b.position || a.rank - b.rank || a.order - b.order
  );

  const parts: InlinePart[] = [];
  let cursor = 0;
  const pushText = (text: string): void => {
    if (text.trim()) parts.push({ kind: "text", text });
  };
  for (const event of events) {
    pushText(content.slice(cursor, event.position));
    parts.push(event.slot);
    cursor = event.removeEnd;
  }
  pushText(content.slice(cursor));

  return { parts, legacyCalls, consumedCallIds };
}
