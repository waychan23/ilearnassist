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
| 1 | Add the id to `WIDGET_IDS` and its levels to `WIDGETS` in [packages/shared/src/index.ts](../packages/shared/src/index.ts). If the widget brings tools, list them in the entry's **`boundTools`** | `WIDGET_MODULES` is now missing a key, so `vue-tsc` fails — in step 2's file |
| 2 | Add an entry to `WIDGET_MODULES` in [apps/web/src/widgets/registry.ts](../apps/web/src/widgets/registry.ts) | `Record<WidgetId, WidgetModule>` makes a missing entry a compile error |
| 3 | Add its `case` to `widgetLabel` **and** `widgetHint` in that file | the switch is exhaustive over the id union, so a missing arm is a compile error |
| 4 | Add `widgets.<id>.name` and `widgets.<id>.hint` to **both** catalogs | `catalog.test.ts` fails on key asymmetry; the key would also resolve to nothing at runtime |
| 5 | Write the component in `apps/web/src/widgets/` and import it in the registry | — |
| 6 | If it needs server data, add a route **about the object** — see below | — |
| 7 | Optional: `onInstall` / `onUninstall` | a widget with nothing to set up should omit both |
| 8 | Optional: `onActive`, if the widget needs the host's cooperation for as long as it is *installed* — see below | the hook never fires, and anything the widget claimed keeps working on the wrong object |
| 9 | Add a `data-testid` to anything an e2e flow must select | the browser suite is the only test a `.vue` file gets |

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
onActive?(ctx: WidgetContext | null): void;
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

### `onActive` is not `onMount`

`onActive` tells a widget **which object it is live on**: the context when it is installed on what
is on screen, `null` when it is not. It is for a widget that needs the host's cooperation for as
long as it is *installed* rather than for as long as it is *visible* — the notes widget claims the
message list's annotation capability, and a claim owned by the component would drop the moment the
reader looked at another tab, taking every highlight with it. `WidgetPanel` mounts only the active
tab ([`WidgetPanel.vue`](../apps/web/src/components/WidgetPanel.vue), `:key="active"`), so a
component lifecycle hook cannot answer this question for such a widget.

It is called by [`useWidgetActivation`](../apps/web/src/composables/widgetActivation.ts), an effect
owned by `ChatView`'s setup — the component that renders the panel, so its lifetime *is* the answer.
Two consequences worth knowing before you reach for it:

- **It is idempotent and synchronous**, and it fires for *every* widget on every change, most of
  them with `null` and nothing to do. Do not put work in it that is not cheap.
- **Leaving the view is reported by the effect stopping**, not by a reactive input changing: no
  store field says "the panel is gone". A widget that claimed something must give it up on that
  path, which is what the scope's disposal triggers.

It is deliberately *not* a `watch` inside the store. The store's setup belongs to no lifetime: in
the app that is invisible, but anywhere the store is constructed more than once — a test per case,
with Pinia abandoning each instance and its effects still running — every abandoned store keeps
watching module-level singletons like `uiState`, and a change in one test wakes the watchers of
every store built before it.

`ctx` is a single context rather than a list, which quietly assumes a widget is installed at one
level at a time. True of everything in `WIDGETS` today; revisit it if one ever declares both
scopes.

### A widget may own a capability, and only one may hold it at a time

The notes widget is the worked example of a widget that changes how a *host* component behaves
rather than only drawing itself: the message list knows how to notice a selection, draw a mark and
show a window, and nothing about notes as records; the widget knows about notes and nothing about
`Range` or `<mark>`. They share
[`composables/messageNotes.ts`](../apps/web/src/composables/messageNotes.ts) and nothing else, and
that module holds a **claim** — one widget id per conversation, with a refusal that names the
holder, so a second widget is told rather than left to draw over the first. (With one notes widget
in the registry and `DEFAULT_WIDGET_IDS` empty, a second claimant cannot exist today; the rule is
kept because the alternative is a silent race.)

The claim is **per conversation**, not per widget: the message list on screen belongs to one
session, while the same widget is installed in a different set of them. A claim that said only
"notes controls this" would offer the toolbar in a conversation whose panel was never installed.

Registration order does not matter. The host registers on mount and the widget claims from
`onActive`, in whichever order those happen, because the host *reads* the claim — a reactive value
— rather than being told about it.

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
- **Bound tools are switched by the install, nothing else.** A widget-bound tool is assembled iff
  the widget is installed, bypasses the tool allow-list in all three of its states, and never
  appears in the Copilot tool checklist.

## Widget-bound tools

A widget can bring tools: list them in its `WIDGETS` entry as `boundTools` (names from
`ALL_TOOL_NAMES`). The mechanics:

