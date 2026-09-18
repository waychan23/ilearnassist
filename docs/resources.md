# Resources

One record for every piece of material an account holds: an uploaded file, a page the agent
fetched, a file the agent wrote into a workspace, a file it wrote into a conversation's own
folder. The point of one record is one **id space** — a message can reference any of them, a
browser can list them together, and "where did this come from" is a column rather than a guess.

That is the point it always had, and it now takes **two tables to keep**. A `files` (or
`web_pages`) row *is* the material: bytes on disk or a page at a URL, owned by the **account**. A
`work_resources` row is one workspace's or one conversation's **reference** to it. The v3
`sources` table was both at once, and that is exactly the thing that broke: a source row had one
owner and resolved its own bytes *through* that owner, so one file worked from by two
conversations was unrepresentable. Here the locator is a single `files.path`, and a reference may
be one of several. Nothing on disk moved.

The id space is now the reference's. The library browses references, `@` picks references,
`read_document` takes a reference's id, `ila_query(kind: "resource")` lists them, and a message's
chip names one. A file is what the bytes are, and is reached through a reference — which is also
why a file may have **no** reference at all, and some deliberately do.

This file is the reference for three things that are easy to get wrong: the four questions a piece
of material answers and which table answers each, the rules that keep the registry in step with the
filesystem, and the write location — which is the part a user can change and therefore the part that
has to be explained rather than assumed.

## The four questions

A v3 source row answered four questions in four columns, and answering them was the row's job
because *where the file was* no longer did. They are still the right four questions; what changed
is that answering them honestly takes two tables, because "who holds it" is not a fact about a
file.

| question | v4 answer | values |
| --- | --- | --- |
| Who holds it? | `work_resources.owner_type` + `owner_id` | a `workspace` or a `session` |
| How did it come to exist? | `files.source_type`, or `web_pages.source_type` | `attachment`, `upload`, `agent_create`, `discovered` — or `upload`, `agent_fetch` for a page |
| Where are the bytes? | `files.path` | one locator, relative to the user root |
| What is it? | `files.category`, or `resource_type = 'web_page'` | `text`, `markdown`, `code`, `diagram`, `image`, `document`, `other` |

`source_type` is fixed for the life of a row, and it is the entity's rather than the reference's.
A file the agent wrote into a workspace, moved to the trash by the user, is still `agent_create`:
the move is a `path` update and the delete is soft, and neither is a claim about where the file
came from.

`discovered` is the one nothing claims: a file found in a sandbox with no row to account for it.
Its own value rather than a guess, because `agent_create` means "the assistant wrote this" and
the browser prints it as such. It is also the one `source_type` a *reconciler* ever writes.

The parse state — `parse_status`, `parsed_file_id`, `parse_error`, `parsed_chars`, `page_count` —
is on the **reference**, not the entity. That is what keeps an entity from needing parse columns it
would have to share, and it is what makes the same file referenced twice parsed twice — a
consequence the identity rules below state in full.

## Identity: three rules, not one

```sql
CREATE UNIQUE INDEX idx_files_path ON files(user_id, path) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_files_blob ON files(user_id, sha256)
  WHERE sha256 IS NOT NULL AND source_type IN ('upload', 'attachment');
CREATE UNIQUE INDEX idx_wr_place
  ON work_resources(user_id, owner_type, owner_id, resource_type, resource_id)
  WHERE deleted_at IS NULL;
```

- **Identical uploaded bytes are one file.** That is the dedupe the schema is built on, and it is
  why re-uploading a file the user deleted *revives* that row rather than inserting beside it —
  the bytes, the parse state and every reference were never dismantled, so the file comes back
  everywhere it was used. `idx_files_blob` is deliberately **not** filtered by `deleted_at`;
  filtering it would break `findDeletedFileByHash` and the revive with it.
