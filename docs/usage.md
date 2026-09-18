# Usage and model provenance

Two questions the app could not answer: *which model wrote this message*, and *what did all of this
cost, and for what*.

```
usage_events                          one row per model call — the ledger
messages.provider_* / model_*         which model wrote each turn, denormalized
apps/server/src/usage.ts              the write path, the aggregates, the day arithmetic
apps/server/src/agent/callUsage.ts    the one place `usage_metadata` becomes a MessageUsage
apps/web/src/components/stats/        the panel both statistics pages render
```

## Why a ledger rather than a sum over `messages`

`messages.usage` records a **turn's** tokens, and only a turn writes a message. Five other calls the
server makes on its own cost real tokens that no transcript holds: the auto-titler, the turn
classifier, the insight pass, the image describer and the note-export summariser. The requirement
asks for spend *by purpose*, and a purpose only the transcript could not express is the whole point.

A sum over `messages` also cannot group: `usage` is a JSON blob whose fields are optional, which is
exactly why `widgets.ts`'s existing statistics do their arithmetic in JavaScript. `SUM()` over
columns is what four groupings and a date range need.

## The table

`usage_events` is a pure DDL addition, so **no `SCHEMA_VERSION` bump** — the rule every new table
follows. Four things about its shape are load-bearing:

- **A row is attributed, not joined.** `user_id`, `workspace_id` and `session_id` are columns rather
  than a lookup through `sessions`, so one account's range is one indexed scan — and so a row
  survives the conversation it describes. Nothing here cascades; there is no `deleted_at`.
- **The provider and model names are denormalized**, beside their ids, for `messages.model`'s reason:
  a provider renamed or deleted next month must not rewrite what a past month cost.
- **Cache miss is not a column.** `cached_input_tokens` is a *subset* of `input_tokens` as providers
  report it, so a third stored figure could disagree with the other two and nothing could say which
  was right. `UsageTotals.cacheMissInputTokens` is derived where it is read, and the two halves add
  up to the input total by construction.
- **`duration_ms` is nullable.** Zero is a real measurement; NULL is "nobody timed this". An average
  that folded NULL into zero would report a number nobody measured — which is why the panel shows an
  em dash for a bucket whose `durationMs` is zero.

## What is recorded, and by whom

| Purpose | Written by | Measured |
| --- | --- | --- |
| `chat` | `finishTurn`, from the run's summed usage | the route, around the whole run |
| `title` | `agent/title.ts` via its `onUsage` | the factory, around the request |
| `thread` | `agent/threads.ts`, both the post-turn hook and the panel's backfill | the factory |
| `insight` | `agent/insights.ts` | the factory |
| `summary.media` | `agent/mediaSummary.ts`, once per image | the factory |

Every pass reports through `agent/callUsage.ts`, which is **the one place a provider's field names
become this app's** — the main loop uses it too, so the transcript and the ledger cannot disagree
about what a provider reported.

`recordUsage` is called through `passRecorder` (`routes.ts`), which resolves the attribution once:
every pass runs inside an account's turn or an account's session, and one place to resolve the ids is
what stops a new pass from being wired with a different idea of whose call it was.

**It cannot fail the call it describes.** Observability that can break the thing it observes is worth
less than the row, so `recordUsage` swallows its own failures — and it writes **nothing** for a call
whose provider reported no usage, because an all-zero row would drag every average toward it.

## Reading it

- `GET /api/stats` — always scoped to the caller.
- `GET /api/stats/sessions` — the per-conversation table.
- `GET /api/admin/stats` — `requirePlatformAdmin`; the only one carrying `byUser`, whose *absence* on
  the other two is the permission.

`usageFilter` resolves the date range into **local calendar days in the reader's zone**, measured per
day with `Intl` rather than assumed: a day that ended at the server's midnight is a day nobody lived
through, and a fixed offset is wrong on one side of a daylight-saving boundary. A bound that cannot be
parsed is *dropped* rather than refused — it can only have come from a hand-edited URL, and the answer
to a malformed bound is the unbounded answer.

Days inside a named range are **filled in** with zeroes, because a chart drawn from only the days that
happen to have calls compresses a quiet week into a busy-looking line. An unbounded query is not
filled: there is no quiet day to invent when the reader asked for everything.

`since` is the earliest row there is, which is how a page says **when counting began**. The ledger is
forward-only — there is no backfill from `messages` — so a page reporting zeroes for last month is
telling the truth about its own window, and a reader not told that will read it as a month in which
nothing was spent.

## The model on a message

`messages` gained four columns by `ensureColumn`: `provider_id`, `provider_name`, `model_id`,
`model_name`. The names are stored with the ids because a turn's provenance must not change when the
configuration does.

It lives on the **message** rather than the session because a model is a generation parameter the user
can change mid-conversation — a transcript with two models in it is one whose figures are
unattributable without this. `describeModel(provider, modelId)` is the one resolver, used by the
message write, the `⚠️` failure row and every ledger entry, so the three cannot disagree.

Absent is honest rather than defaulted: a message written before the columns existed has no model, and
filling in the session's current one would be a claim about a turn nobody recorded.

## The statistics pages

One component, `components/stats/StatsPanel.vue`, rendered by two hosts that differ only in
`scope`: `UsageView.vue` at `/usage` (the account's own) and `admin/StatsSection.vue` in the console
(everybody's). A second implementation would be a second set of decisions about what a figure means.

### Charts

Chart.js, loaded as a **lazy chunk** behind a memoized promise — a static import would put it in the
initial bundle for a screen most sessions never open. `utils/charts.ts` holds the DOM-free half.

`chartTheme` takes a **reader** rather than reaching for `getComputedStyle`, which is what makes the
palette unit-testable: jsdom applies no stylesheet, so a real read returns `""` for every token. Two
rules come from mermaid's canvas sibling and are asserted in `test/utils/charts.test.ts`:

- **Concrete colours, never `var(--token)`.** A canvas has no cascading context, so
  `ctx.fillStyle = "var(--accent)"` is not a colour — it is a string the canvas ignores, and the
  chart keeps the previous fill, which reads as every series being the same colour.
- **No series may use the axis colour.** A line the same colour as the ticks beside it is one the
  reader has to work out from position.

`e2e/usage.spec.ts` carries the one claim no other test can make: that a canvas was *painted*. A
blank canvas and a drawn one are the same element to every assertion that is not reading pixels.
