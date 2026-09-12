import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "../src/db.js";

/**
 * The scoping rule, walked accessor by accessor with two fully-populated accounts.
 *
 * Every user-owned read takes an owner and puts it in the `WHERE`, so another account's id
 * is not a permission question to be checked — the row is simply not found. That makes the
 * failure mode specific: one accessor added without the filter, which returns another
 * person's conversation. A spot check of the two or three an author happened to think of
 * would miss exactly that one, so this file is deliberately exhaustive rather than
 * illustrative.
 *
 * HTTP is covered separately — here it is the database's own surface, which is where the
 * rule is implemented and therefore where it has to hold.
 */

let root: string;
let db: AppDb;

const ADA = "u-ada";
const BOB = "u-bob";

/** One workspace, one conversation, one message — per account, keyed by the owner's id. */
function seed(userId: string): void {
  db.createWorkspace({
    id: `w-${userId}`,
    userId,
    name: "W",
    slug: "w",
    dirPath: join(root, userId, "w"),
  });
  db.createSession({
    id: `s-${userId}`,
    workspaceId: `w-${userId}`,
    copilotId: null,
    title: "T",
  });
  db.createMessage({
    id: `m-${userId}`,
    sessionId: `s-${userId}`,
    role: "user",
    content: "hi",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ila-own-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: ADA, username: "ada", slug: "ada" });
  db.createUser({ id: BOB, username: "bob", slug: "bob" });
  seed(ADA);
  seed(BOB);
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

describe("workspaces", () => {
  it("lists only the caller's own", () => {
    expect(db.listWorkspaces(ADA).map((w) => w.id)).toEqual([`w-${ADA}`]);
    expect(db.listWorkspaces(BOB).map((w) => w.id)).toEqual([`w-${BOB}`]);
  });

  it("does not find another account's workspace by id", () => {
    expect(db.getWorkspaceForUser(`w-${BOB}`, ADA)).toBeUndefined();
    expect(db.getWorkspaceForUser(`w-${ADA}`, ADA)?.id).toBe(`w-${ADA}`);
  });

  it("does not rename another account's workspace", () => {
    expect(db.renameWorkspaceForUser(`w-${BOB}`, ADA, "stolen")).toBeUndefined();
    // Unchanged, which is the half that actually matters — a refused write that still wrote
    // would pass an assertion on the return value alone.
    expect(db.getWorkspaceForUser(`w-${BOB}`, BOB)?.name).toBe("W");
  });

  it("does not delete another account's workspace", () => {
    expect(db.deleteWorkspaceForUser(`w-${BOB}`, ADA)).toBe(false);
    expect(db.getWorkspaceForUser(`w-${BOB}`, BOB)).toBeDefined();
  });

  it("reports its own not-found and another's alike, so an id cannot be probed", () => {
    // Both are `undefined`. A distinguishable answer would turn id guessing into a way to
    // learn what other accounts have.
    expect(db.getWorkspaceForUser("w-nope", ADA)).toBeUndefined();
    expect(db.getWorkspaceForUser(`w-${BOB}`, ADA)).toBeUndefined();
  });
});

describe("sessions", () => {
  it("lists only the conversations in the caller's own workspace", () => {
    expect(db.listSessionsForUser(`w-${ADA}`, ADA).map((s) => s.id)).toEqual([`s-${ADA}`]);
    expect(db.listSessionsForUser(`w-${BOB}`, ADA)).toEqual([]);
  });

  it("does not find another account's conversation by id", () => {
    expect(db.getSessionForUser(`s-${BOB}`, ADA)).toBeUndefined();
    expect(db.getSessionForUser(`s-${ADA}`, ADA)?.session.id).toBe(`s-${ADA}`);
  });

  it("hands back the workspace that owns the conversation, and it is the caller's", () => {
    expect(db.getSessionForUser(`s-${ADA}`, ADA)?.workspace.id).toBe(`w-${ADA}`);
  });

  it("does not update another account's conversation", () => {
    expect(db.updateSessionForUser(`s-${BOB}`, ADA, { title: "stolen" })).toBeUndefined();
    expect(db.getSessionForUser(`s-${BOB}`, BOB)?.session.title).toBe("T");
  });

  it("does not auto-title another account's conversation", () => {
    expect(db.setAutoTitleForUser(`s-${BOB}`, ADA, "stolen")).toBeUndefined();
    expect(db.getSessionForUser(`s-${BOB}`, BOB)?.session.title).toBe("T");
  });

  it("does not delete another account's conversation", () => {
    expect(db.deleteSessionForUser(`s-${BOB}`, ADA)).toBe(false);
    expect(db.getSessionForUser(`s-${BOB}`, BOB)).toBeDefined();
  });
});

describe("messages", () => {
  it("lists only the messages in the caller's own conversation", () => {
    expect(db.listMessagesForUser(`s-${ADA}`, ADA).map((m) => m.id)).toEqual([`m-${ADA}`]);
    expect(db.listMessagesForUser(`s-${BOB}`, ADA)).toEqual([]);
  });

  it("does not find another account's message by id", () => {
    expect(db.getMessageForUser(`m-${BOB}`, ADA)).toBeUndefined();
    expect(db.getMessageForUser(`m-${ADA}`, ADA)?.id).toBe(`m-${ADA}`);
  });
});

describe("deleting an account", () => {
  it("takes its workspaces, conversations and messages with it", () => {
    // The foreign keys are what make "delete this account" a single statement rather than a
    // sweep somebody has to remember to extend. Nothing deletes accounts over HTTP yet; this
    // pins the cascade so the route that does cannot quietly leave rows behind.
    db.raw.prepare("DELETE FROM users WHERE id = ?").run(BOB);

    expect(db.listWorkspaces(BOB)).toEqual([]);
    expect(db.getSessionForUser(`s-${BOB}`, BOB)).toBeUndefined();
    expect(db.getMessageForUser(`m-${BOB}`, BOB)).toBeUndefined();
    // And the other account is untouched.
    expect(db.listWorkspaces(ADA).map((w) => w.id)).toEqual([`w-${ADA}`]);
  });
});