- **A file is placed by its path.** So a rename is an `UPDATE` of `path` on the same row, which
  keeps the id — and with it every reference pointing at the file, its summary and its parse
  state. Two identical files in two directories are two files: a file's identity is not its
  content.
- **A reference is placed by owner and entity.** So re-referencing is idempotent, one owner cannot
  hold the same entity twice, and `ensureWorkResource` can be an upsert rather than a
  check-then-insert. It is also what the library's delete acts on: removing a reference takes it
  out of *one* owner's list and leaves the file, and every other owner's reference, alone.

**The library's delete is two deletes, and the dialog says which one a press is.** A
**session-owned reference** — an upload, a page — goes through `DELETE /api/resources/:id`, which
is the rule above: this account's hold goes, the bytes and every other owner's reference stay. A
**file inside a workspace** cannot work that way, because its reference *is* the workspace's own
tree file: taking only the reference would leave the bytes where the next listing reconciles them
straight back, which is a delete that visibly does nothing. So it goes through the file manager's
route instead — the bytes move to that workspace's trash and the shared `files` row goes, taking
**every** conversation's reference with it. The route therefore retires those references
explicitly rather than leaving them to be hidden by the entity join, and the listing carries each
row's `referenceCount` so the dialog can name how many other holders are about to lose it. The
copy used to describe the first case while the second case ran, promising that other
conversations were unaffected.

**The `source_type` clause on the blob index is not decoration.** Parse results are files too, and
two different documents whose extracted text comes out byte-identical — two empty scans, the same
page rendered twice — would otherwise collide there: a parse dying on a `UNIQUE` violation, with
nothing in the error to say the two rows were never the same thing. The dedupe rule is about bytes
a *person* supplied, so the index says exactly that.

A file with no `sha256` is a file nobody uploaded, which is why the placement and blob indexes can
never contend.

**And the consequence of moving the parse onto the reference, stated rather than hidden: the same
file referenced by two owners is parsed twice.** v3 parsed it once and showed the reparse to both.
The requirement asks for parse state per reference; the bill arrives as duplicate extraction work,
not as a stale status.

## Where the bytes live, and why nothing absolute is stored

```
<dataRoot>/users/<slug>/
  workspaces/<wsSlug>/
    workdir/<path>                  workspaces/<wsSlug>/workdir/<path>
    sessions/<sessionId>/<path>     workspaces/<wsSlug>/sessions/<sessionId>/<path>
    trash/<fileId>/<path>           workspaces/<wsSlug>/trash/<fileId>/<path>
  sources/
    raw/<fileId>.<ext>              sources/raw/<fileId>.<ext>
    web/<fileId>.<ext>              sources/web/<fileId>.<ext>
    parsed/<fileId>.txt             sources/parsed/<fileId>.txt
```

The left column is the directory the bytes are in; the right column is the **stored** form, the
one `files.path` holds, relative to the account's own root.

The bytes stay where they are. Copying an agent-written file into `sources/` would mean two
copies of the same bytes — the one drift `session_diagrams` cannot represent — or a workdir of
symlinks, which would force the file browser to weaken the `realpath` check it exists to have.

`parsed/` is one tree for every storage, so `read_document` and the prompt builder need one
lookup and no branch per origin. The workspace segment of a path is the **slug**, never
`dir_path`: a slug is unique per account and a rename is display-only, so a stored path stays
valid for the life of the row.

**No path is stored absolutely — the reason is unchanged, and the mechanism has inverted.** v3
stored `storage` + `rel_path` and resolved the root by looking up the row's *owner*; that is
unanswerable once one file has two owners, so the whole locator is now a single stored field,
`files.path`, `/`-separated so a database written on one platform reads on another. What has not
changed is why it is relative: an absolute path is the one stored fact that silently breaks when a
data root is copied or moved, and a copied data root has to still resolve.

