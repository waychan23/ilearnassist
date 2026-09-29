# Context compaction

A conversation can compress its earlier history into one summary, so later turns send the
summary plus the messages after it instead of the whole transcript. It is **manual** — a button
in the composer — and **reversible**: every message stays in the database, and restoring the
full context is one column moving back to `NULL`.

The requirement this implements, in one line:

> 增加一个会话级别的实验特性"上下文压缩"……每次发送给LLM的上下文为"压缩总结内容+压缩点位后的消息原文"。

## The two rows that are the whole state

Nothing about a message is rewritten. Compaction is:

| where | what |
| --- | --- |
| `context_summaries` | one row per compression: the summary text, the point it covers **through** (`through_message_id`, and `through_created_at` beside it), how many messages it covers, when it was made |
| `sessions.active_summary_id` | the pointer at the row in force, or `NULL` for the full history |
| `messages.summary_id` | provenance on each message written under a compacted context — which summary the turn was sent or generated under, `NULL` when the full history was used |

`SCHEMA_VERSION` does not move: the table is new (created by `applySchema`) and the two columns
are additive (`ensureColumn`), the rule in `docs/migrations.md`.

**`through_created_at` exists because the point can be deleted.** The turn's history is cut by
`applyContextSummary`, which finds `through_message_id` by id first — exact — and falls back to
`created_at >` only when the named message is gone. A summary that could not find its own point
would silently send the whole history, which is the failure this feature exists to prevent.

## What a turn sends

```
SystemMessage( buildSystemPrompt(… , contextSummary) )   ← the summary, as a catalog block
…history cut at the point…                                ← verbatim messages after it
HumanMessage(this turn)                                   ← when there is one
```

The summary is a **block of the system prompt**, not a `HumanMessage`: it is not something
anybody said, and a message would be a question to answer (`chat.contextSummary` in
`prompts.json` says where it came from and that it is a record). `trimHistory`'s
`maxContextMessages` still applies to the tail, never to the summary — the point of the feature
is that the early history stops costing tokens.

Every turn route goes through `effectiveContextFor` (`/chat`, `/answers`, `/regenerate`, the
make-up submit), because a regenerate that replayed a history the last turn did not use would be
asking a different question.

## Compression

`POST /api/sessions/:id/context/compact` (session-locked):

1. Reads the **effective** context: `applyContextSummary(messages, active)` — the previous
   summary (if any) plus the messages after its point.
2. Refuses `CONTEXT_EMPTY` when there is nothing there.
3. Calls the model through `agent/compact.ts`, which folds the transcript chunk by chunk
   (`COMPACT_CHUNK_CHARS` per call, one message clipped to `COMPACT_MESSAGE_MAX_CHARS`,
   tool outputs to `COMPACT_TOOL_OUTPUT_MAX_CHARS`). Each later call receives the running
   summary, so the cost is proportional to what has been said and any conversation fits.
4. Writes one `context_summaries` row and moves `active_summary_id` to it — **after** the model
   call, so a failure (`COMPACT_FAILED`, with the provider's words in `params.detail`) leaves
   the previous state exactly as it was and the retry is the button again.

**A re-compression folds, it does not re-read.** The previous summary is handed to the model as
`<previous_summary>` and the tail follows; the new row's `message_count` is
`previous.messageCount + tail.length`, so the preview reports the conversation's whole compacted
extent. The summarizer's own tokens are on the ledger under `summary.context` and are attributed
to the conversation (`GET /api/sessions/:id/usage` includes them).

**The summarizing model is the session's own** — the same resolution `turnContext` performs for
a chat turn, which is also how the titler and the classifier pick theirs.

## Restore

`POST /api/sessions/:id/context/restore` moves the pointer back to `NULL` and returns the same
`ContextState`. The summary rows stay: they are provenance for the messages written under them
(`messages.summary_id`), so a restore is not a delete. Idempotent — a conversation already on
the full context gets its state back, not a refusal.

## Reading it

- `GET /api/sessions/:id/context` → `ContextState { summary, totalMessages, tailMessages }`.
- `GET /api/sessions/:id/usage` → `{ totals }`, the conversation's lifetime ledger (filtered by
  the `sessionId` added to `StatsQuery`/`LedgerQuery`), which the usage popover shows.

