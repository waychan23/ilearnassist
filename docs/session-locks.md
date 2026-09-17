# Session write locks

One conversation, one writer. A client that opens a conversation takes a **lease** on it; every
other client of the same account reads that conversation and cannot write to it until the lease is
given back or expires. The session list marks which is which, and the composer refuses before a
turn is composed.

This document is the design, and — more importantly — **what it deliberately does not guarantee**.
The requirement says so in as many words (允许极端情况下的冲突…不要求做到强一致性), and a tolerance that
lives only in somebody's head is a bug report waiting to be filed.

## What a client is

There is no client identity on the server to key a lease on, which is the fact the whole design
turns on. `auth_tokens.id` is the SHA-256 of a token, and `issueTokens()` mints a **new access
token — and therefore a new row, a new id — on every refresh**. A lease keyed on that would change
holder underneath a client that had merely been running for a day, and the client would then refuse
its own heartbeat.

So the holder is an id **the client generates**, sent as `X-Client-Id` (the name is
`CLIENT_ID_HEADER` in `packages/shared`), and scoped to one **browser tab** — `sessionStorage`, not
`localStorage`:

| | |
| --- | --- |
| same tab, page reloaded | the same client — a refresh is not a takeover |
| a new tab | a new client, so it opens the conversation read-only |
| a phone and a desktop | two clients, which is the case the feature exists for |

`sessionStorage` rather than `localStorage` is what makes "two tabs are two clients" true, and that
is the point: two tabs of one browser writing into one conversation is exactly the interleaving the
lock is for. The cost is stated rather than hidden — opening the same conversation twice on one
machine gives the second tab a read-only view.

**The id is asserted, not authenticated.** Any client can send any id, including one that is not
its own. That is deliberate: the lock is *advisory*, and it is not a security boundary. The
security boundary is unchanged and lives elsewhere — every route still resolves the session
`ForUser`, so another account's conversation is a 404 whichever client id arrives with the request.

## The lease

One row per conversation, in `session_locks`, primary-keyed on `session_id` — so "at most one
holder" is the table's shape rather than an invariant some future statement has to remember. The
row carries the holder, when it was taken, and when it expires. No `deleted_at`: its whole meaning
is "held *now*", so release and expiry are real `DELETE`s.

Acquire, renew and release are one statement each, and **the statement's own `WHERE` is the whole
of the concurrency control** — the shape `setAutoTitleForUser` uses, and for the same reason: a
read followed by a write is a window two callers both pass.

```sql
INSERT INTO session_locks (session_id, client_id, acquired_at, expires_at)
SELECT s.id, @clientId, @now, @expiresAt
  FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
 WHERE s.id = @sessionId AND w.user_id = @userId
ON CONFLICT(session_id) DO UPDATE SET …
 WHERE session_locks.expires_at <= @now OR session_locks.client_id = @clientId
```

Three consequences fall out of that rather than being branches:

- **Re-entry is a heartbeat.** The same client's second call matches `client_id = @clientId` and
  takes the update path — so one endpoint serves both the claim on entering a conversation and the
  once-a-minute beat, and the client never has to know which it is doing.
- **`changes === 0` means exactly one thing**: a live lease held by somebody else. That is the 409,
  and it needs no second query to interpret.
- **`acquired_at` is kept across beats.** It answers when this client first took the conversation;
  resetting it every minute would make it a second `expires_at`.

### The numbers, and the arithmetic between them

| | | |
| --- | --- | --- |
| lease TTL | 120 s | `SESSION_LOCK_TTL_SECONDS`, in `packages/shared` |
| heartbeat | 60 s | derived as TTL / 2 on the client, never a second constant |
| workspace poll | 5 min | the backstop for states this client cannot see change |
| refresh debounce | 2 s | every trigger funnels into one workspace-wide request |

The heartbeat is **derived** from the TTL so the two cannot drift into a lease that expires between
beats, and it is half the TTL so that **one missed beat is survivable** — a laptop waking, a network
blink. A test asserts the ordering.

There is deliberately **no sweep job**. The acquire statement's upsert reclaims an expired row in
place, so an expiry needs no timer, and lease abandoned by a closed tab costs one row until somebody
wants the conversation.

## The write gate

`requiresSessionLock` on a route's config, checked by a second `onRequest` hook — the same
deny-by-default place the auth gate lives, so the set is readable in one list rather than assembled
from whoever remembered. It resolves the session from `params.id`, which every session-scoped route
names its session.