Blob names are still `<id>.<ext>` from the MIME table, and they are now **written into the row**
rather than recomputed on read — because the bytes are where they are, and the MIME type of a row
can be corrected later. `resourcePaths.ts`'s helpers (`rawFilePath`, `webFilePath`,
`parsedFilePath`) are therefore write-time only; a reader uses `resolveFilePath`, and
`attachments.ts` keeps no derive-it-if-absent fallback, because a second way to compute a path
could only disagree with the stored one.

Every read re-validates: `resolveFilePath` refuses a `path` that climbs out of the user root, an
absolute one, and an **empty** one — an empty string resolves to the root itself, and a live row
naming a directory is not a file. A database row is not a trust boundary.

## Keeping the registry in step with the filesystem

Three mechanisms now, and the split between the first two is the v4 model in miniature.

**Writers register bytes.** `registerFile` records that bytes exist at a path. The file tools,
`ila_diagram`, the upload route, the file manager and the page-capture tool each call it for what
they wrote. It is idempotent — a second write of the same file updates the row it already has, so
the row keeps its **id**, and with it every reference pointing at it and the summary somebody wrote
about it. It creates **no** reference.

**Writers that mean to make something referenceable say so.** `ensureWorkResource` is that second
write, and it is a separate call on purpose: a file may legitimately have **no** reference at all.
A diagram's `.mmd` and a document's extracted text are exactly that — real files, registered,
addressable by path, and deliberately not something the library lists. That is not a workaround
for a missing feature; it is the one real use of the split, and it is why the two writes could not
be folded into one.

**Listings reconcile.** A read of a directory registers a row for every *file* it finds without
one, and hangs the id on the entry as `FileEntry.fileId`. Two writers cannot do this themselves:
`delete_file` is deliberately a plain filesystem operation rather than an application deletion, so
it must not unregister; and a file can appear with no writer at all — dropped in from the Finder,
restored from a backup, cloned into the workspace.

**The rule that ties the three together, and the one to remember: reconciliation adds a reference
only for a file it itself *discovered*.** A file that already has a row was registered by a writer
that knew what it was doing, and that writer's decision about whether the file is externally
referenceable is not the reconciler's to overrule. Without the rule, a `.mmd` nobody drew would
appear in the library the moment somebody walked the directory it is in.

Reconciliation is one query per listing (not one per entry), files only (a directory is not a file,
so a `node_modules` costs nothing), idempotent, and a no-op when every entry already has a row. It
lives in the route rather than in `files.ts`, which has no database and stays pure.

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
`parsed/` tree, and writes a `web_pages` row with the URL and the model's one-line summary.

A page is **its own entity** rather than a `files` row, because what identifies it is not a path:
a page is *the reading of a URL*. The bytes — the raw HTML and the extracted text — are `files`
rows, registered and **not** referenced, which is the file/reference split being the ordinary case
rather than a special one. The uniform part is that a reference points at a parse result either
way: a `work_resources` row's `parsed_file_id` names a `files` row whether its entity is a file or
a page.

**One reference, held by whoever asked.** A page kept by a turn is the conversation's; a link the
user pasted into the library is the workspace's. It used to write the workspace's as well, so that
a page kept in one conversation would be readable from another — and that was a second row the
library showed twice for one page, because readability never depended on it: the third arm of
`listReadableWorkResources` already admits any reference owned by a *sibling* conversation in the
same workspace. Sharing a page further is `@`-pointing at it in the next conversation, which is
what shares every other piece of material.

Three properties are worth knowing:

- **A page's identity is its reading, not its bytes.** The hash is over the URL *and the
  extracted text* (`idx_pages_hash`), so a page whose masthead changed since yesterday is the same
  entity, while one whose article changed is a new one. Hashing the markup would make one article
  into a page per visit. Keeping a page again is a no-op for the bytes: the row is refreshed and
  the files are left where they are.
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

Picking **a resource** does two things, and they are separate on purpose. The **name** goes into
the sentence, so it reads naturally — and the **reference** becomes a chip beside the composer.
The `@` is how it is picked; the chip is what it means. A reference that is already a chip
survives the text being edited or deleted, which is why nothing downstream parses the message for
mentions.

