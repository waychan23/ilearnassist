import type {
  MessageModel,
  MessageUsage,
  UsageBucket,
  UsagePurpose,
  UsageSessionRow,
  UsageStats,
  UsageTotals,
} from "@ilearnassist/shared";
import { USAGE_PURPOSES } from "@ilearnassist/shared";
import {
  newId,
  type AppDb,
  type UsageEventInput,
  type UsageQuery as LedgerQuery,
  type UsageRow,
} from "./db.js";

/**
 * The usage ledger: what every model call cost, and what it was for.
 *
 * One row per call, written where the call's outcome is known. `messages.usage` records a *turn's*
 * tokens and only a turn writes a message — the five out-of-band calls (the auto-titler, the turn
 * classifier, the insight pass, the image describer, the note-export summariser) spend real tokens
 * that no transcript holds. This table is the one place all six purposes meet, which is what makes
 * "what did this cost, and for what" answerable at all.
 *
 * Three things about the shape are deliberate:
 *
 * - **A row is attributed, not joined.** `user_id`, `workspace_id` and `session_id` are columns on
 *   the row rather than a lookup through `sessions`, so a query for one account's spend in a date
 *   range is one indexed scan — and so a row survives the conversation it describes, which the
 *   entity tables' soft deletes already promise. Nothing here cascades.
 * - **`durationMs` is nullable and stays so.** Zero is a real measurement ("it came back
 *   instantly"); NULL is "nobody timed this". An average that folded NULL into zero would report a
 *   number nobody measured.
 * - **Cache-miss input is derived, never stored.** See `UsageTotals.cacheMissInputTokens`.
 */

/** What a call is recorded against. The provider/model pair is denormalized, like a message's. */
export interface RecordUsageInput {
  userId: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  purpose: UsagePurpose;
  /** From `describeModel` — the same record a message's provenance carries, or absent. */
  model?: MessageModel;
  usage: MessageUsage;
  /** Wall-clock time for the call, when the caller measured it. */
  durationMs?: number | null;
}

/**
 * The reading half of a call's usage, into a ledger row.
 *
 * A no-op when the provider reported nothing: an all-zero row would claim a call that cost
 * nothing, which is a different statement from "this provider does not report usage" — and it
 * would drag every average toward zero. Callers pass whatever they got and this decides.
 *
 * It **cannot fail the call it is describing**. Every caller is either a turn that already
 * succeeded or a fire-and-forget pass whose failures are already swallowed, and observability that
 * can break the thing it observes is worse than no observability. A throw here is swallowed and
 * the row is lost; the ledger is a best-effort record, and it says so.
 */
export function recordUsage(db: AppDb, input: RecordUsageInput): void {
  const { usage } = input;
  if (!hasFigures(usage)) return;
  try {
    const row: UsageEventInput = {
      id: newId(),
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId ?? null,
      messageId: input.messageId ?? null,
      purpose: input.purpose,
      providerId: input.model?.providerId ?? null,
      providerName: input.model?.providerName ?? null,
      modelId: input.model?.modelId ?? null,
      modelName: input.model?.modelName ?? null,
      inputTokens: usage.inputTokens ?? 0,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      durationMs: input.durationMs ?? null,
    };
    db.insertUsageEvent(row);
  } catch {
    // Deliberately silent: see above. A ledger row is worth less than the turn it describes.
  }
}

/**
 * Whether a provider reported anything at all.
 *
 * `totalTokens` alone is not enough — a provider that reports only input and output is perfectly
 * ordinary — so this asks whether *any* figure is present.
 */
function hasFigures(usage: MessageUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined
  );
}



/* ---------------------------------- aggregates ---------------------------------- */

/**
 * A window of the ledger, and what to cut it by.
 *
 * The dates are **local calendar days in the reader's zone**, resolved here rather than by the
 * caller, because "the 1st to the 7th" means those days where the reader is. The zone is
 * untrusted — an unusable name falls back to the server's own, the rule `agent/clock.ts` follows —
 * so a bad value narrows nothing rather than failing the query.
 */
export interface StatsQuery {
  userId?: string;
  workspaceId?: string;
  from?: string;
  to?: string;
  timezone?: string;
}

/**
 * The window a query becomes, once its dates are resolved.
 *
 * Extends the ledger's own filter with the two things only this layer needs: the dates as written
 * (filling the day axis is calendar arithmetic, not instant arithmetic) and the zone the days were
 * cut in. `db.ts` sees only the instants, so the two layers cannot disagree about what a day is.
 */