**The gate renews a lease; it never takes one.** A gated write by the holder renews it (a write is
evidence of presence, so an active client's lease cannot lapse between beats), and a write on a
conversation nobody holds is allowed — there is nobody to conflict with. What it does *not* do is
claim a free conversation on the strength of the write.

That was the first shape, and a second writer is what showed it was wrong: any API client writing to
a conversation — a script, a spec seeding data — would seize its lock and leave the reader's own tab
read-only for two minutes, having never asked for a lease and having no lifecycle to give it back. A
lease exists because a client **opened** a conversation; a write is not that act. The cost is the
narrow race two clients on an otherwise-free conversation run, which is tolerance (2) below.

A client that arrived with no `X-Client-Id` is refused outright, before any lookup, because it can
never be the holder.

Two asymmetries are load-bearing:

- **It does not answer for a session that does not exist, and needs no second read to avoid it.**
  The lease lookup is owner-scoped, so a conversation that is not this account's — or is not there
  at all — finds no lease, the hook returns, and the route answers its own 404. Answering the
  conflict instead would be a second and differently-shaped answer about existence: a bad id in a
  URL coming back "somebody is editing this" for a conversation nobody can edit.
- **A client with no id can never hold a lease** and is refused like one holding the wrong one: an
  unattributed request cannot be told apart from a request that is not the holder. The suite's
  helpers send an id (`injectAs` on the server, `fixtures.ts` on the browser side), so this costs
  the tests nothing and the rule stays uniform — to write, name yourself.

Which routes carry it, and the short list that deliberately does not, is asserted in both
directions by `apps/server/test/route-lock-coverage.test.ts` — the flag is a route *config*, and a
route added without it compiles perfectly well.

## The client

- **State** lives in `stores/app.ts` with everything else, so `forgetAccount()` clears it for free:
  a lease held by a signed-out account must not go on beating, and a stale list must not hand the
  next account a read-only conversation that is not its own.
- **Lifetimes** live in `composables/sessionLock.ts`, an effect owned by `ChatView`'s setup. That is
  what makes the requirement's 退出工作区时，取消所有检测逻辑 structural rather than a flag somebody
  has to remember: the view going away stops the timers and releases the lease, and *that* — not a
  reactive input — is the one transition no effect can see.
- **A refusal from a turn route** is the fifth detection trigger the requirement names, and the one
  no polling can prevent: the turn is refused before it starts. `consume` re-reads the workspace's
  locks on that code, so the error becomes a state — composer read-only, dot orange — rather than a
  sentence that leaves the buttons looking live. It also raises the toast, unlike every other
  failure that arrives as a thrown response, because a refused turn is never persisted: the message
  list keeps no trace and the in-bubble banner unmounts with it.

## What this does not guarantee

Stated, not discovered.

1. **A lease can be taken by a client that should not have it.** Client ids are asserted, not
   verified, so a forged one wins a conversation. The lock is advisory by design; nothing about
   anybody's data depends on it, and the account check on the session is what protects the row.
2. **Two clients can both write to a conversation nobody holds.** The gate allows a write when no
   lease exists rather than claiming one — see above — so two clients arriving on the same free
   conversation at the same instant are both allowed. Narrow, and only reachable when neither
   holds a lease; two clients that each *opened* the conversation are both coordinated, and a
   client that did cannot be the second one.
3. **Two clients can briefly both believe they hold a conversation** across an expiry boundary: a
   lease that lapses while its holder is mid-turn is not taken away, and the next client may claim
   it a moment later. This is the case the requirement tolerates — the alternative, interrupting a
   turn that is already streaming, is a worse failure than the interleaving it would prevent.
4. **The lease is checked when a turn starts, never during one.** A running turn is never
   interrupted by a lapse.
5. **An unattributed writer is refused, but a determined one is not.** This is (1) again from the
   other side: the gate is a coordination mechanism among clients that participate, not an
   access control.
6. **The workspace's file manager is not gated.** `workdir/` is the tree every conversation in a
   workspace shares, and `writeLocation` already defaults to `session` for the reason that a
   directory every conversation writes into is a junk drawer. Locking a conversation does not lock
   that tree, and two clients can still edit one file in it. A per-file lock is a different feature
   with a different granularity, and it is not this one.
7. **A refused write is refused, not retried.** The client shows the state and lets the reader take
   the conversation back by returning to it; nothing queues a write until the lease is free.

## Reading the UI

| | |
| --- | --- |
| green dot on a session row | this client holds it, so typing works here |
| orange dot on a session row | another client holds it; the conversation opens read-only here |
| no dot | nobody holds it — the ordinary case, and the reason a single client sees nothing at all |
| banner over the conversation | the same fact as the orange dot, in words |
| disabled send | the third surface of the same fact, with the sentence as its title |

The dot is a **status**, not a warning, which is why it has its own colour token (`--lock-held`)
rather than borrowing `--warning` — the config banner and `.hint.warn` mean "you can do something
about this", and a conversation somebody else is typing into is not that.

There is deliberately **no unlock control**. 主动解锁 is the release on leaving the conversation,
which is automatic: the reader going away is the signal, and a button would be a second way to do
what leaving already does.
