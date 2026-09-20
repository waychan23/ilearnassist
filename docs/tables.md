# Tables

The model records a table — a comparison, a summary, a tabular result — and the conversation's
图表 panel lists it beside the diagrams. **The table itself is never rendered by the panel in the
conversation**: it is written into the reply as ordinary Markdown, and what the tool writes is a
row that keeps it findable afterwards.

This is the working reference. `docs/diagrams.md` is its sibling and the source of most of the
patterns here; the invariant that governs both is in [CLAUDE.md](../CLAUDE.md).

## The requirement that shapes everything

> 图表 Widget 中目前仅支持展示"图（diagram）"，"表（Table）"目前没有支持，期望支持，即会话消息中的
> 表格也纳入图表Widget的展示 — and the display of a table is *inline message content rendered as
> Markdown*, not a separate tool container.

That divides the feature in two, and the division is the whole design:

| | where it lives | who reads it |
| --- | --- | --- |
| the **reply** | the assistant message's own Markdown | the person, in the conversation |
| the **row** | `session_tables.content` | the 图表 panel, the viewer, the clipboard |

Nothing can make the two agree — the reply is model-authored prose and the row is a string the
model passed as an argument — so the drift is *reported rather than prevented*, which is the rule
`docs/diagrams.md` sets for its own two drifts. What the feature must not do is let the difference
pass silently: the tool's result says what was **saved** and asks for the inline copy separately,
rather than claiming the reply already shows it.

**And the reply half is the reason the agent loop stopped trimming a turn's text at all.** This
feature was the first casualty: a table renders no card, so the prose beside the `ila_table` call
*is* the table, and in the shape a real model produces (the table in the step that records it,
then a closing question) it streamed live and then vanished at `message_done`, so the panel listed
a table the conversation no longer showed. It was patched with `ANSWER_BEARING_TOOLS`, an
allowlist of tools whose prose counted as an answer — and a third entry was due for every teaching
tool, the lecture-a-chapter case included. The rule is now general and has no allowlist: **the
message is exactly what streamed** (see `CLAUDE.md`), so the table is kept because the model wrote
it, not because of which tool was beside it. Pinned in `test/agent/loop.test.ts`,
`test/chat-sse.test.ts` and, end to end, in `e2e/table.spec.ts` — which asserts the table both
live and *after a reload*.

## The shape

```
packages/shared/src/index.ts     TABLE_TOOL_NAME, Table / GetSessionTablesResponse,
                                 QUERY_KINDS += "table", WIDGETS.diagram.tools.names
apps/server/src/tables.ts        tableName, looksLikeMarkdownTable, registerTable, listTableViews
apps/server/src/tools/table.ts   buildTableTool, TABLE_GUIDANCE
apps/server/src/tools/index.ts   NON_FILE_TOOLS += ila_table
apps/server/src/schema.ts        session_tables             the rows
apps/server/src/db.ts            upsertSessionTable, listTableBriefsBySession, assignTableToThread
apps/server/src/routes.ts        /api/sessions/:id/tables   the panel's read
apps/server/src/threads.ts       places each table in a thread
apps/server/src/tools/query.ts   ila_query(kind: "table")   the model's read of its own table
apps/web/src/utils/figures.ts    the panel's arithmetic: merge, sort, filter
apps/web/src/widgets/DiagramWidget.vue                    the panel: rows of both kinds
apps/web/src/utils/toolCallCards.ts                      the calls that render no card at all
apps/web/src/components/dialogs/DiagramDialog.vue         the viewer, two kinds
apps/web/src/utils/tableClipboard.ts                      what a paste receives
```

## The tool

`ila_table`, with `{ name, summary, table }`. Like `ila_diagram` it is **`auto-install`**: ordinary,
allow-listable, pickable in a Copilot, and calling it installs the 图表 panel that lists it.

Three refusals, all of them before the write — which matters more here than for a diagram, because
the upsert revises by name: a refused call that had already reached `save` would replace the copy
the panel holds with nothing.

- an empty table,
- one past `MAX_TABLE_CHARS`,
- **one that is not a Markdown table**: no header separator row (`|---|`, `| :--- |`, `--- | ---`).