A `@`-reference is a **`TurnReference`** — the same mechanism 追问 uses, with `kind: "resource"`
and the **reference id**. That it is the reference's id rather than the file's is the model in
one line: what the user pointed at is one owner's use of the material, and the parse state the
model will read is that reference's.

Sending a turn with references:

- `ChatInput.refs` carries the references and the names the composer showed. Everything else is
  re-read server-side, the same split an attachment makes.
- `/chat` **links** each resolved reference: it gains a reference of this conversation's own,
  pointing at the same entity, and that row is what puts it in the read whitelist from here on.
  This is a *write* in a request that reads a lot, and it is deliberate — `resolveReferences`
  stays read-only because replay resolves references on every later turn, and a replay that wrote
  would resurrect rows a user had deleted.
- **A reference that has never been parsed is made readable there — and a page is *adopted*
  rather than scheduled.** Without this the model would read "still parsing" for ever, and the
  failure lands in the worst place: the feature looks right in the UI and only `read_document`
  fails. For a file that is the parse pipeline. For a **page** it cannot be: a page arrives
  already extracted, and `documents.schedule` skips it (`text/html` is not a document MIME, and
  the service early-returns before writing anything). So `adoptPageParse` copies the
  `parsed_file_id` a **sibling reference** already points at. This matters more than it looks:
  a page's text is reachable only through a reference — `web_pages` names neither the stored body
  nor the extracted text — so a second reference to the same page, which is exactly what pointing
  at it with `@` creates, is born with no pointer and nothing that would ever write one.
- The snapshots are stored in **`messages.refs`**, a column of its own, so a chip keeps the label
  and the quote it was shown with even after the file is renamed or unlinked. What the *model*
  reads is re-derived from those on every run, by `referencesForHistory`.
- An id belonging to another account resolves to nothing rather than being refused: the same
  "not yours and does not exist answer alike" rule the rest of the routes follow.

### The picker is a selector, and a workspace is the other thing it picks

The list holds **two kinds of reference**, grouped with a divider and filtered by a tab strip —
`全部` | `工作区` | `资料` — because a bare `@` is how somebody browses, and being made to choose a
kind before seeing what exists is a question they cannot yet answer. Workspaces come first: they
are the coarser thing, and the resources below are refinements of them.

`资料` rows carry a second, horizontal filter of **type pills** — 图片 | 文本 | 代码 | 其他文件.
Those four are a deliberate **coarse grouping over the seven categories the registry stores**
(`文本` is text *and* markdown, `代码` is code *and* a diagram), mapped in one `Record` in
`utils/resourcePicker.ts` so a new category is a compile error rather than a file no pill can
reach. **There used to be a fifth, `网页链接`, and it went with the v4 split rather than by taste**:
a page is a `resourceType`, not a `FileCategory` — v3 had to hand-set `category: "page"` because a
page's name cannot say what it is — so "web pages" is no longer a *content type* this list can
filter by, and re-adding it means a pill that filters on `resourceType`, a control the picker does
not have. A page has no category at all, so turning on any pill excludes it. The pills filter
**client-side**, over the rows the server already returned, and that is a correctness point rather
than a shortcut: the picker fetches the account's whole match set and windows it in
`buildOptions`, so filtering server-side would mean asking `/api/resources` for a list of categories
it does not take (its `category` is a single value) and capping before the filter, which shows fewer
matches than exist.

**The list is one window, and a pager grows it.** `LIST_PAGE` (100) rows are drawn at a time, and
the control under the list adds another 100 until nothing is left — after which it is not drawn.
It replaced an 8-per-group / 12-total pair that kept a menu from being a wall, which it is not
(the list scrolls) and which capped what a reader could reach at a dozen rows with no way to ask
for the rest. One window over the whole list rather than a cap per group, because "还有 N 项" is
only a useful sentence if N is how many more a press will produce: under a shared window a
per-group count would promise a group's rows that the next page spends on an earlier group.
Nothing is fetched to page — the match set is already in hand — so the window is display
arithmetic, and it resets with the query and the filters, because a different list is a different
set of rows.

