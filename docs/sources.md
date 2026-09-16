# Sources

One record for every piece of material an account holds: an uploaded file, a page the agent
fetched, a file the agent wrote into a workspace, a file it wrote into a conversation's own
folder. The point of one record is one **id space** — a message can reference any of them, a
browser can list them together, and "where did this come from" is a column rather than a guess.

This file is the reference for three things that are easy to get wrong: the four questions a
source answers, the rules that keep the registry in step with the filesystem, and the write
location — which is the part a user can change and therefore the part that has to be explained
rather than assumed.

## The four questions

A source is one row in `sources`, and the row's job is to answer four questions that used to be
answered by *where the file was*:

| question | column | values |
| --- | --- | --- |
| Who holds it? | `owner_kind` + `owner_id` | a `workspace` or a `session` |
| How did it come to exist? | `origin` | `session_attachment`, `workspace_upload`, `agent_workspace`, `agent_session`, `web`, `note_export`, `discovered` |
| Where are the bytes? | `storage` (+ `rel_path`) | `upload`, `web`, `workspace`, `session`, `trash` |
| What is it? | `category` | `page`, `text`, `markdown`, `code`, `diagram`, `image`, `document`, `other` |

`origin` is fixed for the life of a row; `storage` is the one that changes. They are two
columns rather than one because "how did this come to exist" and "where is it now" are different
questions — a file the agent wrote into a workspace, moved to the trash by the user, is still
`agent_workspace` and is now `trash`.

`discovered` is the origin nothing claims: a file found in a sandbox with no row to account for
it. Its own value rather than a guess between the two `agent_*` ones, because those mean "the
assistant wrote this" and the browser prints them as such.

`note_export` is the learner's own writing, written into their library by the conversation's
同步到资料库 action. Every other value names *who wrote* the material, and the browser prints that
beside the row — so filing a person's notes under the assistant's name would be the same lie
`discovered` exists to avoid. Each note becomes its own `source` at
`sessions/<sessionId>/notes/<noteId>.md`, with the conversation's summary in an email-shaped
header so the note is legible to a reader who was not in the conversation. The note id is the
join key, so a re-export updates rather than replaces and an `@`-reference keeps pointing at
something. A note whose source is removed takes its file with it, which is the one place the
"a soft delete keeps the bytes" rule does not hold: the bytes are a pure function of the note, and
a file left behind would be re-registered by the next reconcile as a `discovered` source — the
deleted note, back under a different id.

## Identity: two rules, not one

```sql
CREATE UNIQUE INDEX idx_sources_blob  ON sources(user_id, sha256) WHERE sha256 IS NOT NULL;
CREATE UNIQUE INDEX idx_sources_place ON sources(user_id, owner_kind, owner_id, rel_path)
  WHERE deleted_at IS NULL AND rel_path IS NOT NULL;
```

- **Identical uploaded bytes are one row.** That is the dedupe the old schema was built on, and
  it is why re-uploading a file the user deleted *revives* that row rather than inserting beside
  it — the bytes, the parse state and every link were never dismantled, so the file comes back
  everywhere it was used. This index is deliberately **not** filtered by `deleted_at`; filtering
  it would break `findDeletedSourceByHash` and the revive with it.
- **A file is placed by where it is.** So a rename is an `UPDATE` of `rel_path` on the same row,
  which keeps the id — and with it every `messages.attachments` snapshot pointing at the file,
  its summary and its parse state. Two identical files in two directories are two sources: a
  file's identity is not its content.

A file row's `sha256` is NULL, which is why the two indexes can never contend.

## Where the bytes live, and why nothing absolute is stored

```
<dataRoot>/users/<slug>/
  workspaces/<wsSlug>/
    workdir/<path>                    storage: workspace
    sessions/<sessionId>/<path>       storage: session
    trash/<sourceId>/<path>           storage: trash
  sources/
    raw/<sourceId>.<ext>              storage: upload   (rel_path IS NULL)
    web/<sourceId>.<ext>              storage: web      (rel_path IS NULL)
    parsed/<sourceId>.txt             every storage's extracted text
```