- **Assembled iff the widget is installed.** `turnContext()` reads the session's enabled widgets
  fresh per turn, derives their bound names (`boundToolNamesForWidgetIds`), and hands the tools'
  per-turn context to `buildTools` (the plan tools get `{ db, sessionId }`; that context doubles
  as the assembly gate, like `read_document`'s whitelist).
- **They bypass the tool allow-list in all three of its states** — every tool, a named list, and
  the empty "no tools" list. The widget install is the one switch, so the Copilot checklist
  filters them out (`isWidgetBoundTool`); a box can neither enable nor remove them.
- **Suspending is orthogonal.** The plan's create-vs-existing fork is the third suspending tool,
  and it needs a side effect, so its `SuspendingTool.commit` (rather than `resolve`) writes the
  chosen fork before the resumed turn and may navigate the client via the `plan_session_created`
  SSE event. Read-only suspending tools keep `resolve`.
- **Mid-turn refresh needs no new SSE event.** The store emits a `plan.changed` widget event from
  the existing `tool_end` arm, so the panel refetches the moment a bound tool commits.

The plan widget is session-scoped. A future "workspace-level default that auto-installs into new
sessions" is a separate mechanism and is intentionally not built yet.

### A bound suspending tool with persisted rows: the quiz widget

The quiz widget (`id: "quiz"`) binds TWO tools — the suspending `ila_quiz` and the normal
`ila_review_quiz` — and is the template for a widget whose panel shows data the tools produce:

- **Two ids per question.** The tool assigns the session-scoped `Qn` (the `quiz_question`
  counter, unique within the conversation); its `registerQuestions` context callback creates
  the `quiz_questions` row AT SUSPENSION TIME and hands back a global UUID (`uid`, the
  `quiz_id` the model echoes). The card keeps using Qn; the panel and the grading/answer
  routes key off the UUID.
- **Rows follow the call's lifecycle.** Pending when posed; answered/dismissed from the
  `/answers` route; skipped when the user walks away (`skipAwaitingToolCalls` now returns
  the retired calls so the `/chat` route can retire their rows). A GET reconciles crash
  orphans (pending rows whose call is no longer awaiting) to skipped.
- **Grading is a normal bound tool**, not a suspending one: the model calls
  `ila_review_quiz` with exact `quiz_id`s after judging (instructed by the tool description
  and `QUIZ_GUIDANCE`); its `tool_end` emits `quiz.changed` for mid-turn panel refresh.
- **Make-up answers are POST-then-chat, never a second quiz.** An unanswered question —
  walked-away (`skipped`) or cancelled with the card (`dismissed`), treated alike — is
  re-answered through `POST /sessions/:id/quizzes/:quizId/answer` (status-guarded UPDATE of
  the same row), after which the client sends an ordinary `/chat` message quoting the
  global id; the resumed turn grades that one id. `pending` (live card) and `answered` are
  not eligible.
- **Plan binding is the tool's own concern.** An optional top-level `nodeId` names a live
  plan node (an invalid id is a tool error before any insert); without it the question binds
  to the current `in_progress` node, and without a plan it is a session-level question.

See `apps/server/src/quizzes.ts` for the domain logic and `apps/web/src/utils/quizTree.ts`
for the panel's pure tree/filter builder.

### An out-of-band post-turn widget: the thread widget

The thread widget (`id: "thread"`) brings **no `boundTools`**: it derives its data with a
second, small out-of-band model call after every finished turn — the `agent/title.ts` shape,
not the plan/quiz tool shape. The mechanics, and why:

- **Turns, not messages, are classified.** A user message plus every assistant reply up to
  the next user message is one unit, so an exchange can never be split across two threads.
  The unit is the *oldest run of still-unassigned messages*; an assistant-first run (the
  regenerate case) is its own turn.
- **One shared promise per session, fire-and-forget.** `finishTurn` calls `syncThreads`
  *without awaiting* (the auto-titler is awaited, the classifier deliberately is not —
  `done` cannot wait on it), and concurrent triggers — the turn ending while the panel is
  open — join one in-flight `Map<sessionId, Promise>`. The write re-reads what is still
  unassigned inside one transaction, so the map is an optimisation, not the correctness
  argument.
- **The call streams, with a 60s backstop.** Unlike the titler, the classifier opens a
  streamed connection: a reasoning model thinks long before its answer, and a non-streaming
  20s call aborted slow-but-healthy responses (the log showed successes at 14–18s before a
  provider slowdown made every call time out). Reasoning chunks keep the request alive.
- **Reasoning is env-switchable, per classification call.** `ILA_THREAD_REASONING` is
  `auto` (default: think only for models with the `reasoning` capability; nothing is sent,
  so the provider's default stands — DeepSeek V4 ships thinking ON), `off` (send
  `thinking:{"type":"disabled"}`, the DeepSeek/Ark shape) or `on` (force enabled). The field
  is capability-gated, so models without the flag never see it. The conversation's own turns
  are unaffected — the switch touches this out-of-band call alone.
- **Deterministic turns skip the model entirely.** A turn whose own `ila_update_plan_progress`
  call opened node N belongs to N — read out of the *turn's* tool calls, not the plan's
  current status, which would be a lie during backfill. Only ambiguous turns (background,
  digressions) are sent; a five-turn backfill that made the model think for 109s and emit
  nothing was the reason for both this and the 5-turn/350-char chunk cap.
- **Failure means "leave the ambiguous turns unassigned".** A failed/empty/unusable answer
  blocks just the model turns — deterministic turns in the same chunk still land — and the
  next turn or a panel sync retries, so backfill and "keep up" are one idempotent path and
  one model hiccup never stalls the whole backlog. One unit is at most 5 turns (one model
  call); the POST route swallows classifier errors for the same reason.
- **The two branch headings are not rows.** `计划` / `其他` carry translated labels and are
  rendered client-side (`apps/web/src/utils/threadTree.ts` nests the plan branch by the
  *live* plan tree), so a stored label cannot freeze in the conversation's language. Real
  threads live in `session_threads`; a message names one via `messages.thread_id`.
- **Scroll is a second widget-bus event.** `chat.jump` targets a tool-call card;
  `chat.jumpToMessage` targets an existing `[data-message-id]` through `scrollToMessage`.
- The panel drives install-time backfill (loops `POST …/threads/sync` while `unassigned >
  0`); the registry's `onInstall` only kicks the first chunk. The post-turn hook is what
  keeps an installed conversation current whether or not the tab is open.
- **Observation log.** `threadLog.ts` appends one human-readable block per real classification
  to `<dataRoot>/logs/threads.log` (`threadLogPath`, configured only in `index.ts`, so the
  test server writes nothing): the plan state, existing threads, the recent tail, each turn's
  messages, the model's raw answer, the per-turn resolution (new/appended/continued, and the
  tool-call precedence overriding the model), the assigned counts and elapsed ms — plus a
  failure block when the call or its answer is unusable. No block is written for a no-op.

