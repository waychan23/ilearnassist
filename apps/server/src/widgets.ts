import {
  defaultWidgetEnabled,
  isWidgetId,
  widgetsForScope,
  type WidgetId,
  type WidgetScope,
  type WidgetState,
} from "@ilearnassist/shared";

/**
 * The one place a raw `widgets` value from a request becomes a list of ids.
 *
 * Pure on purpose — nothing here touches the database or a request — so the rules that are easy
 * to get subtly wrong (absent versus empty, unknown versus misplaced) are testable without HTTP,
 * and so `db.ts` can stay the layer that reads rows.
 *
 * The module's other half, the arithmetic behind the two demo statistics widgets, was removed
 * with them. Nothing replaced it: the token figures that matter are the ledger's, and those are
 * summed in `usage.ts` over `usage_events` rows.
 */

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
 * uninstall of something the default would have installed, which is what keeps it off. With the
 * two-view default that is one row per widget somebody actually turned on or off, and nothing
 * for the rest — so an install of a defaulted widget writes no row either, and the object stays
 * silent about a state it never disagreed with.
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