The bytes stay where they are. Copying an agent-written file into `sources/` would mean two
copies of the same bytes — the one drift `session_diagrams` cannot represent — or a workdir of
symlinks, which would force the file browser to weaken the `realpath` check it exists to have.

`parsed/` is one tree for every storage, so `read_document` and the prompt builder need one
lookup and no branch per origin.

**No path is stored absolutely.** `storage` picks the root and `rel_path` says where in it; a
blob stores neither, because its filename is `<id>.<ext>`, derived from the id and the MIME type.
That derivation is what `raw_path` always was — `paths.ts` has said "derived, never stored as a
fact in its own right" since the beginning — and removing the one stored absolute path is what
lets a data root be copied or moved without every source silently reading as missing.

Every read re-validates: `resolveSourceBytes` in `sourcePaths.ts` refuses a `rel_path` that
climbs out of its root, an absolute one, a session whose owner id is not an id, and a blob whose
MIME type is no longer in the table. A database row is not a trust boundary.

## Keeping the registry in step with the filesystem

Two mechanisms, and both are needed.

**Writers register.** The file tools, `ila_diagram` (in the same transaction as its own two
rows), the upload route, the file manager, and the page-capture tool each leave a row for what
they wrote. `registerFileSource` is idempotent — a second write of the same file updates the row
it already has.

**Listings reconcile.** A read of a directory registers a row for every *file* it finds without
one, and hangs the id on the entry as `FileEntry.sourceId`. Two writers cannot do this
themselves: `delete_file` is deliberately a plain filesystem operation rather than an application
deletion, so it must not unregister; and a file can appear with no writer at all — dropped in
from the Finder, restored from a backup, cloned into the workspace.

Reconciliation is one query per listing (not one per entry), files only (a directory is not a
source, so a `node_modules` costs nothing), idempotent, and a no-op when every entry already has
a row. It lives in the route rather than in `files.ts`, which has no database and stays pure.

**Drift is computed, never stored.** A row whose file is gone is reported `missing` — from a
`stat`, on the listing — and is still returned. An entry hidden because a read would fail is
indistinguishable from one that was never there. Storing the flag would be worse than untidy: the
writer that creates the drift is the agent's `delete_file`, and a stored flag would force that
tool to clear it, which is a database write inside the one operation that is supposed not to be
one.

## The write location

The agent can write into two places, and which one a file belongs in is not something the model
can read off a request. So it is a setting with a chain:

```
this turn's own instruction  >  the session's setting  >  the workspace's default  >  "session"
```

`resolveWriteLocation` is the whole of it, and `createSession` merges the three stored levels in
that order — a Copilot's value arrives as the session's because the conversation copied it at
creation. Nothing reads a Copilot at turn time; that is the same rule that keeps an edited
Copilot from rewriting the conversations that came from it.

**The default is `session`.** A workspace's `workdir/` is shared by every conversation in the
workspace, so it is the right home only for material that *is* shared — a project, a codebase, a
corpus. Everything else a conversation produces is about that conversation, and a default that
puts it in the shared directory turns that directory into a junk drawer nobody organised and
nobody can safely clean.

The cost of that choice, stated rather than hidden: **the sidebar's file tab browses `workdir/`**,
so with this default most new files do not appear there — they appear under the conversation that
made them, which is what the browser's conversation filter is for, and why the browser is the
surface a conversation's own files are reached through.

### What the model is told

The system prompt names both absolute paths, says which one an unqualified write goes to, and
tells the model to:

- follow an explicit instruction from the user over that default;
- write a file beside the file the user referred to, when it belongs there;
- use `ask_user` when it cannot tell which folder a file belongs to.