In the browser: `TokenCountPopover` carries the mode line and the conversation's cumulative
totals, and its "view context" action opens `ContextPreviewDialog` — the summary itself, the
point, the covered/tail counts, and the compact/restore controls. The composer's compress button
confirms, runs the compression and opens the same dialog so the user sees what was produced.

**A compression pauses sending, and a failure does not.** While the call is in flight the
composer carries an inline "compacting" notice and refuses new turns — the button, the quick
replies and `sendMessage` itself, because the summary a turn would carry is exactly what is being
rewritten. A failure resets that state, reports the provider's words through the toast (which
also says the previous context is still in use), and leaves the draft where it was: nothing to
reload, nothing stuck, and the retry is the compress button again.

## What compaction does not touch

**Cards, references and quiz rows are not message-derived, and they keep working.** Three
consequences worth knowing, because only the first two are obvious:

- **引用 (`@`) and 追问 chips still render, still open, and still work on a new turn.** What
  stops at the point is their *replay*: `referencesForHistory` and `sourcePaths` are built from
  the effective history, so a reference on a compacted message no longer reaches the model as a
  pointer or as bytes. The material itself is not gone — `session_references` is a table, and
  `ila_query(kind: "resource")` / `read_document` can still reach it — and the summary prompt
  asks the summarizer to keep file names and conclusions. A conversation that still depends on
  an old reference can simply `@` it again.
- **补答 (make-up) is unaffected.** Quiz questions live in `quiz_questions`, not in messages, so
  eligibility and answers never depended on history. The make-up route writes a *new* completed
  `ila_makeup_quiz` call at the newest position — after the point — so the grading turn replays
  it like any other tool result.
- **A card waiting on an answer blocks compaction** (`CONTEXT_PENDING_QUESTION`, and the button
  is disabled with the reason). The awaiting call lives on the conversation's last live message,
  which is exactly what the point would name: when the answer arrived, the completed call and
  its tool result would fall before the point and never be replayed — the model asked to
  continue from an answer it cannot see to a question it cannot see (the summarizer drops
  calls without an output). The card is the most recent thing in the conversation, so answering
  or skipping it first costs nothing.

## Reading back what the summary dropped

A summary is lossy by design, so the transcript stays readable: **`ila_recall`** (nothing else
does this) returns this conversation's stored messages — mode `"recent"` for the newest `limit`
messages, mode `"search"` for a case-insensitive substring over the text, both paged with
`offset`. It reads through `db.listMessagesForUser`, the same accessor the turn routes replay
history from, so a soft-deleted message is as invisible here as it is to the model, and another
account's conversation is unreachable.

Three deliberate limits, each stated in the result's own `note` so a model cannot misread what
it got:

- **Message text only.** Tool outputs and reasoning are neither searched nor returned — the
  summary already carries their gist, and including them would make every page heavier than the
  question that asked for it.
- **A substring, not a meaning.** It finds a message by the words in it and cannot see a
  paraphrase; the note says so, so an empty answer reads as "try another word" rather than
  "nothing was said".
- **This conversation only.** Cross-conversation search is `ila_explore`'s `message_search`,
  which is gated on the `@` grant — widening recall would blur that grant's meaning.

The tool is assembled in **every** conversation rather than only when a summary is active: its
availability must not vary with the state it reads (a description cannot say "sometimes
absent"), and the same read is what recovers messages a `maxContextMessages` window trimmed.
`chat.guidance.recall` is appended whenever it survives assembly, so the model is told the
transcript is reachable at the moment it matters — the summary block says what was compacted,
and the guidance says it can be looked up.

## Deliberate edges

- **A fork does not inherit compaction.** `cloneSessionMessages` omits `summary_id` and the new
  conversation's pointer is `NULL`: the source's point is a fact about the source's history.
- **Deleting a message after the point** is ordinary — history is already cut after it.
- **The usage popover's "context used" figure** is last turn's `contextTokens` and lags a
  compression by one turn; the mode line is what says the next turn is compacted.
- `e2e/context-compaction.spec.ts` reads the assembled request off the fake LLM, which is the
  only assertion that proves "the summary plus the tail" rather than inferring it from the UI.