That third refusal is the one piece of content validation this repository takes on, and the
asymmetry with `ila_diagram` is deliberate rather than an oversight. Mermaid syntax is not
validated there because the *renderer* is the authority on what it can draw — two validators would
be two opinions free to disagree. A table's claim is different in kind: the panel says "this is a
table", and `markdown-it` renders one only when that separator row is present. So the check refuses
exactly the case with no reading in which the caller was right, and only the separator row — a full
parse would be the second renderer all over again.

`tableName` is `slugify(name, "table")`, with **no extension**, and that is the one thing it does
not share with `diagramFileName`: a diagram's name is a file name and has to round-trip through the
filesystem, while this one is an identity and a label. No uniqueness suffix, for the diagram's
reason — the name *is* the identity, so calling again with the same name corrects the table rather
than adding a second one.

### The teaching, which is not decoration

Nothing on the server can write into a model's reply, so "the table also appears inline" is a
prompt instruction or it is nothing. `TABLE_GUIDANCE` lives in `tools/table.ts` (the tool and its
teaching are one thing — `COLLECT_PAGE_GUIDANCE`'s rule) and reaches the system prompt on any turn
where the tool **survived assembly**, asked of the assembled array and never the config, so a
Copilot whose allow-list excludes it is never taught a call it cannot make.

It has to exist for the reason that docblock gives one tool over: the tool's own description is
necessarily a *restriction* ("not every table"), and a model that was never told the positive half
reads a restriction as "usually do not". Without it the feature ships as an implemented thing that
behaves as if it were not there.

## The row

`session_tables`, and the one thing that inverts a rule the diagram tables follow:

| the row holds | why the diagram's row does not need it |
| --- | --- |
| `content` — the markdown | a diagram's bytes are a file; this row **is** the artifact |
| `name`, canonical, no extension | the identity for a revise, and the panel's label |
| `summary` | the model's one-line description; nothing else records it |
| `tool_call_id` | "which reply recorded this" without scanning the message list |
| `thread_id` | which 脉络 the classifier put it in — not derivable from the markdown |

`session_diagrams.summary` is this schema's precedent for "what the bytes cannot answer, stored
beside them"; there are no bytes here to store beside. Nothing can disagree with `content` because
there is nothing else — for the panel. The reply is a second copy, and that is the drift above.

**No file and no reference, and deliberately.** Since v4 the material an account holds is an entity
plus a *reference*, and a table has neither: a reference is what makes something appear in the
library and in the `@` picker, and every consumer of one is path- or entity-driven — there are no
bytes for a `files.path` to name. The asymmetry is the norm rather than the exception: `ila_query`,
`ila_explore`, `ila_quiz`, `ila_make_plan` and the insight pass all write session-scoped rows with
neither a file nor a reference. `session_diagrams` is the only tool-written row that also has one,
and only because it *is* a file — which is precisely why a drawn diagram has a `files` row and no
reference of its own. Writing a `.md` into `sessions/<id>/` instead is explicitly *not* the answer:
it would put two full copies of the same artifact on disk — the one drift `docs/diagrams.md` says
the architecture cannot represent — and `write_file` already gives a model that wants a file.

**No `fileMissing`.** There is no file to be missing, and the field's absence on the wire is what
the `Table` type says. Its absence in the tests is an assertion rather than an omission.

## Why the model can read its own table

A diagram needs no read tool: the fallback past the history window is "call it again and rewrite",
and that is cheap for something that winds up in a file — which the model can also read through
`ila_query(kind: "diagram")`. **That argument does not transfer.** A table has no file, so without
a read path the model past its history window cannot see what it wrote, cannot revise it correctly
(it would need the current contents), and the tool's own "call again with the same name" would be
advice it has no way to follow.

So `QUERY_KINDS` gains `table`: `ila_query({kind: "table", name})` returns the markdown, and
without a `name` it lists names and summaries. Not a new tool — a read tool is the widening
`docs/diagrams.md` already declined once — and the data was already in the database, so the surface
does not grow.

## The thread classifier

A table rides the turn classification exactly as a diagram does: `thread_id` is null until the turn
owning its latest call has been classified, a revise clears it so the new shape is judged again, and
the answer is a second, **ref-keyed** array (`{"tables":[{"ref":"t1","thread":"continue"}]}`).

Four things about that are load-bearing, and each has a test:

- **Two wire keys, one implementation.** `diagrams` and `tables` are separate arrays — a
  model-authored `kind` field would be a new thing to get wrong — but the parser is one
  parameterised function, and the prompt block for a chunk with only diagrams is byte-identical to
  what it was before tables existed. Renaming `diagrams` to something shared would churn pinned
  tests and three documents for no behaviour.
- **The ref prefixes are the discriminant** (`d1` / `t1`), so the model's answer carries no new
  field and the existing `allowedRefs` check drops a ref it was never given.
- **`MAX_TABLES_PER_PROMPT` is separate** from `MAX_DIAGRAMS_PER_PROMPT`. A shared counter would
  silently become "12 artifacts", so a table-heavy conversation would leave its diagrams unplaced.
- **The forced-turn exclusion is shared**, because the ref allocation is one loop over the same
  `modelTurns` for both kinds. A separate loop would break the deterministic plan-turn collapse for
  tables while leaving it intact for diagrams — the asymmetry no other test would catch, which is
  why `threads.test.ts` writes that case out for a table specifically.

## The panel and the viewer

`DiagramWidget.vue` reads both routes (`Promise.all`, one loading state) and renders one list: the
merge, the sort and the filter are `utils/figures.ts`, unit-tested, because the repo does not
unit-test `.vue` files. The list is chronological rather than grouped by kind — the panel answers
"what has this conversation made", and the filter is what narrows it.

Three consequences worth naming:

- **A diagram row and a table row open differently.** A diagram's row names a file, so it goes
  through the ordinary file preview, exactly as the file tree opens it. A table has no file: its row
  holds the markdown, and it goes straight to the viewer with nothing to fetch. So a table row has
  no `stem()`, no `fileMissing` and no missing styling.
- **The filter is client-side with options derived from the rows.** One conversation's set is small,
  and a server round trip per filter click would pay `reconcileFilesystem`'s bounded walk for
  nothing — `ResourcesWidget`'s rule. An option that can only produce the empty state (表 in a
  conversation with no tables) is not offered at all.
