import {
  PREFERENCE_CONTENT_MAX,
  PREFERENCE_MAX_REPLACES,
  PREFERENCE_SOURCES,
  PREFERENCE_TYPES,
  type PreferenceSource,
  type PreferenceType,
  type SessionSettings,
  type UserPreference,
} from "@ilearnassist/shared";
import { newId, type AppDb } from "./db.js";
import { renderPrompt } from "./prompts.js";
import { parseModelJson } from "./modelJson.js";

/**
 * User preferences: the standing requirements a user states about how the agent should work.
 *
 * Three levels exist in the table (`PREFERENCE_SCOPES`, ascending specificity: user <
 * workspace < session), but only the **session** level can be created today. The read path and
 * the injected block are already multi-level, so adding workspace- or account-level writes later
 * is a write path and a screen rather than a second model.
 *
 * Two write paths reach this module: the agent's `ila_save_preference` tool during a turn, and
 * the manual extraction route (`POST …/preferences/extract`) that turns a selected passage into
 * a preference with an out-of-band model call. Both end in `savePreference`, which is the one
 * place the conflict rule and the row shape live.
 */

/**
 * Whether a turn injects the preference block.
 *
 * `true`/`false` are explicit answers; `null`/absent means **follow the context mode**: on when
 * the conversation runs on the smart-context window or has an active compaction summary, off on
 * the full history. The default is the mode's because the injected block is what carries the
 * preferences once the history no longer does — a narrow window or a summary is exactly when
 * "the user asked for no bullet lists" would otherwise be forgotten.
 *
 * The same expression is computed on the client for the composer's toggle, so the switch and
 * the wire agree about what "on" means without a round trip.
 */
export function effectivePreferencesEnabled(
  settings: SessionSettings,
  hasActiveSummary: boolean
): boolean {
  return settings.userPreferences ?? (settings.smartContext === true || hasActiveSummary);
}

/** One preference as the injected block and the tool result render it. */
export function formatPreferences(rows: readonly UserPreference[]): string {
  return rows
    .map(
      (p) =>
        `<preference id="${p.id}" scope="${p.scope}" type="${p.type}">${p.content}</preference>`
    )
    .join("\n");
}

/**
 * The system-prompt block, rendered from the catalog with the formatted rows substituted.
 *
 * A function rather than a constant, for the reason every guidance function here documents: the
 * catalog is patched by the process entry point, which runs after module evaluation.
 */
export function preferencesBlock(rows: readonly UserPreference[]): string {
  return renderPrompt("chat.preferences", { preferences: formatPreferences(rows) });
}

export interface SavePreferenceInput {
  type: PreferenceType;
  content: string;
  source: PreferenceSource;
  sourceMessageId?: string | null;
  /**
   * Live session-level ids this preference supersedes. The extraction or the model names them;
   * every one must still exist, or the whole write is refused — see `savePreference`.
   */
  replaces?: readonly string[];
}

export interface SavePreferenceResult {
  preference: UserPreference;
  /** This conversation's list after the write, so a caller needs no second read. */
  preferences: UserPreference[];
}

export function isPreferenceType(value: unknown): value is PreferenceType {
  return typeof value === "string" && (PREFERENCE_TYPES as readonly string[]).includes(value);
}

export function isPreferenceSource(value: unknown): value is PreferenceSource {
  return typeof value === "string" && (PREFERENCE_SOURCES as readonly string[]).includes(value);
}

/**
 * Record one preference, replacing whatever it supersedes — the feature's single write.
 *
 * **The replacement is a delete, not an update**, because a refined preference is a new rule
 * rather than an edit of the old one: the row that goes stays readable (soft-deleted) and the
 * new one carries its own timestamp, which is what makes "the later extraction wins" a fact
 * about rows rather than about a mutation. The delete and the insert share one transaction, so
 * a failure cannot leave the conversation having dropped a rule it did not replace.
 *
 * **Every id in `replaces` must be a live session-level preference of this conversation.**
 * An unknown, foreign or already-deleted id refuses the write rather than being skipped: a
 * delete that did not happen must never look like one, and a model that hallucinated an id
 * would otherwise be told it replaced something. `refuseReplaces` below is the check.
 */
export function savePreference(
  db: AppDb,
  userId: string,
  sessionId: string,
  input: SavePreferenceInput
): SavePreferenceResult {
  const content = input.content.trim();
  if (!content) throw new Error("A preference needs some text; the content was empty.");
  if (content.length > PREFERENCE_CONTENT_MAX) {
    throw new Error(
      `The preference is ${content.length} characters, over the ${PREFERENCE_CONTENT_MAX} ` +
        "character limit. State it as one short rule."
    );
  }
  if (!isPreferenceType(input.type)) {
    throw new Error('The preference type must be "positive" or "negative".');
  }
  if (!isPreferenceSource(input.source)) {
    throw new Error("Unknown preference source.");
  }
  const replaces = input.replaces ?? [];
  if (replaces.length > PREFERENCE_MAX_REPLACES) {
    throw new Error(`At most ${PREFERENCE_MAX_REPLACES} preferences can be replaced at once.`);
  }

  const existing = db.listSessionPreferencesForUser(userId, sessionId);
  const known = new Set(existing.map((p) => p.id));
  const unique = [...new Set(replaces)];
  for (const id of unique) {
    if (!known.has(id)) {
      throw new Error(
        `There is no live preference with id "${id}" in this conversation, so it cannot be ` +
          "replaced. Call ila_query kind \"preference\" to get the current ids."
      );
    }
  }

  const preference = db.transaction(() => {
    for (const id of unique) {
      db.softDeletePreferenceForUser(userId, sessionId, id);
    }
    return db.createPreference({
      id: newId(),
      userId,
      scope: "session",
      scopeId: sessionId,
      type: input.type,
      content,
      source: input.source,
      sourceMessageId: input.sourceMessageId ?? null,
    });
  });

  return { preference, preferences: db.listSessionPreferencesForUser(userId, sessionId) };
}

/** What the manual extraction's model call is asked to answer. */
export type ExtractedPreference =
  | { status: "skipped" }
  | { status: "saved"; type: PreferenceType; content: string; replaces: string[] };

/**
 * Parse the extraction call's answer.
 *
 * `null` means the answer was unusable — the caller treats that exactly like the call failing,
 * rather than guessing at what the model meant. `{status: "skipped"}` is a usable answer that
 * says there was nothing to record, which is a different claim and must not be collapsed into
 * the failure: the user pressed the action, and "this passage states no requirement" is an
 * answer they should hear rather than an error they should retry.
 */
export function parseExtractedPreference(raw: string): ExtractedPreference | null {
  const parsed = parseModelJson(raw, "object");
  if (parsed === null || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  if (body.status === "skipped") return { status: "skipped" };
  if (body.status !== "saved") return null;
  if (!isPreferenceType(body.type)) return null;
  if (typeof body.content !== "string") return null;
  const content = body.content.trim();
  if (!content || content.length > PREFERENCE_CONTENT_MAX) return null;
  const replaces = Array.isArray(body.replaces)
    ? body.replaces.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (replaces.length > PREFERENCE_MAX_REPLACES) return null;
  return { status: "saved", type: body.type, content, replaces: [...new Set(replaces)] };
}
