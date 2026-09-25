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
| 1 | Add the id to `WIDGET_IDS` and its levels to `WIDGETS` in [packages/shared/src/index.ts](../packages/shared/src/index.ts). If the widget brings tools, declare them in the entry's **`tools: { names, mode }`** and pick the mode — see below | `WIDGET_MODULES` is now missing a key, so `vue-tsc` fails — in step 2's file |
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

**A route for a widget is a route about the object.** A panel that shows numbers for a
conversation reads the conversation's own route rather than one under `/api/widgets/…`: the next
panel will want the same numbers, and hanging them off one widget's namespace makes the next
consumer add a second path to the same query. The current widgets follow this — `DiagramWidget`
over `/api/sessions/:id/diagrams`, `ResourcesWidget` over `/api/resources?sessionId=…` — and the
list's own routes are all at the same level.

**Everything here is session scope now.** `WIDGET_SCOPES` still has two entries and the workspace
routes, storage and dialogs all still exist, but nothing is installed at workspace level: the two
widgets that were are the demo statistics panels, and they were removed. So
`widgetsForScope("workspace")` is `[]`, the strip draws one group and never a divider, and the
workspace-side dialogs hide their widget sections rather than drawing an empty one. That is a
state worth knowing before reading anything below about "the two groups", and
`apps/server/test/widgets.test.ts` is where it is held in place.

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
     | { type: "turn.finished"; sessionId: string }
     | { type: "plan.changed"; sessionId: string }
     | { type: "quiz.changed"; sessionId: string }
     | { type: "diagram.changed"; sessionId: string }
     | { type: "library.changed"; sessionId: string }
     | { type: "chat.jump"; toolCallId: string }
     | { type: "chat.jumpToMessage"; messageId: string };
   ```

   (`composables/widgetEvents.ts` is the source of truth; this list is the shape of it. The
   `chat.jump*` pair runs the other way — a widget asking the message list to scroll.)

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
in the registry a second claimant cannot exist today; the rule is kept because the alternative is a
silent race.)

The claim is **per conversation**, not per widget: the message list on screen belongs to one
session, while the same widget is installed in a different set of them. A claim that said only
"notes controls this" would offer the toolbar in a conversation whose panel was never installed.

Registration order does not matter. The host registers on mount and the widget claims from
`onActive`, in whichever order those happen, because the host *reads* the claim — a reactive value
— rather than being told about it.

**The bar over a selection is the conversation's; the claim contributes buttons to it.** Noticing a
selection, and offering 追问 about it, are things every conversation does. What a widget adds is
what may be *done* with the selection, so `ChatView` composes `[its own action,
...claim.actions()]` and hides the bar when that list is empty — which is how a conversation with
nothing installed shows no bar at all. Two consequences worth knowing before adding an action:

- **`actions()` is a function and each action carries its own `disabled`.** A widget derives its
  buttons' availability from state that changes while the claim stands (a lease taken by another
  client, released, taken again), so a list frozen at claim time would leave them live in a
  conversation the client cannot write to. And one flag for the whole strip would have to pick
  between two unrelated causes — the widget's writability and the host's.
- **An action's `label` arrives already translated.** A widget module is not a component, so it
  reaches the catalog through `i18n.global.t` and must name its keys *literally* there. Returning a
  key for the host to resolve is a key no scan can see, and `catalog.test.ts` reports that as dead —
  correctly, because nothing is naming it.

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
  fall-through. A named list is honoured **literally** — `["diagram"]` gets that and nothing else,
  not that plus the defaults — which is why the three create dialogs seed their checkboxes from
  `DEFAULT_WIDGET_IDS`: they always send what they hold, so an empty start would have made a
  non-empty default invisible in every object created through the UI.
- **Every route is owner-scoped in the `WHERE`.** A session reaches its owner through its workspace
  by join. A widget never needs its own ownership check — and must not add one that replaces the
  scoped read.
- **A `required` tool is switched by the install and nothing else.** It is assembled iff the
  widget is installed, bypasses the tool allow-list in all three of its states, and never appears
  in the Copilot tool checklist.
- **An `auto-install` tool is switched by the allow-list, and installs the widget.** The install
  is a *consequence* of the call, never a precondition for it, and it never overwrites a stored
  `enabled = 0` — a decision sticks.

## Widget tools, and the two logics they can follow

A widget can bring tools: names from `ALL_TOOL_NAMES`, declared in its `WIDGETS` entry as
`tools: { names, mode }`. **The widget picks the mode**, and the two are right for different
widgets rather than being a global preference.

| | `required` | `auto-install` |
| --- | --- | --- |
| assembled | iff the widget is installed | whenever its own preconditions hold |
| the tool allow-list | bypassed in all three of its states | governs it, like any tool |
| Copilot checklist | hidden (`isWidgetBoundTool`) | shown and pickable |
| calling it | nothing beyond the call | **installs the widget in that conversation** |

Today: `quiz` is `required`; `plan` and `diagram` are `auto-install`.

`required` is the shape for a widget that is the capability's *home* — a quiz exists to be
answered, so its questions come from a card and its panel is where the answers live. `ila_quiz`
suspends the turn on the card, which settles it: the tool cannot be what installs the panel, because
the panel has to be there to receive the answer.

`auto-install` is the shape for a widget whose data the tool *produces* — a plan, a diagram. Here
the mode is not a convenience but the only way the capability can exist at all: with `required`, the
tool would be assembled only where the panel already was, so a conversation nobody had installed
anything into could never make a plan, and the panel could never introduce itself.

### The mechanics

- **Assembly.** `turnContext()` reads the session's enabled widgets fresh per turn and derives the
  `required` names (`boundToolNamesForWidgetIds`). Those names are what make an absent tool context
  assemble nothing, which is why the quiz's context is gated the way `read_document`'s whitelist is.
  An `auto-install` context is passed **unconditionally** — its presence is not a switch, so this
  read no longer decides it.
- **The install runs in the loop.** `RunAgentInput.onToolUsed` is called with the tool's name once
  a call resolves without throwing, **before** its `tool_end` event: a client that reacts to
  `tool_end` by re-reading the conversation's widgets must find the write already there. The route
  supplies the closure, so the loop knows which tool ran and the closure knows whose conversation
  it ran in. A call that threw reports nothing — a suspension and a validation error both land in
  the catch arms, and neither is a call that committed anything.
- **The install installs from silence.** `installWidgetForToolUse` writes only where the
  conversation has never answered for the widget, and **never over a stored `enabled = 0`**: a
  panel somebody closed stays closed, which is the same invariant that makes an uninstall write a
  row rather than delete one. That read is `getSessionWidgetDecisionForUser` rather than
  `listSessionWidgetsForUser`, because the resolved list deliberately cannot tell "no row" from "a
  row saying disabled". Cost: asking for a plan where the plan panel was removed gives a plan and
  no panel.
- **The client mirrors it, with no new SSE event.** `autoInstallWidgetForTool` is the one lookup
  both sides read, so the client knows which tool names install. The store's `tool_end` arm
  refetches `GET /api/sessions/:id/widgets` when the name maps to a widget it does not have
  locally, then activates the tab. A refetch rather than an event, because the route already
  answers the question and `widgetEvents.ts`'s rule is that an event exists for what the store
  cannot see. It is fire-and-forget: `applyEvent` is synchronous, and awaiting a round trip there
  would stall every subsequent text delta.
- **Suspending is orthogonal.** The plan's create-vs-existing fork is the third suspending tool,
  and it needs a side effect, so its `SuspendingTool.commit` (rather than `resolve`) writes the
  chosen fork before the resumed turn and may navigate the client via the `plan_session_created`
  SSE event. Read-only suspending tools keep `resolve`. A conflicting `ila_make_plan` throws before
  its call resolves, so it installs nothing — correct, because a plan can only already exist in a
  conversation that has answered for the panel, and the `new_session` fork installs into the
  session it creates explicitly.
- **Mid-turn refresh needs no new SSE event.** The store emits a `plan.changed` widget event from
  the existing `tool_end` arm, so the panel refetches the moment a plan tool commits.
- **Surfacing a widget's tab is not a new SSE event either, and a suspended tool has no
  `tool_end`.** `ila_make_plan` opening the plan tab is a second, additive effect in the same
  `tool_end` arm — an event narrowed to the make tool would stop the panel moving on progress. The
  *edit* path is the case that matters: a conflicting make suspends on the card, a suspended call
  emits no `tool_end`, so the store's own record of the user's `{choice: "edit"}` in
  `answerQuestion` is the only signal that a plan was committed. When a tool both suspends and can
  end in more than one way, look for the client-held decision rather than reaching for a new event.

Both scopes are session-level for every widget that brings tools today. A "workspace-level default
that auto-installs into new sessions" is still a separate mechanism and is still not built; what
`DEFAULT_WIDGET_IDS` provides is a **per-level** default, and a Copilot's selection is copied into
the conversation it starts — which is how "install this in every conversation" is expressed for a
session-scope widget. Today the default names `notes` and `sources`: both are *views over what the
conversation already holds*, so a panel for either is useful before anybody asks, while a plan, a
quiz, a diagram and an insight pass are things a conversation **produces** — a panel for one of
those is meaningful only once there is something in it, and `plan` and `diagram` install themselves
when their tool runs.

### A widget's data reached *without* naming a tool: `ila_query`

Naming a tool is the right answer only when one widget is the capability's home. There is a second,
deliberately unbound form, and `ila_query` is it: one ordinary allow-listable tool whose `kind`
discriminator (`plan`, `quiz`, `thread`, `note`, `diagram`) reaches five widgets' data at once
without belonging to any of them.

The reason is the assembly rule above read backwards. A `required` tool exists **only while its
widget is installed** — so binding "what has already happened in this conversation" would hide the
app's own records from every ordinary conversation, which is the opposite of what a discovery tool
is for — and `auto-install` has no single widget to name, because the five kinds answer for five
different panels. Each kind
therefore delegates to the read its widget's route already uses and returns what that returns;
`kind: "plan"` is byte-identical to `ila_read_plan`'s answer, from the same `renderReadResult`.
Two *entry points* to one fact is the affordance (the bound one exists only where the widget does,
the ordinary one everywhere); two *renderings* would be the footgun. `ila_query` is in
`NON_FILE_TOOLS` and `ila_diagram` is not, and the contrast is the rule: the set asks "does this
tool touch the workspace?", but it is asked on behalf of a switch meaning "this agent does not
write files" — `ila_query` only reads, and a diagram is half a feature without its file.

### A `required` suspending tool with persisted rows: the quiz widget

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
- **Grading is a normal `required` tool**, not a suspending one: the model calls
  `ila_review_quiz` with exact `quiz_id`s after judging (instructed by the tool description
  and `QUIZ_GUIDANCE`); its `tool_end` emits `quiz.changed` for mid-turn panel refresh.
- **Make-up is a tool, and its card is the quiz card.** An unanswered question — walked-away
  (`skipped`) or cancelled with the card (`dismissed`), treated alike — is brought back by
  `ila_makeup_quiz`, which suspends on the questions the conversation already holds (the model
  names ids and never text) and is answered through the ordinary `/answers` route. `pending` (a
  live card) and `answered` are not eligible. Two other doors reach the same write path:
  `POST /sessions/:id/quizzes/makeup`, used by a card the learner answers where it was asked and
  by the panel's 补答模式, which records the answers as a *completed* make-up call on a new
  assistant message (`message_added`) and starts the grading turn — the server cannot resume the
  turned-away turn, so the grading has to begin at the newest message. A make-up allows a partial
  answer, and the questions left behind stay eligible; the call that asked them is marked answered
  without an `output`, so the card stops offering a make-up it would refuse.
- **Plan binding is the tool's own concern.** An optional top-level `nodeId` names a live
  plan node (an invalid id is a tool error before any insert); without it the question binds
  to the current `in_progress` node, and without a plan it is a session-level question.

See `apps/server/src/quizzes.ts` for the domain logic and `apps/web/src/utils/quizTree.ts`
for the panel's pure tree/filter builder.

### An out-of-band post-turn widget: the thread widget

The thread widget (`id: "thread"`) names **no tools at all**: it derives its data with a
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
- **Observation log.** `modelLog.ts` appends one human-readable block per real classification
  to `<dataRoot>/logs/threads.log` (`threadLogPath`, configured only in `index.ts`, so the
  test server writes nothing): the plan state, existing threads, the recent tail, each turn's
  messages, the model's raw answer, the per-turn resolution (new/appended/continued, and the
  tool-call precedence overriding the model), the assigned counts and elapsed ms — plus a
  failure block when the call or its answer is unusable. No block is written for a no-op.
  One module for this log and the insight pass's, with the *kind* as a parameter: the shared
  part is the append helper, and a second copy of "mkdir, append, swallow the error" is exactly
  what this repository does not keep. The insight pass writes
  `<dataRoot>/logs/insights.log` through the same call — see the insight section below for what
  its block carries.

### A viewer widget: the diagram widget

The diagram widget (`id: "diagram"`, `DiagramWidget.vue`) is the third way a widget can relate to a
tool, and the one to reach for when the tool must exist **without** the widget.

`ila_diagram` is `auto-install`: ordinary, allow-listable, pickable in a Copilot — and drawing one
installs this panel. What it is *not* is `required`. That would assemble the tool only where the
panel already was, so the model would have no way to draw a diagram in an ordinary conversation, and
`isWidgetBoundTool` would keep the name out of a Copilot's tool checklist so it could not be
switched on there either. The panel is a *viewer*: it lists the conversation's diagrams and opens
the one you pick, and the two are independent — a `.mmd` copied in by hand reaches the library and
the file tree with no panel involved.

What that changes relative to the widgets above:

- **Its data is rows, written by the tools** — `session_diagrams` for a drawing and
  `session_tables` for a table, which is why it reads two routes rather than one. A diagram's row
  carries the canonical file name, the model's `summary`, the call id, and the thread the
  classifier placed it in — what the file alone cannot answer. A table's row carries the summary,
  the call id, the thread, and **the markdown itself**, because a table has no file for the bytes
  to live in. The whole-folder view is the library browser, so a `.mmd` copied in by hand is still
  reachable — it is registered and referenceable like any other file — but is not listed as
  something the agent drew.
- **Opening a row goes through the ordinary file preview for a diagram**, not a dialog of its own:
  that dialog already renders a diagram, already has the source toggle, already reports its own
  load failures, and already offers the enlarged viewer. A fourth surface drawing the same picture
  is what this avoids. The session-file content route attaches the row's summary to the preview.
  **A table's row cannot go that way** — there is no file to open — so it hands the row's own
  markdown to the viewer, which is the same dialog with a second kind. That asymmetry is the row's
  kind deciding, not two idioms for one thing.
- **One carried affordance.** 定位 scrolls the conversation to the tool call that drew a diagram,
  emitting the existing `chat.jump` with the row's `tool_call_id` — no client-side join. A row
  whose call no longer exists (a regenerated message) simply has no button, and the jump no-ops on
  a missing target. A table's row is the case that tests it: `ila_table` renders no card at all —
  its artifact is the reply — so its call carries no `[data-tool-call-id]` anywhere, and the anchor
  moves to the message row (`data-tool-call-anchor`, matched with a CSS `~=`). `docs/tables.md` has
  the reasoning; what matters here is that the panel's button still lands somewhere.
- **No `onActive` and no install hook.** It claims no host capability and needs no cooperation for
  as long as it is installed — it draws itself and nothing else. `docs/widgets.md`'s step 8 asks
  the question; this is the answer for a widget that owns only its own tab.
- **`diagram.changed` is a bus event**, emitted from the store's `tool_end` arm beside
  `plan.changed` and `quiz.changed`. The row is written during the tool call, so the event covers
  it; `turn.finished` catches a later step and the arrival of the thread title after the
  post-turn classifier. **`table.changed` is its own type**, not a share of it: the emission site
  is keyed on the tool's name, so one event would make each panel refetch on the other's calls —
  and the sentence above, about the result being a file on disk, would be false for a table.

### An on-demand widget with no tools: the insight widget

The insight widget (`id: "insight"`, `InsightWidget.vue`) is the first widget whose data is
produced **by the user pressing a button**, and the recipe above has no other entry for that shape.

There is no tool at all here — not a `required` one and not an `auto-install` one. The pass is an
**out-of-band model call** (`insights.ts` + `agent/insights.ts`), the `agent/threads.ts` pattern, so
`WIDGETS.insight` names no tools because there are none. Naming one would also be wrong twice over:
the tool would be something the *agent* can call, and the agent must not decide to spend a
whole-conversation model call on a panel nobody may open. `auto-install` fails in the other
direction — an install is not a request for a pass, so the panel would arrive empty and look broken.

What that changes relative to the widgets above:

- **Nothing runs on install, or on open.** There is no `onInstall` (the thread widget's install
  kicks a backfill; this one deliberately does not), and the panel loads its list and waits. A pass
  costs a full model call over every source, and an install is not a request for one. This is also
  why it is **not a member of the `"study"` group**: that group's members are live the moment they
  are installed, while this one shows an empty panel with a button — bundled, it would install a
  tab that looks broken beside three live ones.
- **The component holds its own data and subscribes to no widget event.** Every change to the list
  is a decision made *here* (generate, adopt, delete), so a subscription would be a second way to
  learn something the component already holds. A second tab does not live-refresh this list;
  neither does anything else in this app.
- **A failed pass is a 200, and the panel says so above the list it did not touch.**
  `status: "failed"` means the model produced nothing usable and *every row is exactly as it was* —
  which is a different claim from an `ok` answer with zero items, and from `"empty"`, where the
  pass declined to call the model because the conversation has produced nothing to read yet.
  `docs/architecture.md` has the argument for why three outcomes arriving with the same empty
  list must not be collapsed into one: a button whose press produces nothing visible is a control
  that looks broken, and the panel has a sentence for each.
- **Two writes are missing on purpose.** No `confirm()` on delete (one line of generated text,
  reproducible by a rerun, where a confirm per item turns tidying ten rows into a modal gauntlet)
  and no `store` state (one component reads it). Both are decisions with a stated trigger for
  revisiting them rather than omissions.
- **Its type list is the one narrow dynamic prefix this feature adds.** `typeLabel` builds
  `` t(`widgets.insight.types.${type}`) `` over the closed `INSIGHT_TYPES` union, so
  `catalog.test.ts`'s allowlist gains exactly `widgets.insight.types.` — five segments for eight
  kinds, where the alternative was a `switch` whose only job would be spelling eight strings.
- **It logs to `<dataRoot>/logs/insights.log`**, one block per press. This is the widget to copy
  the log from: a button that can produce three *different* nothings — declined, failed, answered
  with no items — is exactly where a screen stops being enough. The block carries the source counts
  and the prompt's size (how "nothing to reflect on" is told apart from "the model refused") and
  the model's raw answer even when it was unusable (`produced nothing usable` is one sentence for a
  fence the parser should have accepted and for a refusal in prose). It was worth writing on the
  first real run: the line `原因：Provider has no API key.` diagnosed in one line what the panel had
  only been able to call a failure, and `提示词：0 字符` is what surfaced the declined case at all.
  See `docs/architecture.md` → the insight pass.

### A viewer over the registry: the resources widget

The resources widget (`id: "sources"` — the id is a key and did not move with the wording,
`ResourcesWidget.vue`) is the diagram widget's shape applied to the material registry, and it
settles one question that the others leave open: **which of a conversation's material a panel
shows**，because there are two defensible lists and they are different.

- It reads `GET /api/resources?sessionId=…`, whose predicate is "the references this conversation
  holds" — its own files, its uploads, its pages and every `@`-reference it has taken in. Since v4
  those are one row rather than two: a reference owned by the session *is* the link, which is why
  the library lists an upload once where v3 listed it through two link tables.
- It deliberately does **not** read `GET /api/sessions/:id/resources`. That route is the model's
  *whitelist*, verbatim — the three arms `read_document` is bound to — and a panel built on it
  would list the whole granted corpus beside the three files the conversation is actually about.
  "What may be read" and "what this is working from" are not the same question, and the app now
  asks both in different places.

The consequences that are decisions rather than details:

- **The category filter is client-side**, and its option list is derived from the rows already
  fetched. Both halves are the opposite of the library browser's, and both are about scope: the
  browser cannot answer "which categories exist" in the same request (so it makes a second,
  scope-only one) and must filter on the server (a workspace can hold tens of thousands of rows),
  while this list is one conversation's. Filtering here also keeps the server's bounded
  `reconcileFilesystem` walk, which runs at the top of every `GET /api/resources`, off a control
  the user may press repeatedly.
- **No folders, no rename, no move, no delete.** A conversation's material is written by the agent
  and by what the user references; the place it gets organised is the library dialog the rail's
  library row opens. A tree here would be a second, weaker file manager for a directory nobody laid
  out — the requirement behind this panel says as much.
- **`turn.finished` is the only event it subscribes to.** A turn is what links a `@`-reference and
  what a tool writes a file through, so it is the one moment the list can have changed. There is
  no `resource.added` event and there should not be: the client is what asked for every addition,
  so the store already knows, and an event would be a second way to learn one fact.
- **A row opens the ordinary file preview**, through `store.openResourceFile` — the same dialog the
  file tree and the diagram panel reach, addressed by a **reference** id rather than by a path.
  That a reference is addressable at all is why `readPreviewFile` exists (`docs/file-preview.md`).
- Its category labels are **not** new keys: `sources.category.*` is already a catalog key per
  value and already an allowed dynamic prefix, so the filter spells a category the same way every
  other surface does. Its own strings are under `widgets.sources.*`.

### Widget groups

`WIDGET_GROUPS` in the shared package is a **client-side** bundling only (the study pack is
计划 + 测验 + 脉络): an id and its members, no table and no route. The install lists render a
master row (`WidgetToggleList` → `@toggle-group`) that loops the group's members through the
ordinary `setWidgetEnabled` writes, so each widget still owns its row, route and lifecycle
hook. A member already in the target state is skipped, which is what keeps install-all from
re-firing an installed widget's `onInstall`.

**Membership means "live on install", and that is the rule for adding one.** The study pack is
three widgets that do something the moment they are installed — the plan refreshes every turn, the
quiz poses questions mid-turn, the thread classifies after every turn. The insight widget is
deliberately not a member: it shows an empty panel with a button and waits to be pressed, so
bundling it would put what looks like a broken tab beside three working ones. A bundle is a claim
that its members belong together; "three things that are live" and "a thing you must press" is not
that claim. Cost of leaving it out: one checkbox.

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
installing from the conversation's create dialog and uninstalling from its settings, the single
group and the *absence* of a divider, the workspace dialogs drawing no widget section at all,
switching and remembering the open tab, a new conversation opening on its first tab rather than on
one read elsewhere, falling back when the open widget is uninstalled, flipping the strip's
orientation, dragging the width and its clamp, the overflow menu, and collapsing to a rail.

Each widget that has a rule of its own has a spec of its own: `e2e/plan.spec.ts`,
`e2e/quiz-widget.spec.ts`, `e2e/thread-widget.spec.ts`, `e2e/notes.spec.ts`,
`e2e/diagram.spec.ts`, `e2e/insight.spec.ts` — the last scripting a pass over HTTP and then
asserting what a person sees: an item you keep surviving the next pass while the rest are
replaced, and a pass that produced nothing usable leaving the list exactly as it was — and
`e2e/resources-widget.spec.ts`, which makes its material the two ways a conversation really gets
some (an upload through the composer, a file a scripted tool call wrote) because "those two land
in one list" is the registry's claim rather than the panel's.

```bash
npx playwright test e2e/widgets.spec.ts   # the panel, end to end (15 flows)
npx vitest run widget                     # the selection rules, plus the web units
```

The store's own widget cases — `setWidgetEnabled`, the lifecycle hooks, the `turn.finished`
emission — live in `apps/web/test/stores/app.test.ts` under a `widgets` describe, so a filename
filter does not reach them: `npx vitest run app.test.ts`.