Selecting any pill **drops the workspace group**. A workspace is not a file and has no category, so
a list still showing workspaces after you asked for images reads as a filter that did not work. The
pill row is **hidden** on the 工作区 tab rather than disabled, for the same reason.

## Reading across workspaces

`@{指定工作区}` and `@所有工作区` **open a workspace to the conversation**. That is a different
kind of thing from referencing a file, and the difference is where it is stored: a resource
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
posture `resolveFilePath` takes toward a database row. `resolveWorkspaceScope` is the only
reader of the setting; the write path checks shape alone and deliberately **not** ownership,
because a workspace can be deleted between the chip being drawn and the save landing.

`turnContext()` calls it once and is the only caller of `db.listReadableWorkResources`. That
placement is load-bearing: three routes computing the whitelist would be three chances to forget,
and a fourth route that built its tools some other way would lose `read_document` entirely and
fail loudly rather than quietly under-granting.

### The whitelist is three arms over one table

`listReadableWorkResources` is the read whitelist, and it is worth reading the arms in order
because they are **ranked**:

| | what it covers |
| --- | --- |
| arm 1 | this conversation's own references |
| arm 2 | the current workspace's own references, plus any granted workspace's — **both live** |
| arm 3 | what those workspaces' *conversations* hold — the current one as well as the granted ones |

**Both arms check that the owning workspace is live, and arm 2 only needs to under `all`.** A
named grant is live by construction — `resolveWorkspaceScope` re-derives the ids from the account's
workspaces every turn — but `all` is a *flag*, and arm 2's disjunction short-circuits on it, so
"every workspace" admitted one that had been deleted. Deletion is soft and dismantles nothing, so
the material stayed readable by `read_document`, `ila_query kind "resource"` and the chips route,
with nothing on screen naming the workspace it came from. v3's own arm 2 joined `workspaces` and
checked `deleted_at`; the v4 rewrite reads `work_resources` directly and the predicate went with
the join.

**Arm 3 is the v4 replacement for a mechanism v3 had in the *writer*.** An upload used to write a
`session_sources` row *and* a `workspace_sources` row, and the second is what made a document
uploaded in one conversation readable from a sibling. Here the reference is one row owned by the
conversation, so the *reader* is what widens — and because there is one row rather than two, the
library also lists an upload once.

**The arms are ranked by an exclusion, and it is the *entity* they must not repeat.** Several
references can point at one file — a conversation's own upload and the reference a sibling holds
to the same bytes are two rows — so "what may the model read" has to answer once per file or the
same document reaches the prompt twice. Arm 1 wins, then the workspace's, then a sibling's, and
each arm skips an entity a nearer arm already answered for. Arm 3 also excludes `@sessionId`
outright: arm 1 is that arm. v3 got the same answer out of a `UNION ALL` under `MIN(linked_at)`
and a `GROUP BY`; this is the same ranking as an exclusion, needing no aggregate.

Without arm 3's conversations-of-a-granted-workspace clause, `ila_explore`'s `messages` would name
ids that resolve to nothing, which reads as a broken tool.

