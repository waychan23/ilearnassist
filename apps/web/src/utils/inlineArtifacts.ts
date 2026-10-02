import {
  artifactCallIdentity,
  isArtifactTool,
  matchArtifactMarkers,
  type ArtifactKind,
  type ArtifactMarker,
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
 *
 * The marker grammar and the marker↔call identity math are shared (`packages/shared`), so
 * the server's missing-artifact check and this renderer can never disagree about what a
 * marker refers to.
 */

export type { ArtifactKind, ArtifactMarker };
export type SlotStatus = "pending" | "running" | "done" | "error" | "dangling";

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
  const matched = matchArtifactMarkers(content, toolCalls);
  const markerSlots = matched.matches.map(({ marker, call }) => ({
    marker,
    ...(call ? { tc: call } : {}),
  }));

  const consumedCallIds = new Set(matched.consumedCallIds);
  const offsetSlots: Array<{ tc: ToolCall; position: number; order: number }> = [];
  const legacyCalls: ToolCall[] = [];

  for (const tc of toolCalls) {
    if (!isArtifactTool(tc.name) || consumedCallIds.has(tc.id)) continue;
    const offset = tc.contentOffset;
    if (
      artifactCallIdentity(tc) &&
      typeof offset === "number" &&
      Number.isFinite(offset) &&
      offset >= 0 &&
      offset <= content.length
    ) {
      consumedCallIds.add(tc.id);
      offsetSlots.push({
        tc,
        position: snapToBlockBoundary(content, offset),
        order: offsetSlots.length,
      });
    } else {
      legacyCalls.push(tc);
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
