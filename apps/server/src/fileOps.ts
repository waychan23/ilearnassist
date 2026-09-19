import { mkdir, realpath, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { FileAccessError, resolveReal } from "./files.js";

/**
 * The file manager's write side: the operations a person performs on a workspace's files.
 *
 * This is the counterpart to `files.ts`, and it is a separate module for the reason that one
 * exists at all. The reads there answer "what is in this directory" and are capped, shaped and
 * deliberately one level at a time; these *change* things, and every one of them has to answer
 * a question the reads never ask — is the destination still inside the sandbox, and is it one I
 * am allowed to create?
 *
 * **The guard is `resolveReal`, imported rather than reimplemented.** A browser read that
 * escapes a symlink shows someone a file they should not see; a *write* that escapes one
 * overwrites it. Two copies of that check is how one of them ends up the weaker one, so there
 * is one, and it is the one the reads already use.
 *
 * Nothing here knows about the database. Recording that a file moved is `resources.ts`'s job, and
 * it happens after the bytes do — a row written first would name a file that might not exist.
 */

/** A path a write is about to touch, proved to be inside its root. */
export interface SafePath {
  /** The absolute path. */
  abs: string;
  /** The path relative to the root, `/`-separated — what a source row stores. */
  rel: string;
}

/**
 * A path, checked twice, described in the two ways its callers need.
 *
 * `resolveReal` settles both questions at once: the lexical one (`..`, absolute paths) and the
 * real one (a symlink inside the tree pointing out of it). The relative form comes from the
 * same resolution rather than from the caller's string, so `.//a/../b.txt` and `b.txt` name one
 * place and produce one row.
 *
 * **The root is realpath'd first, and every path is then built from *that*.** Not tidiness:
 * `resolveReal` answers with the resolved path for something that exists and the *lexical* one
 * for something that does not, and on a platform where the root is itself reached through a
 * symlink — macOS, where `/var` is a symlink to `/private/var`, which makes every temp
 * directory one — those two forms differ by that prefix. Subtracting one from the other then
 * produces nonsense: a relative path that collapses to a bare file name, and an "is this inside
 * that" test that answers *no* for a directory's own child. Realpath'ing the root once means
 * every answer from this module shares one prefix.
 */
export async function safePath(root: string, relPath: string): Promise<SafePath> {
  const realRoot = await realpath(resolve(root)).catch(() => resolve(root));
  const abs = await resolveReal(realRoot, relPath);
  const rel = relative(realRoot, abs).split(sep).join("/");
  return { abs, rel };
}

/**
 * Create a directory, and any missing parents.
 *
 * Refuses a path that is not inside the sandbox, and one the caller left empty — the root
 * itself is not a directory that can be "created" and treating it as one would silently
 * succeed, which is a click that looks like it worked.
 */
export async function createDirectory(root: string, relPath: string): Promise<SafePath> {
  const target = await safePath(root, relPath);
  if (!target.rel) {
    throw new FileAccessError("INVALID_FILE_PATH", "A directory path is required.");
  }
  await mkdir(target.abs, { recursive: true });
  return target;
}

/**
 * Write a file's bytes, creating parent directories as needed.
 *
 * Used by the upload path, where the name is the client's and the directory is chosen
 * separately — see its caller, which refuses a name containing a separator rather than letting
 * one name a place.
 */
export async function writeFileAt(
  root: string,
  relPath: string,
  bytes: Buffer
): Promise<SafePath> {
  const target = await safePath(root, relPath);
  if (!target.rel) {
    throw new FileAccessError("INVALID_FILE_PATH", "A file path is required.");
  }
  await mkdir(dirname(target.abs), { recursive: true });
  await writeFile(target.abs, bytes);
  return target;
}

/**
 * Move or rename a file or a directory, or a whole subtree.
 *
 * Both ends are resolved before either is touched, so a refusal cannot leave the tree half
 * moved. The destination must not exist: `rename` would replace a file silently on POSIX, and a
 * file manager that overwrites on a name collision is one that loses work without asking.
 * Moving a directory *into itself* is caught by the same check the sandbox does — the
 * destination resolves inside the source, which `fs.rename` refuses with `EINVAL`; the check
 * here makes the refusal a sentence rather than an errno.
 */
export async function movePath(
  root: string,
  from: string,
  to: string
): Promise<{ from: SafePath; to: SafePath }> {
  const source = await safePath(root, from);
  const target = await safePath(root, to);
  if (!source.rel || !target.rel) {
    throw new FileAccessError("INVALID_FILE_PATH", "Both paths are required.");
  }
  if (source.rel === target.rel) {
    throw new FileAccessError("INVALID_FILE_PATH", "The file is already there.");
  }

  const sourceInfo = await stat(source.abs).catch((err: unknown) => {
    throw asFileOpError(err, from);
  });
  if (sourceInfo.isDirectory() && target.abs.startsWith(`${source.abs}/`)) {
    throw new FileAccessError("INVALID_FILE_PATH", "A directory cannot be moved inside itself.");
  }
  const occupied = await stat(target.abs).then(
    () => true,
    () => false
  );
  if (occupied) {
    throw new FileAccessError("FILE_EXISTS", `"${to}" already exists.`);
  }

  await mkdir(dirname(target.abs), { recursive: true });
  await rename(source.abs, target.abs).catch((err: unknown) => {
    throw asFileOpError(err, from);
  });
  return { from: source, to: target };
}

/**
 * Delete a file, or an empty directory.
 *
 * **The bytes are not destroyed.** They move to `trash/<fileId>/<rel>`, a sibling of the
 * workspace's sandbox rather than a corner of it — so the agent cannot read a file the user
 * deleted, which is what makes the delete true in the one place it matters, while the bytes
 * survive for a restore. Namespacing by source id is what lets the original path be kept
 * without two deletions colliding on one.
 *
 * An empty directory is removed; a populated one is refused, exactly as the agent's
 * `delete_file` refuses it. The alternative — a recursive delete from a browser — is one click
 * away from destroying work the user never saw.
 */
export async function deletePath(
  root: string,
  trashRoot: string,
  relPath: string,
  fileId: string
): Promise<{ rel: string; wasDirectory: boolean }> {
  const target = await safePath(root, relPath);
  if (!target.rel) {
    throw new FileAccessError("INVALID_FILE_PATH", "A path is required.");
  }

  const info = await stat(target.abs).catch((err: unknown) => {
    throw asFileOpError(err, relPath);
  });

  if (info.isDirectory()) {
    // `rmdir`, not `rm`: a directory is not a file, and `rm` without `recursive` refuses one
    // outright rather than saying whether it was empty — so the "is it empty" question never
    // gets asked and every directory delete fails. `rmdir` is the operation whose failure *is*
    // the answer: `ENOTEMPTY` means exactly what the refusal needs to say.
    await rmdir(target.abs).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        throw new FileAccessError("NOT_A_FILE", `"${relPath}" is not empty.`);
      }
      throw asFileOpError(err, relPath);
    });
    return { rel: target.rel, wasDirectory: true };
  }

  const destination = join(trashRoot, fileId, target.rel);
  await mkdir(dirname(destination), { recursive: true });
  await rename(target.abs, destination).catch((err: unknown) => {
    throw asFileOpError(err, relPath);
  });
  return { rel: target.rel, wasDirectory: false };
}

/**
 * A filesystem error as the client's vocabulary.
 *
 * The same mapping `files.ts` does for reads, kept beside the writes that need it: an `ENOENT`
 * is a file that is not there, and anything else — `EACCES`, `ENOSPC` — is rethrown, because
 * dressing a broken volume up as "not found" sends someone looking for a missing file.
 */
function asFileOpError(err: unknown, relPath: string): FileAccessError {
  if (err instanceof FileAccessError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return new FileAccessError("FILE_NOT_FOUND", `"${relPath}" does not exist.`);
  }
  if (code === "ENOTDIR" || code === "EISDIR") {
    return new FileAccessError("NOT_A_DIRECTORY", `"${relPath}" is not a directory.`);
  }
  throw err;
}