**`ResolvedScope.workspaces` excludes the conversation's own workspace, and `ila_explore`'s listing
kinds must not read it as "everything".** It is excluded here on purpose: every other reader already
has it — `read_document`'s whitelist unions it in and the file tools are sandboxed inside it — so
the grant is only ever about the *other* ones. But an account with one workspace therefore resolves
`@所有工作区` to `{ all: true, workspaces: [] }`, and a search that took its default set off that
list searched nothing while reporting *"Messages in 0 opened workspaces"*. The listing kinds
(`sessions`, `message_search`, and `messages`' grant check) use a set of their own — `across()`,
which under `all` is the account's own workspaces — because what the person who chose `all` means is
"my conversations", and the one they are reading is one of them.

What a grant opens, and each half is needed:

| | How | Why it needs its own mechanism |
| --- | --- | --- |
| the granted workspaces' **references** | arms 2 and 3 of `listReadableWorkResources` | `read_document` is addressed by a reference id, and that row is where the parse state — the readable text — lives |
| the material their **conversations** hold | arm 3 | a conversation's own reference is owned by the conversation, so a reader scoped to the workspace alone would not see it |
| their **files** | `ila_explore`'s `files`/`file` kinds | a workspace file no reference was ever made for is a *path*, and a path is not a reference id: `read_document` cannot address one |
| the **text** of what was said there | `ila_explore`'s `message_search` kind | messages are not material at all — no reference names one, and `messages` needs a conversation id the caller does not have until a search has told it |

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

One thing is deliberately **not** reachable: a file the agent wrote into another conversation's
`sessions/<id>/` **with no reference of its own**. A file the owner conversation holds is arm 3's,
and reachable; a bare `.mmd` nobody drew has no reference anywhere, so there is no index entry to
find it by and reaching it would mean resolving arbitrary session directories. The material is
nearly always a diagram, which `ila_query kind:"diagram"` covers in its own conversation.

## Images

An image is the one kind of material a conversation can hold that leaves **no text behind**, so
without help a picture is readable exactly once — in the turn it arrived in — and afterwards it
is a name in a chip.

`agent/mediaSummary.ts` closes that: after a turn, `finishTurn` asks the model that just saw the
images to describe each one, and writes the description to both the **file's** `summary` column
(what the library and the picker show) and an extracted-text file under `parsed/`. Both halves are
needed: a summary in the column alone would be a picture the model still could not read.

Three bounds on the cost, each deliberate:

- **Fire-and-forget**, like the auto-titler: a model call on the turn path is a turn that can fail
  for a reason the user did not cause, and `message_done` has already been sent.
- **Once per image**: `needsSummary` skips an image that already has one, so the second
  conversation to attach the same screenshot pays nothing.
- **Only when the model could see.** With no vision the attachment reached it as a placeholder, so
  a description would be a claim about a picture nothing looked at — and the request itself would
  be an `image_url` a non-vision endpoint rejects.

## The browser

`LibraryBrowser.vue` is one component with two front doors: the workspace home's rail opens it
over the whole account, and a conversation opens it *on* its workspace. The caller says which with
one prop — `initial`, the filter set to open with — and every control is drawn from either door.

The workspace picker used to be the exception: a second prop (`hidden`) took option groups away,
and a dialog opened from inside a workspace, for that workspace, "had no business offering" a
scope it would not honour. That is the wrong trade. The conversation's door is a *shortcut* to its
own workspace, not a claim that the rest do not exist — the account's uploads live outside every
workspace, and another workspace's material was reachable only by closing the dialog and leaving
the conversation. So the scope a door passes is the list's **default**; `hidden` is gone, and with
it `hasScope`, which the template had already stopped asking.

Filtering is the **server's**, including the scope filters, because a workspace with a
`node_modules` has tens of thousands of rows. The one thing the server cannot answer is *which
options exist* — the MIME types present, the categories in use — so a second, scope-only query
fills the option lists. It is re-issued when the scope changes and never when a filter does:
narrowing the list must not delete the option you narrowed by.

**One door, and a tab per kind.** The footer holds a single 添加资料 button, and the dialog it
opens (`AddResourceDialog.vue`) asks *what kind* before it asks anything else — a 文件 tab and a
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

**The panel is the same registry, narrowed to one conversation.** `ResourcesWidget.vue` reads
`GET /api/resources?sessionId=…` — the references this conversation holds — and is deliberately
*not* built on `GET /api/sessions/:id/resources`, which is the three-arm whitelist verbatim and
answers "what may be read". A panel on that route would list the whole granted corpus beside the
three files the conversation is working from. It filters by category client-side, because one
conversation's list is small enough that the option list can come from the rows already fetched,
and because that keeps the bounded `reconcileFilesystem` walk, which runs at the top of every
`GET /api/resources`, off a control the user may press repeatedly. It is a viewer: no folders, no
rename, no delete. See `docs/widgets.md`.

The tree view groups by workspace, then by the conversation that holds a reference, then by its
path. That shape is not decoration: two conversations may each hold `notes/a.md`, and a tree that
grouped by path alone would show one line for two different files. `utils/resourceTree.ts` holds
the grouping and the flattening.

Two properties of the dialog are load-bearing rather than cosmetic. The controls are **one strip**,
each a bordered control that names itself in its first option ("all workspaces") with the
screen-reader name in `aria-label` — an earlier version put a lead sentence, a disclosure row and a
grid of labelled fields above the rows, and left the list it is a toolbar *for* a couple of rows
high. And the two loads are **sequence-guarded**: opening the dialog starts one and clicking a
filter starts another a moment later, and responses do not arrive in the order they were sent — so
without the guard the loser overwrote the winner and the list settled on the unfiltered answer
while the controls said otherwise. `filePreviewSeq` in the store is the same shape for the same
reason.

### Following a page back to where it came from

A `web_page` reference carries the URL it was fetched from, and three surfaces offer to open it in
a browser: the browser's own rows, the resources panel's rows, and the **preview dialog's
header** — because the preview shows the app's *stored copy* of the reading, so a reader who wants
the page itself is standing in exactly that dialog. It is its own verb (`sources.openInBrowser`)
rather than a second reading of 预览: the two go to different places, one of which is somebody
else's website. The dialog learns where the page came from through `FileContent.url`, which
`GET /api/resources/:id/preview` attaches from the row — the route is the only place that holds
both the bytes and the entity, so the alternative was a second request for a field already in
hand.

`utils/externalLink.ts` owns the whole of it, so the three surfaces cannot drift into asking
different questions before leaving for the same kind of destination:

- **It confirms first**, naming the host rather than only asking "are you sure" — the decision is
  about *where* you are going, and a reader who cannot see the destination is being asked to trust
  the row they clicked.
- **The scheme is checked** (`http`/`https` only). Not a second SSRF guard: `web_fetch`'s is the one
  that decides what becomes a page, and the browser making this request from the user's own machine
  is the whole difference from the tool. It is checked because the URL is written once and
  rendered into a click later, and a `javascript:` or `data:` value reaching `window.open` runs in
  *this* app's origin — a stored-XSS shape rather than a fetch shape. One predicate at the point of
  use is what keeps a future writer of that column from being the thing that decides.
- **`noopener,noreferrer`**, since the destination is untrusted and a handle back into the app is
  not something to hand out. `window.open` is called in the continuation of the confirm dialog's
  own accept click, which is a fresh gesture, so it is not popup-blocked.

The control renders only where there is somewhere to go, so the three surfaces gate on the same
predicate — an absent `url` is every non-page reference, and a disabled button would be a control
that cannot do anything.

## The registry is not an access-control list

`files`, `web_pages` and `work_resources` are a **catalog**: what material exists and who is
working from it. None of them is what the model may read.

`read_document`'s whitelist is `listReadableWorkResources` — the three arms above, resolved per
turn. The rule the v3 file stated as an absolute still holds where it matters, and the
qualification is exact: **files inside a sandbox are still not folded in**, because they are
already readable *by path* through the file tools, and a workspace with a `node_modules` would
otherwise put thousands of rows into the whitelist. A granted workspace's *files* are reached the
same way — by path, through `ila_explore` — for the same reason.

So a reference is still created when a user actually references something, and not for every file
that happens to exist. What changed is that a user can now reference a **workspace**, which is a
standing grant rather than a link, and that a reference is now the *only* index — which is why the
reconciler's "discovered only" rule is what keeps a `.mmd` out of it.

## Reconciliation runs before a listing, not at boot

The registry is an **index of the filesystem**, and an index needs a refresh policy. Two
mechanisms, and they answer different questions:

- `reconcileListing` registers what a *directory listing* finds. It runs in the file-browser
  routes, and it is what makes "every file has a row" true for the files the tree shows.
- `reconcileFilesystem` walks the scopes a **resource listing** is about, bounded by depth and by a
  file cap. It runs at the top of `GET /api/resources`, because reconciliation-by-listing is not
  enough: the browser lists *rows*, not directories, so a file that appeared with no writer at all
  — cloned into a workspace, restored from a backup, dropped in from the Finder — stayed invisible
  until somebody happened to open the file tree on that exact folder. A boot-time scan answers
  "what was there when the server started", which is a different question from the one the reader
  is asking, and the difference is exactly the file they just put there.

Both register **two rows** for a file they find for the first time — the `files` row and a
`work_resources` reference, which is what makes a dropped-in file usable at all — and **neither
touches a file that already has a row**, because its writer already decided whether it is
externally referenceable. A reconcile therefore passes no title, and `updateFilePath` `COALESCE`s
one, so a walk can never reset a name its owner chose. A symlink is skipped rather than followed:
`files.ts` realpath-checks a read for a reason, and a walk that followed one could leave the sandbox
entirely.

The walk is capped, so the worst case is a few thousand `stat`s on a dialog somebody opened
deliberately; whatever the cap leaves out is still reachable, because the file tree's own listing
registers a directory's files the moment it is opened. It is idempotent — the unique index on
`(owner, entity)` is what makes it so — which is what lets it be a plain call rather than a cache
with an invalidation policy.

## What the library deliberately does not show

The rule that used to be stated as "every file the app holds is a source row" has narrowed to
something more useful: **a row in the library is a reference**, and four things have none.

- **A table** (the 图表 panel's other half) is a `session_tables` row and nothing else. Its display
  is the assistant's reply rather than a file: there are no bytes for a `path` to point at. Writing
  a `.md` in `sessions/<id>/` instead would put two full copies of one artifact on disk, which is
  the drift `docs/diagrams.md` names as the one the architecture cannot represent. So a table is
  invisible to the library, `@`-reference and `read_document`, deliberately — and
  `docs/tables.md` says what replaces each.
- **A diagram** is a `.mmd` file plus a `session_diagrams` row, and the drawing is read in the
  图表 panel rather than in a list of material. It is the clearest case of a real file that is
  deliberately absent from the library, and it is why the two writes are separate: the file is
  registered, the reference is never made.
- **A note** is a `notes` row, and it is the user's own writing attached to a message or a figure
  rather than material they work from. It reaches the model through `ila_query(kind: "note")`, on
  purpose: a reference would put the learner's own annotations into the same list as their study
  material, and a bound tool would make them invisible in every conversation that had not installed
  the panel.
- **Any file with no reference.** This is the category the split created, and it is the general
  case behind the three above. A diagram's `.mmd` and a parse result (`sources/parsed/<id>.txt`,
  reached through the reference that owns it) are both real and both registered — one is addressed
  by path, the other by id — and neither is something a user works from directly, so both would be
  noise in a list of the material a conversation is about. A `.mmd` nobody drew is the same case
  reached from the other side: a file, a row, and no reference anywhere.

## Related

- `docs/diagrams.md` — a diagram is a file, a `session_diagrams` row and a `file_id`; its `.mmd`
  gets no reference.
- `docs/tables.md` — a table is a `session_tables` row, with no file and therefore no reference.
- `docs/file-preview.md` — how a file becomes a preview, and the one dialog all three come
  through.
- `docs/architecture.md` — where this sits in the request path.
