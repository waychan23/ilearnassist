import {
  defaultWidgetEnabled,
  isWidgetId,
  widgetsForScope,
  type MessageUsage,
  type SessionStats,
  type WidgetId,
  type WidgetScope,
  type WidgetState,
  type WorkspaceStats,
} from "@ilearnassist/shared";

/**
 * The arithmetic behind the statistics widgets, and the one place a raw `widgets` value from a
 * request becomes a list of ids.
 *
 * Pure on purpose — nothing here touches the database or a request — so the rules that are easy
 * to get subtly wrong (what a missing `totalTokens` means, which turn `contextTokens` comes
 * from) are testable without HTTP, and so `db.ts` can stay the layer that reads rows.
 */

/**
 * What one conversation's usage rows add up to.
 *
 * The reason this is JavaScript and not `SUM(json_extract(usage, …))`: `MessageUsage`'s fields
 * are **all optional**, so a total the provider did not send is the two halves it did, and
 * `contextTokens` means the opposite of a sum — it is the last step's own size, a level rather
 * than a running total. Expressing either inside a `GROUP BY` would bury the definition of the
 * type where no reader of the type would find it, and `usage` can hold junk (which is why
 * `safeParseObject` exists at all), so a malformed column would turn a panel into a 500 rather
 * than a wrong number.
 *
 * `usages` is expected in ascending `created_at`, i.e. the order the messages were written.
 */
export function sumUsage(usages: MessageUsage[]): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let contextTokens = 0;

  for (const usage of usages) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    inputTokens += input;
    outputTokens += output;
    totalTokens += usage.totalTokens ?? input + output;
    // Last one wins, and `||` rather than `??`: a turn that reported no context leaves the
    // previous level standing rather than resetting the conversation to zero.
    contextTokens = usage.contextTokens || contextTokens;
  }

  return { inputTokens, outputTokens, totalTokens, contextTokens };
}

/** One conversation's numbers, from its messages. */
export function buildSessionStats(input: {
  sessionId: string;
  title: string;
  /**
   * One entry per message, in `created_at` order — **including** the ones with no usage. The
   * length is the message count, which is why a missing figure is `null` here rather than an
   * empty object: a user message never carries usage, and a turn the user stopped reports none,
   * and either would otherwise be counted as a turn that recorded nothing but happened to sum
   * to zero.
   */
  usages: (MessageUsage | null)[];
}): SessionStats {
  return {
    sessionId: input.sessionId,
    title: input.title,
    messageCount: input.usages.length,
    ...sumUsage(input.usages.filter((u): u is MessageUsage => u !== null)),
  };
}

/**
 * A workspace's numbers: its conversations' figures, plus the totals across them.
 *
 * The totals are summed from the rows rather than queried separately, so the headline and the
 * list below it cannot disagree — which is the whole failure a summary invites.
 */
export function buildWorkspaceStats(input: {
  workspaceId: string;
  sessions: { sessionId: string; title: string; usages: (MessageUsage | null)[] }[];
}): WorkspaceStats {
  const sessions = input.sessions.map(buildSessionStats);
  return {
    workspaceId: input.workspaceId,
    sessions,
    messageCount: sessions.reduce((n, s) => n + s.messageCount, 0),
    inputTokens: sessions.reduce((n, s) => n + s.inputTokens, 0),
    outputTokens: sessions.reduce((n, s) => n + s.outputTokens, 0),
    totalTokens: sessions.reduce((n, s) => n + s.totalTokens, 0),
  };
}

/* --------------------------------- selections --------------------------------- */

export type WidgetSelection =
  | { ok: true; ids: WidgetId[] | undefined }
  | { ok: false; code: "UNKNOWN_WIDGET" | "WIDGET_SCOPE_UNSUPPORTED" };

/**
 * Read a `widgets` field from a request body, against the level it is being installed at.
 *
 * Three outcomes, and the middle one is the point:
 *
 * - **Absent** (`undefined`) is `{ ok: true, ids: undefined }` — the caller falls through to
 *   whatever the next tier is (a Copilot's selection, then the defaults). It is *not* an error
 *   and *not* an empty list.
 * - **Present but empty** is `{ ok: true, ids: [] }` and means none, stopping the fall-through.
 *   The two are the same absent/empty distinction `all_tools` documents, and the reason both
 *   survive as far as this function rather than being collapsed by a caller.
 * - **Unknown or misplaced** is refused, never filtered. A dropped id is a selection that looks
 *   like it worked: the user ticked a box, the request succeeded, and nothing was installed.
 *
 * A value that is not an array at all is `UNKNOWN_WIDGET` rather than a second `DATA_REQUIRED`:
 * that code is about missing file contents, and no client can produce this.
 */
export function parseWidgetIds(value: unknown, scope: WidgetScope): WidgetSelection {
  if (value === undefined) return { ok: true, ids: undefined };
  if (!Array.isArray(value)) return { ok: false, code: "UNKNOWN_WIDGET" };

  const allowed = new Set(widgetsForScope(scope).map((w) => w.id));
  const ids: WidgetId[] = [];
  for (const entry of value) {
    if (!isWidgetId(entry)) return { ok: false, code: "UNKNOWN_WIDGET" };
    if (!allowed.has(entry)) return { ok: false, code: "WIDGET_SCOPE_UNSUPPORTED" };
    ids.push(entry);
  }
  return { ok: true, ids };
}

/**
 * The rows to write for a selection, as `(id, enabled)` pairs — **only where the choice differs
 * from the default**.
 *
 * A difference is the minimal record of a decision: an object whose state equals the defaults
 * needs no rows at all, and every decision that *does* differ is written — including an
 * uninstall of something the default would have installed, which is what keeps it off. With an
 * empty `DEFAULT_WIDGET_IDS` that is one row per installed widget and nothing else.
 */
export function widgetRowsForSelection(
  scope: WidgetScope,
  selected: WidgetId[] | undefined
): { id: WidgetId; enabled: boolean }[] {
  const wanted = selected ?? [];
  return widgetsForScope(scope)
    .map((def) => ({
      id: def.id,
      enabled: selected === undefined ? defaultWidgetEnabled(def.id) : wanted.includes(def.id),
    }))
    .filter((row) => row.enabled !== defaultWidgetEnabled(row.id));
}

/**
 * Resolve stored rows into the list a client renders, in registry order.
 *
 * Iterating the **registry** rather than the rows is what makes a stored row and a defaulted row
 * indistinguishable at a call site: the caller gets one widget per known widget, always. A row
 * naming an id this build does not know (a downgrade) is dropped by the registry walk.
 */
export function resolveWidgetStates(
  scope: WidgetScope,
  rows: { widget_id: string; enabled: number }[]
): WidgetState[] {
  const decided = new Map(rows.map((r) => [r.widget_id, r.enabled !== 0]));
  return widgetsForScope(scope).map((def) => ({
    id: def.id,
    scope,
    enabled: decided.get(def.id) ?? defaultWidgetEnabled(def.id),
  }));
}