### A viewer widget with no tools: the diagram widget

The diagram widget (`id: "diagram"`, `DiagramWidget.vue`) is the other way a widget can relate to a
tool, and the one to reach for when the tool must exist **without** the widget.

`ila_diagram` is an ordinary allow-listable tool, so `WIDGETS.diagram` has **no `boundTools`** —
the absence is the design, not an oversight. Binding it would assemble the tool only when this
widget is installed, and nothing installs a widget by default, so the model would have no way to
draw a diagram in an ordinary conversation; `isWidgetBoundTool` would also keep the name out of a
Copilot's tool checklist, so it could not be switched on there either. The panel is a *viewer*: it
lists what the conversation has drawn and opens the one you pick.

What that changes relative to the widgets above:

- **Its data is a directory, not rows.** It calls `GET /api/sessions/:id/files` and filters by
  `isDiagramFile` — the same route the session file browser uses. There is no diagram table to
  read, so a `.mmd` somebody put in the folder by hand appears exactly like one the model drew,
  and a revision leaves no stale second row.
- **Opening a row goes through the ordinary file preview**, not a dialog of its own: that dialog
  already renders a diagram, already has the source toggle, already reports its own load failures,
  and already offers the enlarged viewer. A fourth surface drawing the same picture is what this
  avoids.
- **One derived affordance.** 定位 scrolls the conversation to the tool call that drew a diagram,
  built by scanning the messages (`utils/diagramAnchors.ts`) and emitting the existing `chat.jump`.
  The join is by file name, which is why `diagramFileName` is shared with the server; a row with
  no call simply has no button rather than one that goes nowhere.
- **No `onActive` and no install hook.** It claims no host capability and needs no cooperation for
  as long as it is installed — it draws itself and nothing else. `docs/widgets.md`'s step 8 asks
  the question; this is the answer for a widget that owns only its own tab.
- **`diagram.changed` is a bus event**, emitted from the store's `tool_end` arm beside
  `plan.changed` and `quiz.changed`. This one is squarely inside the doctrine that events exist for
  what the store cannot see: the tool's result is *a file on disk*, and nothing local knows what
  the directory now holds — not how many, and not what they are called.

### Widget groups

`WIDGET_GROUPS` in the shared package is a **client-side** bundling only (the study pack is
计划 + 测验 + 脉络): an id and its members, no table and no route. The install lists render a
master row (`WidgetToggleList` → `@toggle-group`) that loops the group's members through the
ordinary `setWidgetEnabled` writes, so each widget still owns its row, route and lifecycle
hook. A member already in the target state is skipped, which is what keeps install-all from
re-firing an installed widget's `onInstall`.

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
