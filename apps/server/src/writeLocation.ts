import { isFileLocation } from "@ilearnassist/shared";
import type { FileLocation, SessionSettings, WorkspaceSettings } from "@ilearnassist/shared";

/**
 * Where an unqualified file write lands, and which level decides it.
 *
 * The agent can write into two sandboxes — a workspace's `workdir/`, which every conversation
 * in that workspace shares, and a conversation's own directory, which nothing else sees. Which
 * one a given file belongs in is a *product* question the model cannot always answer, so the
 * answer is a setting with a chain of levels above it, and the model is told the result.
 *
 * ```
 * this turn's own instruction  >  the session's setting  >  the workspace's default  >  DEFAULT
 * ```
 *
 * **No Copilot is read here.** A Copilot's value arrives as `session.settings` because the
 * conversation copied it at creation — the same reason `turnContext` consults the session and
 * nothing else. Reading the Copilot live would be the bug that the session snapshot exists to
 * prevent: editing a Copilot would silently rewrite every conversation already using it.
 */

/**
 * What an unqualified write gets when nobody at any level has said otherwise.
 *
 * `session`, and the direction is the point rather than a detail. A workspace's `workdir/` is
 * shared by every conversation in it, so it is only the right home for material that *is*
 * shared — a codebase, a corpus the whole workspace is about. Everything else a conversation
 * produces is about that conversation, and a default that puts it in the shared directory
 * turns that directory into a junk drawer that nobody organised and nobody can safely clean.
 *
 * The cost of the choice is stated rather than hidden: the sidebar's file tab browses
 * `workdir/`, so with this default most new files do not appear there — they appear under the
 * conversation that made them. See `docs/resources.md`.
 */
export const DEFAULT_WRITE_LOCATION: FileLocation = "session";

/**
 * Read a stored or supplied value, or `null` when it is not a location at all.
 *
 * Refusing rather than coercing, on the "never coerce a request field into a role or a flag"
 * rule: `"workspace "` with a trailing space, or `"true"`, is a caller that has misunderstood
 * something, and a value silently ignored here would look exactly like a setting that had no
 * effect. A store that read it back as `workspace` when the user chose something else is worse
 * than one that says it cannot.
 */
export function parseWriteLocation(value: unknown): FileLocation | null {
  if (value === undefined || value === null || value === "") return null;
  return isFileLocation(value) ? value : null;
}

export interface WriteLocationInput {
  /**
   * This turn's own instruction, when the user gave one — "write it next to the file I just
   * pointed at", or an explicit "put this in the project". Absent on an ordinary turn.
   */
  request?: FileLocation | null;
  /** The conversation's settings, which already carry any Copilot's value. */
  session?: SessionSettings | null;
  /** The workspace's own default, which a conversation inherits at creation. */
  workspace?: WorkspaceSettings | null;
}

/**
 * The nearest level that expressed an opinion wins.
 *
 * Exported as one function because the chain is the whole feature: three of the four levels
 * used to be expressible only by a prompt sentence, and a second implementation of this order
 * — in a route, or in a tool — would be a second answer to the same question.
 */
export function resolveWriteLocation(input: WriteLocationInput): FileLocation {
  return (
    parseWriteLocation(input.request) ??
    parseWriteLocation(input.session?.writeLocation) ??
    parseWriteLocation(input.workspace?.writeLocation) ??
    DEFAULT_WRITE_LOCATION
  );
}
