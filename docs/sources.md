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
| How did it come to exist? | `origin` | `session_attachment`, `workspace_upload`, `agent_workspace`, `agent_session`, `web`, `discovered` |
| Where are the bytes? | `storage` (+ `rel_path`) | `upload`, `web`, `workspace`, `session`, `trash` |
| What is it? | `category` | `page`, `text`, `markdown`, `code`, `diagram`, `image`, `document`, `other` |

`origin` is fixed for the life of a row; `storage` is the one that changes. They are two
columns rather than one because "how did this come to exist" and "where is it now" are different
questions — a file the agent wrote into a workspace, moved to the trash by the user, is still
`agent_workspace` and is now `trash`.

`discovered` is the origin nothing claims: a file found in a sandbox with no row to account for
it. Its own value rather than a guess between the two `agent_*` ones, because those mean "the
assistant wrote this" and the browser prints them as such.

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
made them. That is what the conversation-files dialog and the source browser are for.

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

Two properties are worth knowing:

- **A page's identity is its reading, not its bytes.** The hash is over the URL *and the
  extracted text*, so a page whose masthead changed since yesterday is the same source, while one
  whose article changed is a new one. Hashing the markup would make one article into a source per
  visit.
- **A turn's fetches are cached.** `web_fetch` records what it fetched and `ila_collect_page`
  reuses it, so keeping a page the model just read costs no second request. The cache is built by
  `buildTools` and lives exactly one turn.

## Referencing with `@`

Typing `@` in the composer opens a picker over the account's sources — the only interactive part
of referencing, and the part with the rules worth stating:

- **The `@` must not be glued to a word.** An address (`ada@example.com`) is not a mention, and a
  picker that appeared in the middle of one would make the feature feel broken. Punctuation is
  fine, so `(@report.pdf)` works.
- **A space closes it.** A mention's query is a word.
- **`utils/mention.ts` owns both rules**, as arithmetic on a string and a caret, because the
  questions ("is the caret inside a mention", "where does the name go") have one right answer each
  and are testable without a DOM.

Picking a source does two things, and they are separate on purpose. The **name** goes into the
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

`SourceBrowser.vue` is one component with two front doors: the workspace home opens it over the
whole account, and a conversation opens it pre-filtered to its workspace. The caller says which
with two props — `initial` (the filter set) and `hidden` (the option groups that front door has no
business offering, e.g. a workspace picker inside that workspace). Data rather than a mode flag: a
`mode` would have to enumerate the combinations, and a third front door would be a third mode.

Filtering is the **server's**, including the scope filters, because a workspace with a
`node_modules` has tens of thousands of rows. The one thing the server cannot answer is *which
options exist* — the MIME types present, the categories in use — so a second, scope-only query
fills the option lists. It is re-issued when the scope changes and never when a filter does:
narrowing the list must not delete the option you narrowed by.

**Two ways to add**, because a source is two things: **上传资料** takes a file and **添加链接**
takes a URL, and both land in the workspace the picker names — never a conversation, which is
material that happened inside one. A pasted link is fetched server-side through `web_fetch`'s own
guard, so a URL resolving to a private address is refused with the guard's sentence; a hand-added
page carries **no summary**, because a summary is a reading of a page by something that understood
it, and nothing has read this one yet.

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

`read_document`'s whitelist stays `session_sources ∪ workspace_sources` — the uploads and pages
linked to the conversation and its workspace. Files inside a sandbox are deliberately not folded
into it: they are already readable *by path* through the file tools, and a workspace with a
`node_modules` would otherwise put thousands of rows into the whitelist as named sources.

Cross-workspace referencing therefore rides `session_sources`: a link is created when a user
actually references something, not for every file that happens to exist.

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