export interface UsageFilter extends LedgerQuery {
  fromDate: string | null;
  toDate: string | null;
  timezone: string;
}

/** One `YYYY-MM-DD` day, and the instant its local midnight starts at, as ISO. */
function dayBounds(date: string, timezone: string): { start: string; end: string } | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!parts) return null;
  const [, y, m, d] = parts as unknown as [string, string, string, string];
  /*
   * The offset is derived rather than assumed, and it is the *reader's* zone: a day that ends at
   * the server's midnight is a day nobody lived through. `Intl` is the only thing that knows a
   * zone's offset at a given instant, which is also why the offset has to be measured on the day
   * itself — a fixed offset would be wrong on one side of a daylight-saving boundary.
   *
   * Measured from noon of that day so the arithmetic cannot land on the boundary it is trying to
   * find: noon is always inside the day, whatever the offset is.
   */
  const noon = new Date(`${y}-${m}-${d}T12:00:00Z`);
  if (Number.isNaN(noon.getTime())) return null;
  const offsetMs = zoneOffsetMs(noon, timezone);
  const start = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)) - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** How far ahead of UTC `timezone` is at `at`, in milliseconds. */
function zoneOffsetMs(at: Date, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(at);
    // `en-US` gives `09/17/2026, 23:59:59`; read it back as if it were UTC and difference it.
    const asUtc = Date.parse(formatted.replace(",", "") + " UTC");
    if (Number.isNaN(asUtc)) return 0;
    // The formatter rounds to whole seconds, so the difference must be too.
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    // An unusable zone name — the caller's fallback already replaced it, but `Intl` is strict
    // enough that this is the honest place to stop rather than let a RangeError escape.
    return 0;
  }
}

/**
 * The filter a query becomes, with the day bounds resolved.
 *
 * A date that cannot be parsed is *dropped* rather than refused: it can only have come from a
 * hand-edited URL, and the answer to a malformed bound is the unbounded answer, not an error page
 * on a statistics screen.
 */
export function usageFilter(query: StatsQuery, serverZone: string): UsageFilter {
  const timezone = query.timezone?.trim() || serverZone;
  const from = query.from ? dayBounds(query.from, timezone) : null;
  const to = query.to ? dayBounds(query.to, timezone) : null;
  return {
    userId: query.userId,
    workspaceId: query.workspaceId,
    // The upper bound is the *end* of the named day, so `to=2026-09-18` includes that whole day
    // rather than stopping at its midnight — the only reading of an inclusive date anyone means.
    fromIso: from?.start ?? null,
    toIso: to?.end ?? null,
    // The two *dates* as written, kept alongside the instants: filling the day axis needs calendar
    // days, and re-deriving them from an ISO instant means re-applying a zone offset to a value
    // that has already been through one.
    fromDate: from ? query.from!.trim() : null,
    toDate: to ? query.to!.trim() : null,
    timezone,
  };
}

/** The empty bucket, so a caller never has to build one. */
export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    durationMs: 0,
  };
}

/**
 * A row's figures, summed into a bucket.
 *
 * The arithmetic lives here rather than in SQL for one figure — the cache-miss derivation — and
 * keeping the rest beside it is what stops the two from being computed in two places with two
 * answers. `MAX(0, …)` because a provider that reports more cached tokens than input tokens is
 * reporting something impossible, and a negative spend is a worse thing to show than a clamped
 * one.
 */
export function addRow(totals: UsageTotals, row: UsageRow): void {
  totals.calls += 1;
  totals.inputTokens += row.inputTokens;
  totals.cachedInputTokens += row.cachedInputTokens;
  totals.cacheMissInputTokens += Math.max(0, row.inputTokens - row.cachedInputTokens);
  totals.outputTokens += row.outputTokens;
  totals.reasoningTokens += row.reasoningTokens;
  totals.totalTokens += row.totalTokens;
  totals.durationMs += row.durationMs ?? 0;
}

