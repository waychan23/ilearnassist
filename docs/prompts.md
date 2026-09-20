# Prompts

Every system prompt and guidance block the server sends a model lives in one file:

```
apps/server/src/prompts.json     the catalog — a keyed object, bundled into the server
apps/server/src/prompts.ts       loading, rendering, and overrides
<dataRoot>/config.patch.json     a deployment's overrides, applied per key at boot
```

The point is legibility and tunability. Before this, each prompt was a template literal inside the
module that used it, so "what does the system actually say to a model" had no single answer, and
changing a sentence meant editing TypeScript and rebuilding.

## The catalog

An **object keyed by prompt key**, not an array. That is what makes per-key override fall out of the
existing `deepMerge` with no new machinery: patching `prompts["title.system"]` replaces exactly that
entry.

```json
{
  "version": 1,
  "prompts": {
    "chat.system": {
      "description": "What the entry is for, when it is used, and any caveat.",
      "text": "{{persona}}{{clock}}{{workspace}}{{plan}}{{quiz}}{{collectPage}}{{table}}{{explore}}{{makeup}}"
    }
  }
}
```

Keys are **domain-first** (`chat.system.*`, `chat.guidance.*`, `title.system`), matching the i18n
catalogs' rule, never keyed by the module that happens to read them.

| Key | Read by |
| --- | --- |
| `chat.system` | `buildSystemPrompt` — the skeleton; each `{{name}}` is another entry |
| `chat.system.persona`, `.clock`, `.workspace`, `.noEscape`, `.grantedRead` | `buildSystemPrompt` |
| `chat.guidance.codeFence` | `buildSystemPrompt` — how to name a file in a code fence. **Unconditional**, alone among the guidance blocks: it is about the format of a reply rather than about a capability, so there is no assembled tool to ask about. Without it the client's file-name header would be drawing data nothing produces — see the code-block bullet in `CLAUDE.md` |
| `chat.guidance.plan` / `.quiz` / `.collectPage` / `.table` / `.explore` / `.quizMakeup` | the tool module that owns each, appended to the turn's system prompt |
| `title.system` | `agent/title.ts` — the auto-titler |
| `thread.system` | `threads.ts` — the turn classifier |
| `insight.system` | `insights.ts` — the insight pass |
| `mediaSummary.system` | `agent/mediaSummary.ts` — the image describer |

