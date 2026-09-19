# Migrations

How the database's shape changes, and what has to happen when it does.

The short version: **most changes need nothing, and the ones that need something say so.** Three
rules, and picking the right one is the whole skill.

| The change | Where it goes | Version bump? | Step? |
| --- | --- | --- | --- |
| A new **table** or a new **index** | `apps/server/src/schema.ts`'s `DDL` | no | no |
| A new **column** | `DDL` **and** an `ensureColumn` call in `db.ts` | no | no |
| Anything else | `SCHEMA_VERSION` + 1, and an entry in `MIGRATIONS` | **yes** | **yes** |

"Anything else" means: changing what an existing column *means*; dropping a column or a table;
adding `NOT NULL` to a column that has rows; rebuilding an index; and any change that has to
*read* existing rows to decide what to write.

## Why the first two need nothing

`DDL` is applied on **every** open, and every statement in it is `CREATE … IF NOT EXISTS`. So a
new table or index reaches a database that already exists the next time the server starts — no
version, no step, no release note. `ensureColumn` is the same idea for a column:
`CREATE TABLE IF NOT EXISTS` skips a table that is already there, so an older file would never
gain the column from the DDL alone, and `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` is what
closes that gap.

**A new column is deliberately two edits.** `DDL` is what a *fresh* install gets; `ensureColumn`
is how an *existing* one catches up. They are not redundant and neither is optional — a column
in the DDL alone reaches new installs, and a column in `ensureColumn` alone is missing from the
schema a new database is built with.

The price of this design is that a file's column **order** depends on its history: a fresh
database gets `DDL` order, a walked one has the old order with everything added appended. Nothing
depends on it — there is no `INSERT INTO t VALUES` without a column list anywhere in the server,
and every row is mapped by name — and `test/migrations.test.ts` asserts the column *sets* are
identical while saying the order is not.

## The third rule: a step

When the idempotent DDL cannot express the change, it is a **step** — and a step is Flyway's
model, implemented in `apps/server/src/migrations.ts`.

```ts
// apps/server/src/migrations.ts
export const MIGRATIONS: SchemaStep[] = [
  {
    id: "v5-notes-drop-legacy-anchor",
    from: 5,
    to: 6,
    sql: `
      ALTER TABLE notes DROP COLUMN anchor_offset;
      UPDATE notes SET target_kind = 'text' WHERE target_kind IS NULL;
    `,
  },
];
```

Updating `SCHEMA_VERSION` in `schema.ts` to 6 is the other half. What the three properties buy:

- **One transaction for the whole walk.** Every step, every version stamp and every history row
  commit together. A failure anywhere leaves the file exactly at the version it started on —
  there is no half-migrated state, which is the thing that has no recovery path.
- **The version and the history cannot disagree.** Both are written inside that transaction, so
  "the file says v6" and "the row saying v6 is there" are the same fact.
- **Foreign keys off, `legacy_alter_table` on.** With `foreign_keys` on, `ALTER TABLE … RENAME`
  rewrites the `REFERENCES` clauses of every table pointing at the renamed one, and dropping the
  old table then fires their `ON DELETE CASCADE`. Both pragmas are per-connection and neither can
  be set inside a transaction, which is why they bracket it rather than live in it.

### Two rules that have no enforcement but must not be broken

- **A step that has shipped is never edited.** The history stores `sha256(id + sql)`, and a file
  whose recorded checksum no longer matches is **refused at startup**, naming the step. The only
  way to fix a step that was wrong is a new step. (The check cannot see an edit made *before* the
  step first ran — there is nothing to compare against — which is why the review happens in the
  pull request.)
- **`id` is stable.** It is half the checksum and it is what an operator sees in the log. Renaming
  a step is editing it.

There is also a shape guard: a step must be single-hop (`to === from + 1`), no two steps may leave
the same version, and every `from` must be a version `canMigrate` can reach. `MIGRATIONS` is empty
today, so all of that is a constraint on the future rather than on the present.

## The snapshot

**A walk takes a copy of the database first**, into `<dataRoot>/backups/`, and **refuses to run if
it cannot take one.** That is the one thing in the codebase protecting a user's data from a
migration, and it is worth knowing why it is not a warning:

- A step that *fails* rolls back and is recoverable. A step that **succeeds and was wrong** is
  not: `user_version` cannot go backwards, the old code is gone, and the only copy of the old
  shape is a file taken before the walk.
- A disk with no room for a copy has no room for the migration either. Refusing is the safe
  answer, and a server that will not start is a problem the user can see — while a migration that
  ate their work is one they cannot.

It uses `VACUUM INTO`, never a file copy. The database runs in WAL mode, so the bytes of
`<name>.sqlite` are **not** the database: measured on this engine, a `copyFileSync` taken before a
checkpoint produced a 4 KB file containing *no tables at all*, and the identical copy after
`wal_checkpoint(TRUNCATE)` contained everything. The failure is intermittent and total, which is
the worst combination — it passes on the machine that happened to checkpoint.

Five snapshots are kept, oldest deleted first. `ILA_SKIP_MIGRATION_BACKUP=1` opts out for a
deployment that takes its own volume-level snapshots (a Docker host, a managed disk); it is off by
default and it is the *only* way to walk without a copy.

## Running it

The walk happens **automatically** on any open of the database — the server's boot, and the
administrator CLI — so an upgrade needs nothing from the user. Two commands exist for looking and
for doing it deliberately:

```bash
pnpm --filter @ilearnassist/server cli migrate-status    # read-only: what is it, what would run
pnpm --filter @ilearnassist/server cli migrate-up        # walk it, with the snapshot
```

`migrate-status` cannot write: it opens the file `readonly: true` and runs no DDL, no
`journal_mode` and no `ensureColumn`. Two commands rather than one with an `--up` flag, because a
flag that turns a question into a write is exactly the kind of thing that gets typed by accident.

`status` also reports the schema state, so the desktop panel can say *"this data folder needs
upgrading"* before the user presses Start rather than letting them discover it from a server that
will not come up.

## What is still refused, and why

`SCHEMA_VERSION` 2 through 4 are **not** walkable, and the framework landing did not change that:
`MIGRATIONS` has no steps, so a pre-v5 file is refused exactly as it was before. Those three
versions changed what a column *meant* — a `sources` row and a `work_resources` row are both "the
material an account holds" — and the new value would have to be **chosen** from data that does not
determine it (which owner a link belonged to). A guessed owner is worse than a file that will not
open, because nothing downstream can tell that it is wrong.

v5 is therefore **the first version of the migration era**: every change from here is expected to
reach an existing file rather than replace it.
