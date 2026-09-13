# Widgets

The right sidebar's extension panels: how they are installed, what a widget must honour, and the
steps for adding one. The *design* rationale — why the storage is shaped this way, why there is no
Copilot scope, why the panel is a grid track — is in
[architecture.md](architecture.md#widgets-right-sidebar); this file is the working reference.

A widget is a **built-in** Vue component plus an entry in two registries. There is no runtime
loading: "installed" means a row in the database and a tab in the strip.

## The shape

```
packages/shared/src/index.ts    WIDGET_IDS / WIDGETS    what exists, and which levels it accepts
apps/web/src/widgets/registry.ts WIDGET_MODULES         the component, catalog keys, lifecycle hooks
apps/server/src/schema.ts        widget_instances       one row per (scope, scope_id, widget_id)
```

Both registries exist on purpose. The shared one is what the *server* filters by and the *client*
writes ids from — one copy, because two would drift into "a widget that cannot be installed". The
client one holds what cannot cross that boundary: a component, and catalog **keys** rather than
sentences.

**Scopes are `workspace` and `session`, and there is no third.** A Copilot is a *third place to
tick a box*, not a third scope: its selection is copied into the session it starts. Supporting
`session` therefore also means supporting Copilots, and nothing extra is needed for it.

## Adding a widget

In order. Each step names the exact identifier, and the compiler and the guards catch most
omissions — the "what fails if you skip it" column is the point of the table.

| # | Do this | Skipping it |
| --- | --- | --- |
| 1 | Add the id to `WIDGET_IDS` and its levels to `WIDGETS` in [packages/shared/src/index.ts](../packages/shared/src/index.ts) | `WIDGET_MODULES` is now missing a key, so `vue-tsc` fails — in step 2's file |
| 2 | Add an entry to `WIDGET_MODULES` in [apps/web/src/widgets/registry.ts](../apps/web/src/widgets/registry.ts) | `Record<WidgetId, WidgetModule>` makes a missing entry a compile error |
| 3 | Add its `case` to `widgetLabel` **and** `widgetHint` in that file | the switch is exhaustive over the id union, so a missing arm is a compile error |
| 4 | Add `widgets.<id>.name` and `widgets.<id>.hint` to **both** catalogs | `catalog.test.ts` fails on key asymmetry; the key would also resolve to nothing at runtime |
| 5 | Write the component in `apps/web/src/widgets/` and import it in the registry | — |
| 6 | If it needs server data, add a route **about the object** — see below | — |
| 7 | Optional: `onInstall` / `onUninstall` | a widget with nothing to set up should omit both |
| 8 | Add a `data-testid` to anything an e2e flow must select | the browser suite is the only test a `.vue` file gets |

The steps that need a decision rather than a copy:

**The catalog key is a literal, and stays one.** `widgetLabel`/`widgetHint` are `switch` statements
with the key written out per case, *not* `` t(`widgets.${id}.name`, …) ``. A key built from the id
is invisible to `catalog.test.ts`'s dead-key scan, so satisfying the guard would mean adding a bare
`widgets.` to its `DYNAMIC_PREFIXES` — a prefix broad enough to hide a typo in any widget key ever
written.

**Take `t` as a parameter rather than importing the i18n instance.** The callers are components, so
the string is rendered through *their* translator and follows a locale switch. `widgetLabel(id, t)`
is the shape.

**A route for a widget is a route about the object.** The two demo widgets read
`/api/workspaces/:id/stats` and `/api/sessions/:id/stats`, not `/api/widgets/…/stats`: a third
widget will want the same numbers, and hanging them off one widget's namespace makes the next
consumer add a second path to the same query. Likewise the arithmetic lives in
[apps/server/src/widgets.ts](../apps/server/src/widgets.ts) — `sumUsage` owns every rule about
`MessageUsage`, whose fields are all optional and whose `contextTokens` is a level rather than a sum.

## The contract a widget component must honour

1. **No props.** Read the store directly, like every other component in the shell. Which object it
   shows comes from `store.activeWorkspace` / `store.activeSession`, not from a prop — that also
   removes "which object am I for" from the component's state.
2. **Events are for what the store cannot see.** Subscribe in `onMounted` and call the returned
   unsubscribe in `onBeforeUnmount` (a subscription is not scoped to a component the way a `watch`
   is). Refetch when the *server* moved something — `turn.finished` is the usual one, and it
   carries `sessionId`, so a session-scope widget should ignore other conversations' turns. Do
   **not** invent an event for something the client itself decided and holds; that is a `watch` away
   and two ways to learn one fact drift.

   ```ts
   type WidgetEvent =
     | { type: "workspace.selected"; workspaceId: string }
     | { type: "session.created"; workspaceId: string; sessionId: string }
     | { type: "session.renamed"; sessionId: string; title: string }
     | { type: "session.deleted"; workspaceId: string; sessionId: string }
     | { type: "turn.started"; sessionId: string }
     | { type: "turn.finished"; sessionId: string };
   ```

3. **A data failure is reported inside the panel, never as a toast.** A widget that cannot load
   its numbers is not a failure of the conversation the user is having — the same split
   `fileTreeError` / `filePreviewError` make. Offer a retry.
4. **`null` is "nothing has arrived yet", not zero.** Rendering `0` while the first request is in
   flight states a figure the widget does not have.
5. **Use the shared controls.** `.list-row` / `.row-actions` / `.btn` / `.badge` / `.check-row`
   rather than new scoped imitations, `--space-*` for padding and gap, palette tokens for colour.
   A new colour has to be restated in both light-palette blocks or `style.test.ts` fails.
6. **Icons come from `ICON_PATHS`.** An icon added and not drawn anywhere fails the build; a
   character or emoji used as a mark fails it too.
7. **Don't render the panel's chrome.** The header, the strip, the divider, the resize handle and
   the collapse control belong to `WidgetPanel.vue`. A widget fills `.widget-body` and nothing
   else.

## Lifecycle hooks

```ts
interface WidgetContext {
  scope: WidgetScope;
  scopeId: string;
  widgetId: WidgetId;
}

onInstall?(ctx: WidgetContext): void | Promise<void>;
onUninstall?(ctx: WidgetContext): void | Promise<void>;
```

`onInstall` fires at **two** moments, because a level's widgets arrive two ways:

- **one at a time** — a toggle in `WorkspaceSettingsDialog` or `SessionSettingsDialog`, which goes
  through `store.setWidgetEnabled`;
- **all at once** — a create request, since the create dialogs choose a selection before the object
  exists. That path runs `runInstallHooks` in `stores/app.ts`.

Either way the hook runs **after** the record is committed, which is what makes "a hook can never
fail a config write" a property of the ordering rather than a promise. A hook that throws is logged
and nothing else: the user's action already did what they asked, and a toast saying "installed, but
could not initialise" would read as the install having failed. `onUninstall` must tolerate never
having been installed — "not installed" is where a fresh object starts.

Repeated install/uninstall is supported and re-fires `onInstall` each time; there is deliberately no
once-only guard, because re-initialising is what the hook is for.

## Invariants a widget must not break

- **An uninstall is `enabled = 0`, not a delete.** The row's existence records that somebody
  decided; deleting it would fall back to the level's default and silently reinstall the widget.
- **Reads go through the registry, not the rows.** One entry comes back per widget the build knows
  at that level, so a stored row and a defaulted one are indistinguishable at a call site. Never
  read `widget_instances` directly to answer "what is installed".
- **An unknown id is refused, never dropped.** `parseWidgetIds` returns `UNKNOWN_WIDGET` or
  `WIDGET_SCOPE_UNSUPPORTED`; a filtered id is a selection that looks like it worked.
- **Absent and empty are different.** In a request body, an omitted `widgets` falls through to the
  next tier (a Copilot's selection, then `DEFAULT_WIDGET_IDS`) while `[]` means none and stops the
  fall-through.
- **Every route is owner-scoped in the `WHERE`.** A session reaches its owner through its workspace
  by join. A widget never needs its own ownership check — and must not add one that replaces the
  scoped read.

## What is deliberately not supported

- **External / dynamic installation.** A widget is a component in the web bundle; there is nothing
  to load at runtime. `widgetsForScope()` is the seam if that ever changes, and it is the only
  thing that would have to become async.
- **Server-side lifecycle hooks or an event bus.** There is no server-side widget runtime, so a
  hook there would have no code to call.
- **A resizable panel on a phone.** Below 900px the panel is a fixed-width drawer and the resize
  handle is not rendered.

## Watching it work

`e2e/widgets.spec.ts` is the feature's end-to-end coverage and doubles as a worked example:
installing from a card, the two groups and the divider, switching and remembering the open tab,
flipping the strip's orientation, dragging the width and its clamp, the overflow menu, the drawer on
a phone, and the demo widgets counting again after a turn without a reload.

```bash
npx playwright test e2e/widgets.spec.ts   # the panel, end to end (14 flows)
npx vitest run widget                     # the route + arithmetic tests and the three web units
```

The store's own widget cases — `setWidgetEnabled`, the lifecycle hooks, the `turn.finished`
emission — live in `apps/web/test/stores/app.test.ts` under a `widgets` describe, so a filename
filter does not reach them: `npx vitest run app.test.ts`.
