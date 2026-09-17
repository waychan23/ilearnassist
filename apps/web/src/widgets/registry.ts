import type { Component } from "vue";
import type { WidgetId, WidgetScope } from "@ilearnassist/shared";
import { api } from "../api/client";
import WorkspaceStatsWidget from "./WorkspaceStatsWidget.vue";
import SessionStatsWidget from "./SessionStatsWidget.vue";
import PlanWidget from "./PlanWidget.vue";
import QuizWidget from "./QuizWidget.vue";
import ThreadWidget from "./ThreadWidget.vue";
import NotesWidget from "./NotesWidget.vue";
import DiagramWidget from "./DiagramWidget.vue";
import InsightWidget from "./InsightWidget.vue";
import SourcesWidget from "./SourcesWidget.vue";
import { claimNotes, releaseNotes, setNotesWritable } from "../composables/notes";

/**
 * What a widget is on the client: its component, its catalog strings, and its lifecycle.
 *
 * The *definition* half — which id exists and which levels it accepts — lives in
 * `packages/shared`, because the server filters by it. This half lives here because a component
 * cannot, and because a label is a catalog key rather than a sentence.
 *
 * The record is typed as `Record<WidgetId, WidgetModule>`, so adding a widget to the shared
 * registry and forgetting it here is a `vue-tsc` error rather than a tab that renders nothing.
 * The same "the type system is the completeness check" move as `en.ts` being typed as the
 * `zh-CN` schema.
 */

/** Which object an install belongs to. Passed to a lifecycle hook so it knows what it is for. */
export interface WidgetContext {
  scope: WidgetScope;
  scopeId: string;
  widgetId: WidgetId;
  /**
   * Whether the object this widget is live on accepts writes from this client right now.
   *
   * A **parameter rather than a lookup**, and that is the whole point of it: a widget that needs
   * to know must not reach into the session's state to find out, or every widget ends up coupled to
   * whatever the host happens to be doing — the notes widget asking about write locks, the next one
   * about streaming turns. The session decides; the widget is told; the widget obeys.
   *
   * False for a conversation another client is writing to (see `docs/session-locks.md`), which is
   * why the notes widget disables its editor rather than letting a save come back as a refusal.
   * True for a workspace, which has no such lock — a workspace-scoped widget has nothing to be
   * read-only about.
   */
  writable: boolean;
}

/**
 * The context an install hook gets: the same object, without `writable`.
 *
 * Not an omission to be tolerated — the field has no meaning here. `writable` answers "may this
 * client write to the object *now*", which is a fact about what is on screen, and an install is a
 * write that has already landed. A widget that wants to know whether writing is possible asks in
 * `onActive`, where the answer is a fact rather than a guess about a request that just succeeded.
 */
export type WidgetInstall = Pick<WidgetContext, "scope" | "scopeId" | "widgetId">;

/** A translator, as `useI18n()` hands it over. */
type Translate = (key: string) => string;

/**
 * A widget's display name.
 *
 * ### Why this is a function taking `t` rather than a `labelKey` field
 *
 * The obvious shape — `labelKey: "widgets.workspaceStats.name"` in data, rendered with
 * `t(module.labelKey)` — builds an i18n key at *runtime*, which means
 * `test/i18n/catalog.test.ts` cannot see it: its scan looks for `t(` applied to a **literal**, so
 * every widget's keys would read as dead, and satisfying the guard would mean adding a bare
 * `widgets.` to its `DYNAMIC_PREFIXES` allowlist — a prefix broad enough to hide a typo in any
 * widget key ever written.
 *
 * A `switch` over the closed id union with the key written out per case is the shape that has
 * neither problem: every key is a literal at a call site, so both the "resolves" and the "no dead
 * keys" checks see it; a new widget is a missing-return compile error; and the knowledge stays
 * here rather than in the tab strip. It takes `t` from the caller so the string is rendered
 * through the component's own translator and therefore follows a locale switch.
 */
export function widgetLabel(id: WidgetId, t: Translate): string {
  switch (id) {
    case "workspace_stats":
      return t("widgets.workspaceStats.name");
    case "session_stats":
      return t("widgets.sessionStats.name");
    case "plan":
      return t("widgets.plan.name");
    case "quiz":
      return t("widgets.quiz.name");
    case "thread":
      return t("widgets.thread.name");
    case "notes":
      return t("widgets.notes.name");
    case "diagram":
      return t("widgets.diagram.name");
    case "insight":
      return t("widgets.insight.name");
    case "sources":
      return t("widgets.sources.name");
  }
}

/** One line on what the widget shows. Used by the two install lists. */
export function widgetHint(id: WidgetId, t: Translate): string {
  switch (id) {
    case "workspace_stats":
      return t("widgets.workspaceStats.hint");
    case "session_stats":
      return t("widgets.sessionStats.hint");
    case "plan":
      return t("widgets.plan.hint");
    case "quiz":
      return t("widgets.quiz.hint");
    case "thread":
      return t("widgets.thread.hint");
    case "notes":
      return t("widgets.notes.hint");
    case "diagram":
      return t("widgets.diagram.hint");
    case "insight":
      return t("widgets.insight.hint");
    case "sources":
      return t("widgets.sources.hint");
  }
}

