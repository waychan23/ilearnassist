# User preferences

A conversation remembers the standing requirements its user states about how the assistant should
work — "回答先给结论", "不要使用表格", "写文件前先问我" — and can inject them into every turn's
system prompt. The feature is **experimental** and its injection switch is a session setting, the
smart-context switch's shape.

The requirement this implements, in one line:

> 用户偏好：会话级别的长期要求，两种类型（期望 / 不期望），只在用户显式要求时提取；同一会话内后提取的覆盖旧的；可用实验开关注入系统提示词。

## The three levels

Preferences live at three levels, declared by `PREFERENCE_SCOPES` and stored in one table:

| scope | `scope_id` | who may create one today |
| --- | --- | --- |
| `user` | `NULL` | nobody (the level is read, not written) |
| `workspace` | the workspace's id | nobody |
| `session` | the conversation's id | the tool, and the selection action |

**Only session-level rows can be created**, but every read is already multi-level: the injected
block and `ila_query kind "preference"` return all three scopes in ascending specificity, and the
prompt text states the rule — a session rule overrides a workspace rule, which overrides a user
rule; within one scope, a later rule overrides an earlier one. A future workspace or account
screen is a write path, not a second model.

`user_preferences` carries `deleted_at`, unlike `insight_items`. The argument is the row's nature:
an insight is derived and can be regenerated, while a preference is a record of something the user
said, two writers end rows here (the tool, and the extraction's conflict replacement), and the
superseded row is what makes "this replaced that" inspectable later. Every read filters it.

## Recording

Two paths, both ending in `savePreference` (`apps/server/src/preferences.ts`), which is the one
place the validation, the transaction and the replace protocol live.

### During a turn: `ila_save_preference`

The agent's tool, `auto-install` mode: ordinary and allow-listable, and calling it installs the
用户偏好 panel that lists it. `chat.guidance.preference` carries the explicit-only boundary — a
model may record what the user asked for in so many words and must never infer a preference from a
reaction, a tone, or its own judgement. Recording is deliberately **not** gated on the injection
switch: that switch decides what the model is *told*, not what it may remember.

### From a selection: 作为用户偏好

The message-selection toolbar's own action (the host's, like 追问, so it works whether or not a
widget holds the conversation's claim) sends the passage to
`POST /api/sessions/:id/preferences/extract`. That route runs **one out-of-band model call** —
`agent/preferences.ts`, the insight pass's streaming shape, its own `ILA_PREFERENCE_REASONING`
switch and its own ledger purpose (`preference`) — which turns the passage into one rule and
decides what it supersedes. Three outcomes:

- `saved` — the row was written, the panel is installed (from silence, never over a decision), and
  the client refreshes its installed list so the tab appears.
- `skipped` — the model read the passage and found no standing requirement. An answer, not an
  error; the toast says so, because a press that produced nothing must not look broken.
- `PREFERENCE_EXTRACT_FAILED` (502, provider words in `params.detail`) — nothing was written.

## Conflicts

`savePreference` takes an optional `replaces: string[]`. Every id must be a **live session-level
preference of this conversation**; the delete and the insert share one transaction, and an unknown,
foreign or already-deleted id **refuses the whole write** rather than being skipped — a delete that
did not happen must never look like one. The model learns the ids from the injected block, from a
previous tool result, or from `ila_query kind "preference"`.

Across levels nothing is deleted: the injected block states the precedence and the model applies
the more specific rule.

## Injection

`SessionSettings.userPreferences` is tri-state, like every field in that blob:

| value | meaning |
| --- | --- |
| `true` | always inject |
| `false` | never inject |
| `null`/absent | **follow the context mode**: on for smart context or an active compaction summary, off on the full history |

The default follows the mode because the injected block is what carries the preferences once the
history no longer does. `effectivePreferencesEnabled` (server) and `store.effectiveUserPreferences`
(client) compute the same expression, so the composer's toggle shows the state a turn will use
without a round trip. Pressing the toggle writes the opposite as an explicit answer; there is
deliberately no "back to default" control.

The block is present only when the switch is effectively on **and** at least one preference
applies, rendered by `chat.preferences` with one `<preference id scope type>` element per row. A
fresh conversation is byte-identical to one from before the feature existed.

## Reading it

- `GET /api/sessions/:id/preferences` — this conversation's own (session-level) rows, the panel's
  list.
- `DELETE /api/sessions/:id/preferences/:preferenceId` — soft delete; unknown, foreign or
  non-session ids are `PREFERENCE_NOT_FOUND`. The panel confirms before calling it, like every
  other destructive control.
- `ila_query kind "preference"` — the model's read, all three levels with ids, for conflicts when
  injection is off or the history was trimmed.

## A fork copies them

`clonePreferences` copies the branch's live session-level rows with fresh ids, keeping the source's
timestamps. The account-level and workspace-level rows are not the conversation's to duplicate.

## Deliberate edges

- **The extraction is a model call, not a parse.** Storing the passage verbatim would be recording
  a sentence rather than a preference, and it could not judge conflicts.
- **No read of preferences from another conversation** is possible, at any level: the reads are
  owner-scoped and the session arm is scoped to the conversation.
- **The panel is not in `DEFAULT_WIDGET_IDS`.** The feature is experimental, and a conversation
  that never records a preference should not carry an empty panel; recording one installs it.
- **The usage ledger gets a `preference` purpose**, so the extraction's cost sits beside the six
  other calls rather than inside the turn's total.

## Testing

| File | Covers |
| --- | --- |
| `apps/server/test/preferences.test.ts` | the effective switch, the write and its refusals, the two renderers, the extraction parser |
| `apps/server/test/preference-routes.test.ts` | the tool's write and auto-install, the injected block on every default, `ila_query`, the extraction route's three outcomes, GET/DELETE |
| `apps/server/test/fork.test.ts` | the clone |
| `apps/web/test/stores/app.test.ts` | the effective computed, the `preference.changed` event, the selection action's outcomes |
| `e2e/preferences.spec.ts` | the whole gesture: a stated rule recorded and listed, injection read off the wire, deletion, and the hand-made extraction from a selection |