That last one is guidance rather than machinery, on the `PLAN_GUIDANCE` pattern: `ask_user`
already suspends and already has the tool, and the tool cannot see which file the user was
pointing at.

### How the tools treat an omitted `location`

- **A write** uses the resolved default.
- **A read** tries the default and then the other root, and prefixes the result with which one it
  used. A model that cannot find a file it wrote last turn — because the default changed under
  the conversation — stops trusting the tools.
- **A delete** refuses when the path exists in both roots. It is the one operation whose mistake
  cannot be walked back, so an ambiguity is an error the model resolves by naming a folder.

## Keeping a page

`web_fetch` is a **pure read**: it hands the model a page's text and forgets it. That is right for
the dozens of pages a search-and-skim touches and wrong for the one a conversation then builds
on — so there is a second tool, and the split *is* the feature. The requirement asks for "only
the pages finally confirmed relevant to the conversation", and the only thing that can confirm
relevance is the model that read them, so it has to ask deliberately.

`ila_collect_page(url, summary)` keeps one: it fetches through `web_fetch`'s own SSRF guard (the
same exported function — a second implementation would be a second chance to get the guard
wrong), stores the HTML at `<user>/sources/web/<id>.html`, extracts the text into the one
`parsed/` tree, and writes a `page` source with the URL and the model's one-line summary.

Three properties are worth knowing:

- **A page's identity is its reading, not its bytes.** The hash is over the URL *and the
  extracted text*, so a page whose masthead changed since yesterday is the same source, while one
  whose article changed is a new one. Hashing the markup would make one article into a source per
  visit.
- **A turn's fetches are cached.** `web_fetch` records what it fetched and `ila_collect_page`
  reuses it, so keeping a page the model just read costs no second request. The cache is built by
  `buildTools` and lives exactly one turn.
- **The tool is on by default, so the prompt has to say when to use it.** `COLLECT_PAGE_GUIDANCE`
  (`tools/collectPage.ts`) is appended to the system prompt on any turn where the tool survived
  assembly — `routes.ts` asks the assembled array rather than the config, so a Copilot whose
  allow-list excludes it is never told about a call it cannot make. Without it the model sees only
  the tool's own description, which is phrased as a *restriction* and reads as "usually do not":
  the tool was built, wired and tested for a while before anyone noticed it never ran.

## Referencing with `@`

Typing `@` in the composer opens a picker over what this conversation can point at — the only
interactive part of referencing, and the part with the rules worth stating:

- **The `@` must not be glued to a word.** An address (`ada@example.com`) is not a mention, and a
  picker that appeared in the middle of one would make the feature feel broken. Punctuation is
  fine, so `(@report.pdf)` works.
- **A space closes it.** A mention's query is a word.
- **`utils/mention.ts` owns both rules**, as arithmetic on a string and a caret, because the
  questions ("is the caret inside a mention", "where does the name go") have one right answer each
  and are testable without a DOM.
- **Enter belongs to the picker while it is open**, including while it is still fetching. The
  composer's Enter *sends*, and the frame is drawn before the rows arrive — so a guard on "are
  there rows" would put a half-typed `@repo` into the conversation. `Tab` is the exception and is
  only taken when there is a row, because it cannot send anything.

Picking **a source** does two things, and they are separate on purpose. The **name** goes into the
sentence, so it reads naturally — and the **reference** becomes a chip beside the composer. The
`@` is how it is picked; the chip is what it means. A reference that is already a chip survives
the text being edited or deleted, which is why nothing downstream parses the message for
mentions.

Sending a turn with references:

- `ChatInput.sources` carries ids and the names the composer showed. Everything else is re-read
  server-side, the same split an attachment makes.
- The server **links** each one to the conversation (`session_sources`). That is what lets a
  later turn `read_document` it without the user pointing at it again — and it is the same link
  row an upload writes, so nothing new had to be invented.