**Scope is deliberate.** Tool descriptions and schema `describe()` strings stay in code: they are
bound to zod schemas rather than being free-standing prompt text. The out-of-band *user*-prompt
templates (the classifier's `<plan>`/`<existing_threads>` sections) stay in code too, because they
interleave with data assembly. What is here is what a reader means by "the system prompt".

## Placeholders

`{{name}}` is substituted from the call's variables, and the name is restricted to an identifier so
that a prompt containing literal braces — the classifier's output schema is
`{"decisions":[{"thread":"continue"}]}` — cannot be mistaken for a placeholder.

Two rules, and the difference between them is the whole error handling:

- **A placeholder with no value supplied throws**, naming the key and the placeholder. The type
  system catches a literal typo in the *key*; this catches a missing *value*, which it cannot see.
- **A placeholder supplied as `""` renders as nothing.** That is how a block is dropped — an
  uninstalled widget's guidance arrives as `""` — so "no value" and "an empty value" cannot be the
  same thing.

A consequence worth knowing: a prompt with a stray `{{` that is not a placeholder will silently
render it as literal text, so `test/prompts.test.ts` scans every entry and fails on any `{{` the
pattern does not match.

## Everything is read at call time

**No prompt is captured in a module constant.** `export const THREAD_SYSTEM_PROMPT = …` would freeze
the bundled text the moment the module loaded — and the catalog is patched by the *process entry
point*, which runs after every module has been evaluated. A patched prompt would then silently do
nothing, which is the failure this repository names most often.

So `threadSystemPrompt()`, `planGuidance()`, `renderPrompt("title.system")` — calls, not constants.
`buildSystemPrompt` is the same shape: it holds only the **conditions** (which blocks apply, which of
two sandbox sentences) and reads every **word** from the catalog.

## Overriding a prompt: `config.patch.json`

A deployment edits `<dataRoot>/config.patch.json` and restarts. It sits at the data root rather than
beside `config.yaml` because `config/config.yaml` belongs to the *install* — inside the application
bundle for a packed build, replaced wholesale on every update — while this belongs to the
*deployment*, next to the database and the workspaces, and survives an update for the same reason
they do.

```json
{
  "prompts": {
    "chat.system.persona": "You are a patient physics tutor. …",
    "title.system": { "text": "…", "description": "Why we changed it." }
  },
  "tools": { "webFetch": { "maxChars": 12000 } }
}
```

- **It is not a prompt feature.** The whole object is deep-merged over the configuration tree, and
  `prompts` is simply one of the keys it can reach — the same file can change `server.port` or a
  tool limit. `loadConfig(patch)` merges it; `setPromptOverrides(patch["prompts"])` takes its own
  section. One file, two readers.
- **A plain string is shorthand** for `{ "text": … }`, which is what somebody overriding one
  sentence naturally writes.
- **A patched entry keeps the bundled `description`** unless the patch supplies one: the description
  documents the *default*, and replacing the text does not invalidate it.
- **Arrays replace rather than concatenate** (`deepMerge`'s rule), which is what makes "this list,
  not that one" expressible.
- **`${ENV_VAR}` works inside a patch**, because the merge happens before env resolution.
- **A typo'd prompt key warns at boot** and changes nothing; **an unreadable file throws**, naming
  the path. Both are deliberate: a patch that silently does nothing is exactly the failure this file
  exists to prevent.

Overriding an **out-of-band** prompt works the same way, but note the next section first.

## The learner's own introduction

`chat.system.about` is the one catalog block whose text comes from a **user** rather than from this
repository: the account writes it on the account page, it is stored on `users.about`, and it is sent
as prompt context on every turn of every conversation.

- **It is dropped whole when empty.** The heading, the `<about_the_learner>` fence and the sentence
  after it are all inside the block, so an account that has not written one costs a turn nothing —
  rather than a paragraph explaining that the user said nothing.
- **It is fenced and labelled as context, not instruction**, the rule `renderReferenceBlock` and the
  notes tool follow for every other piece of user-authored text. It is the user's own prose, so a
  sentence in it that reads like a command has to arrive as something they wrote.
- **It sits after the persona and before the clock** — who the assistant is, then who the learner
  is, then facts about the world. Reordering the skeleton moves it.
- **`PROFILE_ABOUT_MAX` (2000 characters) is a real ceiling**, and the reason is this block's cost:
  it is sent on every turn, so an unbounded introduction would be a per-turn token bill the account
  never sees.
- **`PATCH /api/auth/me` is the only route that writes it**, deliberately with no
  `allowPendingPassword`: an account owing a password change is refused everything but the three
  routes that get it out of that state.

## What is deliberately **not** in this catalog

Two kinds of system prompt are not here, and both are absent for the same reason: a catalog entry is
a **process-level constant**, and these are not.

### A Copilot's prompt is a database row

An assistant's `system_prompt` lives on the `copilots` table, is copied into `sessions.system_prompt`
when a conversation starts, and is editable from the console — by an account, at runtime, with no
rebuild. `chat.system.persona` is only the fallback for a conversation that has no prompt of its
own; a session with one replaces that block entirely (the guidance blocks below it are appended
either way).

So the way to change an assistant's words is the assistant editor, not `config.patch.json`. That is
also why `config.patch.json` has no `copilots` section.

### The built-in assistant ships in `builtin.json`

```
apps/server/src/builtin.json     the assistants a new installation gets, bundled into the server
apps/server/src/db.ts            seedBuiltInCopilots — create-once, marker-gated
```

**引导学习 · Guided Learning** is the entry there: a persona, the tools it may use, and the seven
widgets it installs. It is created when the first administrator is — inside `createAdmin`'s
transaction, or at server start for a data root that already has one — and it is **`public`**,
because the row belongs to the administrator and the read predicate is
`user_id = ? OR visibility = 'public'`. A private built-in would be invisible to every other
account on the installation.

**There is one prompt, and it is its author's own writing.** It is Chinese, it carries no language
rule, and it names exactly one tool (`ask_user`) — the plan, the check questions and the TODO list
are prose the model satisfies with whatever the turn has, which is why `allTools` is `true` and the
entry installs all seven study widgets: the capabilities are there, the rules simply do not point
at them by name.

**Do not "improve" it as a side effect of another change.** It was rewritten once — a language rule
added at the top, the check questions pointed at `ila_quiz`, the TODO list pointed at
`ila_make_plan` / `ila_read_plan`, the compaction rule replaced, the thinking/output meta-rule
trimmed to its instruction, rules 11 and 14 merged, two typos fixed. Each edit was defensible on
its own and together they taught noticeably worse than the text they replaced, which is why the
file holds the original again. A change to this prompt is a product change to *how the tutor
teaches*, so it belongs in its own commit with a reason — not in a pass over wording.

**The name and description are bilingual** (`引导学习 · Guided Learning`), because they are the one
part of the row a reader sees before choosing it and the picker shows them in both languages. They
are *not* translated client-side by id the way `widgetLabel` translates widgets: an assistant can
be renamed by its owner, so a client-side override would hide their rename. That the prompt itself
is Chinese-only is a deliberate asymmetry, not an oversight — see the reversion above.

The shape to reach for if a future built-in genuinely needs two languages is a `locale` field on
the entry with the seeder writing one public row per locale — and the cost to weigh is that every
account then sees two entries for one assistant.

Three consequences worth knowing before editing it:

- **The JSON is seed data, exactly like `config.yaml`'s providers.** After the first run, the
  console owns the row; editing the file afterwards changes nothing on an installation that already
  has one. To pick up an edit, delete the assistant and clear the
  `builtin.copilots.seeded` row in `app_settings` — or just edit it in the console, which needs no
  restart at all.
- **A deleted built-in stays deleted.** The marker is what makes that true, and it is a marker
  rather than "is the table empty" precisely so that purging the rows does not resurrect one
  somebody removed. `apps/server/test/builtin.test.ts` holds both halves up.
- **Its prompt is long, and it is a person's own writing.** It is stored as a JSON string with `\n`
  escapes, the way this repository's other catalog does it. **Nothing pins the text itself** —
  `test/builtin.test.ts` compares the *seeded row* to the file, so a reformat or a rewording of the
  file passes and reaches the next fresh install. The paragraph above is the only thing standing
  between this prompt and a well-meaning pass over it.

> **Do not verify this by grepping the built server.** `scripts/build.mjs` leaves esbuild's default
> `charset: "ascii"`, so a packaged `dist/server/index.mjs` contains `深入…` where the source
> has 深入 — a plain `grep 深入浅出` on the bundle finds nothing, which reads exactly like a prompt
> that failed to inline. It is inlined (the JSON is imported, and esbuild inlines JSON); the text is
> just escaped. To check, decode `\uXXXX` **and** `\n` before searching, or test it where it
> matters — start the packaged app on a fresh data root and look at the assistant list.

## The fake LLM's markers

`apps/server/test/helpers/fakeLlm.ts` decides whether a request is an out-of-band call by looking for
a **substring of that call's system prompt** — `"topic-classification function"`,
`"reflective study coach"`, `"titling function"`.

That is prose, not a stable identifier, so **reflowing one of those three prompts breaks the test
harness rather than the app**: the fake LLM stops recognising the call and the failure lands
somewhere unrelated. `test/prompts.test.ts` asserts each marker is still present in its catalog
entry, which turns a reflow into one named failing line. If you change one of those sentences,
update the marker in `fakeLlm.ts` — do not delete the entry.

## Testing

| File | Covers |
| --- | --- |
| `test/prompts.test.ts` | catalog integrity, placeholder rules, the marker guards, and `buildSystemPrompt`'s composition — block order, the two sandbox variants, no stray blank lines, and that a patch reaches the assembled prompt |
| `test/config-patch.test.ts` | reading the patch (missing / malformed / non-object) and merging it through `loadConfig` |

The two halves are tested apart because the merge is pure and the read is not, and only the read can
fail in a way a person needs to be told about.
