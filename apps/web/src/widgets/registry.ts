import type { Component } from "vue";
import type { WidgetId, WidgetScope } from "@ilearnassist/shared";
import WorkspaceStatsWidget from "./WorkspaceStatsWidget.vue";
import SessionStatsWidget from "./SessionStatsWidget.vue";
import PlanWidget from "./PlanWidget.vue";
import QuizWidget from "./QuizWidget.vue";

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
}

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
  onInstall?(ctx: WidgetContext): void | Promise<void>;
  /**
   * Run after the record says this widget is uninstalled. For cleaning up.
   *
   * Must tolerate never having been installed: "not installed" is where a fresh object already
   * starts, so this can be the first hook a widget ever sees.
   */
  onUninstall?(ctx: WidgetContext): void | Promise<void>;
  component: Component;
}

export const WIDGET_MODULES: Record<WidgetId, WidgetModule> = {
  workspace_stats: { component: WorkspaceStatsWidget },
  session_stats: { component: SessionStatsWidget },
  plan: { component: PlanWidget },
  quiz: { component: QuizWidget },
};
