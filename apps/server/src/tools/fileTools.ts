import { promises as fs } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { FILE_LOCATIONS } from "@ilearnassist/shared";
import type { FileLocation } from "@ilearnassist/shared";
import { resolveInWorkspace } from "../workspace.js";

const MAX_READ_CHARS = 40_000;
const MAX_LIST_ENTRIES = 200;

interface DirEntry {
  name: string;
  type: "file" | "dir";
}

/**
 * What a file tool needs to know: the two sandboxes, the default, and how to register a write.
 *
 * Both roots are **required**. An optional `sessionDir` would let a caller assemble the tools
 * without it, and the failure that produces is a file written where no row is made for it —
 * the registry quietly not covering the one writer that matters most. Required means a caller
 * that has not thought about the second sandbox does not compile.
 *
 * `register` is a callback rather than a `db` because this module knows nothing about the
 * database, exactly as it knows nothing about a turn: it writes files, and somebody else
 * decides what a written file means. It runs *after* the bytes are on disk, so a registration
 * that throws cannot leave a row pointing at a file that was never written.
 */
export interface FileToolContext {
  /** The workspace's shared sandbox: every conversation in the workspace sees this tree. */
  workdir: string;
  /** This conversation's own directory: nothing else sees it. */
  sessionDir: string;
  /** Where an unqualified write goes. Resolved per turn — see `writeLocation.ts`. */
  defaultLocation: FileLocation;
  register: (input: { location: FileLocation; relPath: string; size: number }) => void;
}

async function listDir(absPath: string, relBase: string): Promise<DirEntry[]> {
  const dirents = await fs.readdir(absPath, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    entries.push({
      name: relBase ? join(relBase, d.name) : d.name,
      type: d.isDirectory() ? "dir" : "file",
    });
  }
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
  );
}

/**
 * The file tools, bound to both of a conversation's sandboxes.
 *
 * The closure captures the two directories, so a tool can never act on a path outside the one
 * it resolved against — the same property the single-sandbox version had, now with two of
 * them. Which one a call means is `location`, and when it is absent the rule differs by
 * operation, on purpose:
 *
 * - **A write** goes to the session's default. That is the setting's whole meaning.
 * - **A read** tries the default and then the other root, and says which it used. A model that
 *   wrote a file last turn under a different default must still be able to read it, and a
 *   silent "file not found" for a file that is right there is the failure that teaches a model
 *   to stop trusting the tools.
 * - **A delete** refuses when the path exists in *both* roots. Deleting the wrong file is not
 *   a mistake a tool result can walk back, so an ambiguity is an error the model can resolve
 *   by naming a location, rather than a guess.
 */