- The snapshots are stored in **`messages.sources`**, a column of its own beside `attachments`,
  so a chip can say which material was uploaded for this turn and which was pointed at. To the
  *model* the two are identical, and the prompt builder concatenates them.
- An id belonging to another account resolves to nothing rather than being refused: the same
  "not yours and does not exist answer alike" rule the rest of the routes follow.

An unparsed document referenced this way is extracted first — the requirement is exact that a
model may only read a source that has been parsed, so pointing at one *makes* it readable rather
than handing the model a name.

### The picker is a selector, and a workspace is the other thing it picks

The list holds **two kinds of reference**, grouped with a divider and filtered by a tab strip —
`全部` | `工作区` | `资料` — because a bare `@` is how somebody browses, and being made to choose a
kind before seeing what exists is a question they cannot yet answer. Workspaces come first: they
are the coarser thing, and the sources below are refinements of them.

`资料` rows carry a second, horizontal filter of **type pills** — 图片 | 文本 | 代码 | 网页链接 |
其他文件. Those five are a deliberate **coarse grouping over the eight categories the registry
stores** (`文本` is text *and* markdown, `代码` is code *and* a diagram), mapped in one `Record` in
`utils/referencePicker.ts` so a new category is a compile error rather than a file no pill can
reach. The pills filter **client-side**, over the rows the server already returned, and that is a
correctness point rather than a shortcut: the picker fetches the account's whole match set and
caps *per group* in `buildOptions`, so filtering server-side would mean asking `/api/sources` for a
list of categories it does not take (its `category` is a single value) and capping before the
filter, which shows fewer matches than exist.

Selecting any pill **drops the workspace group**. A workspace has no source type, so a list still
showing workspaces after you asked for images reads as a filter that did not work. The pill row is
**hidden** on the 工作区 tab rather than disabled, for the same reason.

## Reading across workspaces

`@{指定工作区}` and `@所有工作区` **open a workspace to the conversation**. That is a different
kind of thing from referencing a file, and the difference is where it is stored: a source
reference travels with the turn and is linked to the conversation, while a workspace grant is a
**`SessionSettings.workspaceScope`** — because it has to persist, survive a reload, and be in force
for turns nobody typed an `@` in.

```ts
interface WorkspaceScope {
  all?: boolean;         // every workspace the account holds, including later ones
  workspaceIds?: string[];
}
```

`all` is a **flag, not a snapshot**: storing the ids it implied would answer "everything I have"
with "everything I had on Tuesday". The two halves are never both meaningful, so picking
`@所有工作区` drops `workspaceIds` rather than leaving a list nobody can see underneath.

`apps/server/src/workspaceScope.ts` is the **whole of the grant's authority**. It re-derives the
scope from the account's live workspaces on **every turn**, dropping anything the caller does not
own and any workspace deleted since, so a stored id is a request rather than an access — the same
posture `resolveSourceBytes` takes toward a database row. `resolveWorkspaceScope` is the only
reader of the setting; the write path checks shape alone and deliberately **not** ownership,
because a workspace can be deleted between the chip being drawn and the save landing.

`turnContext()` calls it once and is the only caller of `listReadableSources`. That placement is
load-bearing: three routes computing the whitelist would be three chances to forget, and a fourth
route that built its tools some other way would lose `read_document` entirely and fail loudly
rather than quietly under-granting.

What a grant opens, and each half is needed:

| | How | Why it needs its own mechanism |
| --- | --- | --- |
| the granted workspace's **uploads and kept pages** | the `workspace_sources` arm of `listReadableSources` | `read_document` reads `parsed/<id>.txt`, and only a linked source has been extracted |
| the material its **conversations** hold | a third arm on `session_sources` | `registerFileSource` writes a `sources` row and **no link row**, so a source a conversation inside it merely `@`-referenced lives in `session_sources` alone |
| its **files** | `ila_explore`'s `files`/`file` kinds | a workspace file is a path, and paths are not ids: `read_document` cannot address one |