- **`table.changed` is its own widget event.** The emission site is keyed on the tool's name, so
  sharing `diagram.changed` would make each panel refetch on the other's calls.

**The call renders no card at all**, and that is the rule rather than an omission —
`CARDLESS_TOOL_NAMES` in `utils/toolCallCards.ts` is the whole of it. The table is the reply, so a
box beside it could only repeat the summary; the generic disclosure would be worse than redundant,
since it renders the whole markdown as JSON inside a fold, which is the one shape the requirement
rules out. An earlier version drew a one-line card instead, and it was deleted: the sentence it
carried ("the table is written out in the reply") existed only to explain a box that should not
have been drawn.

**The card was also the jump anchor, and that is the part removing it had to answer.** 定位 emits
`chat.jump` with a tool-call id, which resolved to `[data-tool-call-id]` on the card; with no card
there, `MessageItem` puts the ids of a message's cardless calls on the message row as
`data-tool-call-anchor`, and `revealToolCall` matches one id with a CSS `~=` selector. The message
is the better target anyway — the table really is in that block — and it is the one that always
exists, since a model that recorded a table and wrote no prose still leaves a message. That last
case is worth naming: with no card and no prose there is nothing on screen for the call at all,
which is the accepted cost of the rule above.

The viewer is the diagram viewer, with a `kind` on its content: `{ kind: "table"; markdown }`
renders through the **same** `renderMarkdown` the reply uses, so the panel's table and the
conversation's cannot be styled two ways. Its 复制 writes both flavours at once — `text/html` for a
document, `text/plain` for a source file — with the borders inlined by `utils/tableClipboard.ts`,
because a stylesheet does not travel with a clipboard fragment.

## The insight pass

`insights.ts` reads tables too: `hasMaterial` counts them, `gatherSources` collects them, and the
prompt gains a `<tables>` section carrying **name and summary only** — never the markdown, for the
reason `MAX_DIAGRAM_SUMMARY_CHARS` exists. Without the clause a conversation whose only artifact is
a table would be told it has nothing to reflect on, which is false and visible.

## Watching it work

```
pnpm dev:restart
```

Ask for a comparison table ("做一个终端对比表"), and check: the reply renders a real table in its own
prose, the call is one line under it saying the table is in the reply, the 图表 panel lists the row
with the model's summary, clicking it opens the viewer showing the same table, 复制 pastes into a
document with borders, and 定位 scrolls back to the call. With a diagram in the same conversation,
the panel's filter offers 全部 / 图 / 表 and the count moves with it.