/**
 * A widget group's display name, same literal-key-per-case discipline as `widgetLabel`:
 * the id comes from shared `WIDGET_GROUPS`, but the words resolve here so the catalog
 * guard's static scan sees the key.
 */
export function widgetGroupLabel(groupId: string, t: Translate): string {
  switch (groupId) {
    case "study":
      return t("widgetGroups.study.name");
    default:
      return groupId;
  }
}

/** One line naming what a group bundles, for the install list's group row. */
export function widgetGroupHint(groupId: string, t: Translate): string {
  switch (groupId) {
    case "study":
      return t("widgetGroups.study.hint");
    default:
      return "";
  }
}

export interface WidgetModule {
  /**
   * Run after the record says this widget is installed. For whatever the widget needs to set up.
   *
   * Fired on every install rather than once, so install / uninstall / install re-runs it — which
   * is what "the same object may be toggled repeatedly" means for a widget that initialises
   * something.
   *
   * **Neither demo widget has one.** The mechanism is part of the framework, invoked by the store
   * after the write, and having a hook whose body existed only to prove hooks work would be worse
   * than an absent one. It is covered where it can be: a store test with a stubbed module.
   */
  onInstall?(ctx: WidgetInstall): void | Promise<void>;
  /**
   * Run after the record says this widget is uninstalled. For cleaning up.
   *
   * Must tolerate never having been installed: "not installed" is where a fresh object already
   * starts, so this can be the first hook a widget ever sees.
   */
  onUninstall?(ctx: WidgetInstall): void | Promise<void>;
  /**
   * Fired when the widget becomes — or stops being — the installed widget of the object
   * currently on screen. `null` means "not installed on what is on screen", which is also the
   * answer while a workspace is open but no conversation is.
   *
   * **This is not `onMount`.** `WidgetPanel` keeps only the active tab's component mounted
   * (`:key="active"`), so a widget that needs the host's cooperation for as long as it is
   * *installed* — rather than for as long as it is *visible* — cannot get it from a
   * component lifecycle hook: the notes widget would stop marking up messages the moment the
   * reader looked at the plan. The store calls this instead, whenever one of the three things
   * the answer depends on changes (which view is on screen, which session is active, which
   * widgets are enabled).
   *
   * Idempotent and synchronous by contract: it is called for every widget on every such
   * change, most of them with `null` and nothing to do. `ctx` is a single context rather than
   * a list, which quietly assumes a widget is installed at one level at a time — true of
   * everything in `WIDGETS` today, and the assumption to revisit if one ever declares both.
   */
  onActive?(ctx: WidgetContext | null): void;
  component: Component;
}

export const WIDGET_MODULES: Record<WidgetId, WidgetModule> = {
  workspace_stats: { component: WorkspaceStatsWidget },
  session_stats: { component: SessionStatsWidget },
  plan: { component: PlanWidget },
  quiz: { component: QuizWidget },
  notes: {
    component: NotesWidget,
    /*
     * The claim is taken here rather than in the component for the reason above: this widget
     * owns a conversation's *marks*, not just its tab, and those have to keep working while
     * another tab is in front. Uninstalling releases it, both through `onActive(null)` on the
     * way out and here, so a widget the panel never mounts still gives the claim up.
     *
     * `writable` rides along with the claim because both are the same kind of news — this is the
     * context the session hands the widget, and the widget acts on it. It goes to the notes module
     * rather than to the component because the marking-up path (the selection toolbar, the editor
     * the message list opens) runs whether or not the panel is on screen.
     */
    onActive: (ctx) => {
      if (ctx?.scope === "session") {
        claimNotes(ctx.scopeId);
        setNotesWritable(ctx.writable);
      } else {
        releaseNotes();
      }
    },
    onUninstall: () => releaseNotes(),
  },
  // A viewer with no lifecycle: no `onActive` (it claims no host capability and needs no
  // cooperation for as long as it is installed — it draws itself and nothing else), and no
  // install hook (there is nothing to fetch beyond the listing it loads anyway).
  diagram: { component: DiagramWidget },
  // Installing mid-conversation kicks the first backfill sync immediately; repeated
  // installs simply re-run it (idempotent — nothing unassigned makes no model call). The
  // panel itself loops the same route while an unclassified backlog remains.
  thread: {
    component: ThreadWidget,
    onInstall: ({ scope, scopeId }) => {
      if (scope !== "session") return;
      void api.syncSessionThreads(scopeId).catch(() => {});
    },
  },
  /*
   * Nothing to set up and nothing to claim, so no hook at all — and the absence is the decision
   * rather than an omission. Installing it does not start a pass: the pass costs a
   * whole-conversation model call, and an install is not a request for one. The panel opens on
   * its own list and waits to be asked, which is also what keeps this widget out of the "study"
   * group (see `docs/widgets.md`).
   */
  insight: { component: InsightWidget },
  /*
   * A viewer like the diagram panel, and the same two absences for the same two reasons: no
   * `onActive` (it claims no host capability and needs no cooperation for as long as it is
   * installed), and no install hook (there is nothing to set up beyond the listing it loads
   * anyway — and loading it is not a decision the install makes for the user).
   */
  sources: { component: SourcesWidget },
};