`ila_explore` is assembled **only when the grant is non-empty**, the `read_document` rule — a tool
that could only refuse is a step the model wastes discovering that. Its `messages` kind strips
tool-call `output` and `reasoning` rather than clipping them, because both are unbounded and
neither is what a reader came for. And it does one thing the file tools deliberately do not: it
**`realpath`s every path**. `resolveInWorkspace` is lexical, justified by "the model has no tool
that makes a symlink, so one can only be there because the user put it there" — an argument about
the user's own machine, which does not survive a symlink in workspace B becoming a read path out
of a conversation in workspace A.

**Read-only, end to end.** No path in this feature writes, and the file tools keep their two roots,
their write rules and their "exists in both roots" delete refusal untouched.

One thing is deliberately **not** reachable: files the agent wrote into another conversation's
`sessions/<id>/`. `registerFileSource` writes no link row for them, so there is no index, and
reaching them would mean resolving arbitrary session directories. The material is nearly always a
diagram, which `ila_query kind:"diagram"` covers in its own conversation.

## Images

An image is the one kind of material a conversation can hold that leaves **no text behind**, so
without help a picture is readable exactly once — in the turn it arrived in — and afterwards it
is a name in a chip.

`agent/mediaSummary.ts` closes that: after a turn, `finishTurn` asks the model that just saw the
images to describe each one, and writes the description to both the `summary` column (what the
browser and the picker show) and `parsed/<id>.txt` (what `read_document` and the prompt builder
read). A summary in the column alone would be a file the model still could not read.

Three bounds on the cost, each deliberate:

- **Fire-and-forget**, like the auto-titler: a model call on the turn path is a turn that can fail
  for a reason the user did not cause, and `message_done` has already been sent.
- **Once per source**: `needsSummary` skips an image that already has one, so the second
  conversation to attach the same screenshot pays nothing.
- **Only when the model could see.** With no vision the attachment reached it as a placeholder, so
  a description would be a claim about a picture nothing looked at — and the request itself would
  be an `image_url` a non-vision endpoint rejects.

## The browser

`SourceBrowser.vue` is one component with two front doors: the workspace home's rail opens it
over the whole account, and a conversation opens it pre-filtered to its workspace. The caller says which
with two props — `initial` (the filter set) and `hidden` (the option groups that front door has no
business offering, e.g. a workspace picker inside that workspace). Data rather than a mode flag: a
`mode` would have to enumerate the combinations, and a third front door would be a third mode.

Filtering is the **server's**, including the scope filters, because a workspace with a
`node_modules` has tens of thousands of rows. The one thing the server cannot answer is *which
options exist* — the MIME types present, the categories in use — so a second, scope-only query
fills the option lists. It is re-issued when the scope changes and never when a filter does:
narrowing the list must not delete the option you narrowed by.

**One door, and a tab per kind.** The footer holds a single 添加资料 button, and the dialog it
opens (`AddSourceDialog.vue`) asks *what kind* before it asks anything else — a 文件 tab and a
网页链接 tab. Two toolbar buttons said the same thing twice: the operation is "put material in"
and the kind is one field of it, which is how the pair had already drifted (only one of them
offered a folder, and neither said where the result would land).

The tabs share **where it goes** — the workspace, plus the directory for a file — and nothing
else, which is why they are tabs of one dialog rather than two. A **conversation is never
offered**: a conversation's own folder is written by the agent and by uploads made inside it, so a
picker here would place a file somewhere no conversation created it. The file tab takes several
files and lists them as picked rows, each removable, and submits **one request per file** so a
partial failure names the file it failed on. The link tab's URL is fetched server-side through
`web_fetch`'s own guard, so a URL resolving to a private address is refused with the guard's
sentence, and the page carries **no summary** — a summary is a reading of a page by something that
understood it, and nothing has read this one yet.

