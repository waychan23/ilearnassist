import type { FileLocation } from "@ilearnassist/shared";

/**
 * What a `write_file` call's **result** says, read back out.
 *
 * Two machine facts the file card needs and neither the tool's arguments nor the message can
 * give it: which sandbox the file actually landed in, and which **reference** it became. Both
 * exist only in the tool's own sentence, because both are decided after the model's call — the
 * `location` argument is optional and the write-location chain resolves it, and the reference is
 * minted by the registry once the bytes are on disk.
 *
 * That makes the sentence a **contract with `fileTools.ts`**, which is why the parsing lives here
 * rather than inside the component: a component is covered by Playwright alone, so a rule this
 * shape could only be pinned by a spec that also restates the sentence it depends on. Here it has
 * a unit test, and the server's own test pins the sentence itself.
 */

/** What the card can tell about the file the call wrote. */
export interface WrittenFile {
  /** Which sandbox it is in. `null` when the result names none — see `resolvedRoot`. */
  root: FileLocation | null;
  /** The reference it became, or `""` when the result carries no usable id. */
  referenceId: string;
}

/**
 * The id, matched as a **uuid at the very end of the sentence**.
 *
 * Deliberately not "anything in parentheses": a file legitimately named `notes (id 42).md` makes
 * the loose pattern bind `"42"`, and the note control is then live against a reference nothing
 * answers — a button that renders and cannot work. Anchoring on the shape `newId()` produces makes
 * a filename unable to be mistaken for one, and the trailing `.` says which of the sentence's
 * parentheses is the one being read.
 */
const REFERENCE_ID =
  /\(id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\.$/;

const WORKSPACE = /in the workspace folder/;
const SESSION = /in the session folder/;

export function writtenFile(output: string): WrittenFile {
  const body = output ?? "";
  return {
    root: WORKSPACE.test(body) ? "workspace" : SESSION.test(body) ? "session" : null,
    referenceId: REFERENCE_ID.exec(body)?.[1] ?? "",
  };
}

/**
 * Which root to open the file at.
 *
 * The result wins, the call's own `location` argument is the fallback, and `session` is the last
 * resort — which is the **product default**, the same value the write itself would have resolved
 * to. Reading the result first is not fastidiousness: `workdir/` and a conversation's own folder
 * can hold the same name, and opening the wrong one is a preview of a different file that looks
 * like it worked.
 */
export function resolvedRoot(file: WrittenFile, locationArgument?: unknown): FileLocation {
  if (file.root) return file.root;
  return locationArgument === "workspace" ? "workspace" : "session";
}
