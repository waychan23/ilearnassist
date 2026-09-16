import { autoInstallWidgetForTool, type WidgetId } from "@ilearnassist/shared";
import type { AppDb } from "./db.js";

/**
 * The `auto-install` half of a widget's tool contract: a tool call puts the widget in the
 * conversation it ran in.
 *
 * A module of its own rather than a corner of `widgets.ts`, whose docblock says it is **pure on
 * purpose** — nothing there touches the database or a request, and a write would falsify that.
 * This is the one thing in the feature that writes.
 *
 * ### It installs from silence, and never over a decision
 *
 * `widget_instances` records *decisions*, not states: a row exists for everything an object has
 * been asked about, and `enabled = 0` is an uninstall. So this installs only where the
 * conversation has never answered for the widget, and **an explicit uninstall wins** — a call
 * must not be the mechanism that resurrects a panel somebody closed, which is the same invariant
 * that makes an uninstall write a row rather than delete one.
 *
 * The consequence is worth stating rather than hiding: asking the model for a plan in a
 * conversation where the plan panel was removed gives a plan and no panel. The user's decision
 * about their own screen outranks the model's call. Revisit if that reads wrong in use — the
 * change would be to drop the decision read below, and the price would be a panel that comes
 * back on its own after being dismissed.
 *
 * ### Why the decision is asked for by name
 *
 * `listSessionWidgetsForUser` cannot answer it. That read deliberately resolves rows through the
 * registry so a stored row and a defaulted one are indistinguishable (`docs/widgets.md`), which
 * is exactly right for "what is installed" and exactly wrong for "has anybody decided". Rather
 * than reach past it into `widget_instances`, `getSessionWidgetDecisionForUser` asks the narrower
 * question on purpose.
 */

export interface WidgetToolUse {
  db: AppDb;
  /** The account the turn belongs to; the write is owner-scoped by it. */
  userId: string;
  /**
   * The conversation the call ran in.
   *
   * A conversation rather than any other object because every `auto-install` widget is
   * session-scoped — `widgetsForScope` would refuse the id at any other level, so a workspace
   * install here would be a no-op that looked like a success. Add the scope to `WIDGETS` before
   * adding it here.
   */
  sessionId: string;
  /** The tool the model called, as the provider named it. */
  toolName: string;
}

/**
 * Install the widget a tool belongs to, as the side effect of the model calling it.
 *
 * Returns the id it installed, or `undefined` when the call installs nothing — an ordinary tool,
 * a widget the conversation has already answered for, or a widget id the write refused. Named
 * fields rather than three positional `string`s, for `SystemPromptInput`'s reason: the arguments
 * are indistinguishable by type and a transposed pair would write to the wrong conversation.
 *
 * **Cheap on the repeat path**: one indexed read per call, and a write only the first time. After
 * that the read short-circuits, so a conversation that has made twenty plans pays twenty reads
 * and one write.
 *
 * One case it deliberately does not cover: the plan tools' conflict fork
 * (`tools/suspending.ts`), which throws before a call resolves and so installs nothing here. That
 * is correct rather than a gap — the fork only fires when a plan already exists, and a plan can
 * only exist in a conversation that has already answered for the plan widget. The `new_session`
 * fork installs into the session it creates explicitly. The invariant is closed, but it is worth
 * knowing that a future auto-install widget may not have it.
 */
export function installWidgetForToolUse(input: WidgetToolUse): WidgetId | undefined {
  const widgetId = autoInstallWidgetForTool(input.toolName);
  if (!widgetId) return undefined;

  const decided = input.db.getSessionWidgetDecisionForUser(
    input.userId,
    input.sessionId,
    widgetId
  );
  if (decided !== undefined) return undefined;

  return input.db.setSessionWidgetForUser(input.userId, input.sessionId, widgetId, true)
    ? widgetId
    : undefined;
}