**The panel is the same registry, narrowed to one conversation.** `SourcesWidget.vue` reads
`GET /api/sources?sessionId=…` — held by the conversation or linked into it — and is deliberately
*not* built on `/api/sessions/:id/sources`, which is the session ∪ workspace union and is the
model's readable whitelist rather than a description of what the conversation is working from. It
filters by category client-side, because one conversation's list is small enough that the option
list can come from the rows already fetched, and because that keeps the bounded
`reconcileFilesystem` walk off a control the user may press repeatedly. It is a viewer: no
folders, no rename, no delete. See `docs/widgets.md`.

The tree view groups by workspace, then by the conversation that holds a row, then by its path.
That shape is not decoration: two conversations may each hold `notes/a.md`, and a tree that
grouped by path alone would show one line for two different files. `utils/sourceTree.ts` holds the
grouping and the flattening.

Two properties of the dialog are load-bearing rather than cosmetic. The controls are **one strip**,
each a bordered control that names itself in its first option ("all workspaces") with the
screen-reader name in `aria-label` — an earlier version put a lead sentence, a disclosure row and a
grid of labelled fields above the rows, and left the list it is a toolbar *for* a couple of rows
high. And the two loads are **sequence-guarded**: opening the dialog starts one and clicking a
filter starts another a moment later, and responses do not arrive in the order they were sent — so
without the guard the loser overwrote the winner and the list settled on the unfiltered answer
while the controls said otherwise. `filePreviewSeq` in the store is the same shape for the same
reason.

## The registry is not an access-control list

`sources` is a **catalog**: what material exists. It is not what the model may read.

`read_document`'s whitelist is `session_sources ∪ workspace_sources` — the uploads and pages
linked to the conversation and its workspace — **plus, when the user has opened other workspaces
with `@`, those workspaces' `workspace_sources` and their conversations' `session_sources`**. See
"Reading across workspaces" above for why that second half is two arms rather than one.

The rule the paragraph used to state as an absolute still holds where it matters, and the
qualification is exact: **files inside a sandbox are still not folded in**, because they are
already readable *by path* through the file tools, and a workspace with a `node_modules` would
otherwise put thousands of rows into the whitelist as named sources. A granted workspace's *files*
are reached the same way — by path, through `ila_explore` — for the same reason.

So a link is still created when a user actually references something, and not for every file that
happens to exist. What changed is that a user can now reference a **workspace**, which is a
standing grant rather than a link, and that is why it is a setting with a resolver rather than a
row in a join table.

## Reconciliation runs before a listing, not at boot

The registry is an **index of the filesystem**, and an index needs a refresh policy. Two
mechanisms, and they answer different questions:

- `reconcileListing` registers what a *directory listing* finds. It runs in the file-browser
  routes, and it is what makes "every file is a source" true for the files the tree shows.
- `reconcileFilesystem` walks the scopes a **source listing** is about, bounded by depth and by a
  file cap. It runs at the top of `GET /api/sources`, because reconciliation-by-listing is not
  enough: the browser lists *rows*, not directories, so a file that appeared with no writer at all
  — cloned into a workspace, restored from a backup, dropped in from the Finder — stayed invisible
  until somebody happened to open the file tree on that exact folder. A boot-time scan answers
  "what was there when the server started", which is a different question from the one the reader
  is asking, and the difference is exactly the file they just put there.

The walk is capped, so the worst case is a few thousand `stat`s on a dialog somebody opened
deliberately; whatever the cap leaves out is still reachable, because the file tree registers a
directory the moment it is listed. It is idempotent — `registerFileSource` upserts on the place —
which is what lets it be a plain call rather than a cache with an invalidation policy.

## Related

- `docs/diagrams.md` — a diagram is a file, a `session_diagrams` row **and** a source row.
- `docs/file-preview.md` — how a source becomes a preview, and the one dialog all three come
  through.
- `docs/architecture.md` — where this sits in the request path.