/** Bucket rows by one key, in first-seen order, with a label when the server knows one. */
export function bucketBy(
  rows: readonly UsageRow[],
  keyOf: (row: UsageRow) => string | null,
  labelOf?: (row: UsageRow) => string | undefined
): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const existing = buckets.get(key);
    if (existing) {
      addRow(existing, row);
      continue;
    }
    const bucket: UsageBucket = { key, ...emptyTotals() };
    const label = labelOf?.(row);
    if (label) bucket.label = label;
    addRow(bucket, row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

/**
 * One day of a row, as `YYYY-MM-DD` in the reader's zone.
 *
 * `Intl` again rather than slicing the ISO string: an instant is not a date, and the day a call
 * belongs to is the day the reader was having. Slicing would put a 23:30 local call on tomorrow.
 */
export function dayOf(row: UsageRow, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(row.createdAt));
  } catch {
    return row.createdAt.slice(0, 10);
  }
}

/** Every purpose, in `USAGE_PURPOSES` order, including the ones with no rows. */
export function purposeOrder(): readonly UsagePurpose[] {
  return USAGE_PURPOSES;
}

/**
 * Build the whole answer from the rows.
 *
 * Days are **filled in**, which is the one place this does more than group: a chart drawn from
 * only the days that happen to have calls would compress a quiet week into a busy-looking line.
 * Only the days inside the requested range are filled, so a range that names them is drawn as
 * asked and an unbounded query is drawn from the first call to the last.
 */
export function buildStats(
  rows: readonly UsageRow[],
  filter: UsageFilter,
  since: string | null
): UsageStats {
  const totals = emptyTotals();
  for (const row of rows) addRow(totals, row);

  const byDay = bucketBy(rows, (row) => dayOf(row, filter.timezone));
  byDay.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const stats: UsageStats = {
    totals,
    byPurpose: sortByPurpose(bucketBy(rows, (row) => row.purpose)),
    byProvider: bucketBy(
      rows,
      (row) => row.providerId,
      (row) => row.providerName ?? undefined
    ),
    byModel: bucketBy(
      rows,
      (row) => row.modelId,
      (row) => row.modelName ?? undefined
    ),
    byDay: fillDays(byDay, filter),
    byWorkspace: bucketBy(
      rows,
      (row) => row.workspaceId,
      (row) => row.workspaceName ?? undefined
    ),
  };
  if (filter.fromIso) stats.from = filter.fromIso.slice(0, 10);
  if (filter.toIso) stats.to = filter.toIso.slice(0, 10);
  if (since) stats.since = since;
  return stats;
}

/** Add a zero row for every day in the range that had no calls, when the range names both ends. */
function fillDays(days: UsageBucket[], filter: UsageFilter): UsageBucket[] {
  if (!filter.fromDate || !filter.toDate) return days;
  const present = new Map(days.map((day) => [day.key, day]));
  const out: UsageBucket[] = [];
  // Calendar days walked in UTC, from the *dates as written* rather than from the resolved
  // instants: an instant has already had a zone offset applied to it, and re-deriving a calendar
  // day from one is how the first version of this dropped its last day.
  const cursor = new Date(`${filter.fromDate}T00:00:00Z`);
  const last = filter.toDate;
  if (Number.isNaN(cursor.getTime())) return days;
  // A bounded loop: a range that somehow names a decade is capped rather than filling memory.
  for (let i = 0; i < 400; i++) {
    const key = cursor.toISOString().slice(0, 10);
    if (key > last) break;
    out.push(present.get(key) ?? { key, ...emptyTotals() });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** The purpose breakdown, in `USAGE_PURPOSES` order. */
function sortByPurpose(buckets: UsageBucket[]): UsageBucket[] {
  const order = new Map(USAGE_PURPOSES.map((purpose, at) => [purpose as string, at]));
  return [...buckets].sort(
    (a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99)
  );
}

/**
 * One row per conversation, for the session-level table.
 *
 * Built from the same read as everything else, so a session's total and the same session's
 * contribution to the workspace total cannot disagree. Ordered by spend rather than by title: the
 * question this table answers is "where did it go", and a reader looking for the conversations
 * that cost the most should not have to sort a list themselves.
 */
export function buildSessionRows(rows: readonly UsageRow[]): UsageSessionRow[] {
  const bySession = new Map<string, UsageSessionRow>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const existing = bySession.get(row.sessionId);
    if (existing) {
      addRow(existing, row);
      continue;
    }
    const entry: UsageSessionRow = {
      sessionId: row.sessionId,
      title: row.sessionTitle ?? "",
      workspaceId: row.workspaceId ?? "",
      ...emptyTotals(),
    };
    addRow(entry, row);
    bySession.set(row.sessionId, entry);
  }
  return [...bySession.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