export function buildFileTools(ctx: FileToolContext) {
  const roots: Array<{ location: FileLocation; root: string }> = [
    { location: "workspace", root: ctx.workdir },
    { location: "session", root: ctx.sessionDir },
  ];

  const rootFor = (location: FileLocation): string => (location === "workspace" ? ctx.workdir : ctx.sessionDir);
  const other = (location: FileLocation): FileLocation =>
    location === "workspace" ? "session" : "workspace";

  /** Sandbox one path against one root. Throws, so no tool ever receives an escaped path. */
  const resolveAt = (location: FileLocation, p: string, allowRoot = false): string => {
    const r = resolveInWorkspace(rootFor(location), p, allowRoot);
    if (!r.ok || !r.path) throw new Error(r.error ?? "Invalid path.");
    return r.path;
  };

  /** How `register` names a file: its path inside its root, `/`-separated on every platform. */
  const relOf = (location: FileLocation, abs: string): string =>
    relative(rootFor(location), abs).split(sep).join("/");

  /** Where a path actually exists, across both roots. Zero, one or two answers. */
  const existing = async (p: string): Promise<FileLocation[]> => {
    const found = await Promise.all(
      roots.map(async ({ location }) => {
        const abs = resolveAt(location, p);
        const there = await fs
          .stat(abs)
          .then(() => true)
          .catch(() => false);
        return there ? location : null;
      })
    );
    return found.filter((l): l is FileLocation => l !== null);
  };

  const LOCATION_FIELD = z
    .enum(FILE_LOCATIONS)
    .optional()
    .describe(
      'Which folder to use: "workspace" for files every conversation in this workspace shares, ' +
        '"session" for files that belong to this conversation alone. Omit it to use this ' +
        "conversation's default, which the system prompt states."
    );

  const listFiles = tool(
    async ({ path, location }) => {
      const where = location ?? ctx.defaultLocation;
      const abs = resolveAt(where, path, true);
      const relBase = path === "." || path === "" ? "" : path;
      const entries = await listDir(abs, relBase);
      const limited = entries.slice(0, MAX_LIST_ENTRIES);
      const note = entries.length > MAX_LIST_ENTRIES ? `\n(truncated from ${entries.length} entries)` : "";
      return JSON.stringify({ location: where, path, entries: limited }, null, 2) + note;
    },
    {
      name: "list_files",
      description:
        'List the contents of a directory in one of the two writable folders. Pass path "." to ' +
        "list that folder's root. Returns each entry's relative path and type.",
      schema: z.object({
        path: z
          .string()
          .default(".")
          .describe("Directory path relative to the folder selected by `location`."),
        location: LOCATION_FIELD,
      }),
    }
  );

  const readFile = tool(
    async ({ path, location }) => {
      // The fallback, in order: what the caller named, then the default, then the other root.
      // Reported in the result rather than applied silently, because a model that believes it
      // read one file while it read another is worse off than one told where the file was.
      const candidates = location
        ? [location]
        : [ctx.defaultLocation, other(ctx.defaultLocation)];
      const tried: FileLocation[] = [];
      for (const candidate of candidates) {
        const abs = resolveAt(candidate, path);
        let content: string;
        try {
          content = await fs.readFile(abs, "utf8");
        } catch {
          tried.push(candidate);
          continue;
        }
        let truncated = false;
        if (content.length > MAX_READ_CHARS) {
          content = content.slice(0, MAX_READ_CHARS);
          truncated = true;
        }
        // Only a *fallback* is worth announcing. When the caller named the folder it already
        // knows which one it asked for, and a note it did not need is one more line of context
        // spent on every read of a file in the non-default folder.
        const from =
          !location && candidate !== ctx.defaultLocation
            ? `[from the ${candidate} folder]\n`
            : "";
        return `${from}${content}${truncated ? `\n\n[... truncated at ${MAX_READ_CHARS} characters]` : ""}`;
      }
      throw new Error(
        `"${path}" was not found in ${tried.map((t) => `the ${t} folder`).join(" or ")}.`
      );
    },
    {
      name: "read_file",
      description:
        "Read a text file from either writable folder and return its contents. Long files are " +
        "truncated. Without `location`, the conversation's default folder is tried first and " +
        "the other one second; the result says which was used.",
      schema: z.object({
        path: z.string().describe("Path to the file, relative to the folder it is in."),
        location: LOCATION_FIELD,
      }),
    }
  );

  const writeFile = tool(
    async ({ path, content, location }) => {
      const where = location ?? ctx.defaultLocation;
      const abs = resolveAt(where, path);
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      ctx.register({ location: where, relPath: relOf(where, abs), size: Buffer.byteLength(content, "utf8") });
      return `Wrote ${content.length} characters to ${path} in the ${where} folder.`;
    },
    {
      name: "write_file",
      description:
        "Write a text file into one of the two writable folders, creating parent directories as " +
        "needed. Overwrites the file if it already exists. Write into the same folder as a file " +
        "the user referred to when the new file belongs beside it. If you cannot tell which " +
        "folder a file belongs in, ask the user with ask_user instead of guessing.",
      schema: z.object({
        path: z.string().describe("Path to the file, relative to the folder selected by `location`."),
        content: z.string().describe("Full text content to write."),
        location: LOCATION_FIELD,
      }),
    }
  );

  const createDirectory = tool(
    async ({ path, location }) => {
      const where = location ?? ctx.defaultLocation;
      // Deliberately registers nothing: a directory is not a source. Stated here so nobody
      // adds a row "for symmetry" — the registry is about material a model can read.
      await fs.mkdir(resolveAt(where, path), { recursive: true });
      return `Created directory ${path} in the ${where} folder.`;
    },
    {
      name: "create_directory",
      description:
        "Create a directory (and any missing parents) in one of the two writable folders.",
      schema: z.object({
        path: z.string().describe("Directory path, relative to the folder selected by `location`."),
        location: LOCATION_FIELD,
      }),
    }
  );

  const deleteFile = tool(
    async ({ path, location }) => {
      // One root named by the caller, or exactly one root that has the path. Two is a refusal:
      // the same relative path in both folders is a real ambiguity, and the caller resolves it
      // by saying which. Nothing is registered either way — see `create_directory`.
      let where: FileLocation;
      if (location) {
        where = location;
      } else {
        const [only, ...rest] = await existing(path);
        if (!only) throw new Error(`"${path}" does not exist in either folder.`);
        if (rest.length > 0) {
          throw new Error(
            `"${path}" exists in both folders. Pass location:"workspace" or location:"session" ` +
              `to say which one to delete.`
          );
        }
        where = only;
      }
      const abs = resolveAt(where, path);
      const st = await fs.lstat(abs);
      if (st.isDirectory()) await fs.rmdir(abs);
      else await fs.unlink(abs);
      return `Deleted ${path} from the ${where} folder.`;
    },
    {
      name: "delete_file",
      description:
        "Delete a file or empty directory from one of the two writable folders. If the same " +
        "path exists in both, pass `location` to say which one to delete.",
      schema: z.object({
        path: z.string().describe("Path to delete, relative to the folder it is in."),
        location: LOCATION_FIELD,
      }),
    }
  );

  return { listFiles, readFile, writeFile, createDirectory, deleteFile };
}
