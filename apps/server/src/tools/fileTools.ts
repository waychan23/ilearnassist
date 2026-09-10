import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveInWorkspace } from "../workspace.js";

const MAX_READ_CHARS = 40_000;
const MAX_LIST_ENTRIES = 200;

interface DirEntry {
  name: string;
  type: "file" | "dir";
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
 * Build the set of file-operation tools, each sandboxed to `workspaceDir`.
 * The closure captures the workspace directory, so a tool can never act on a
 * path outside the workspace it was created for.
 */
export function buildFileTools(workspaceDir: string) {
  const resolve = (p: string) => {
    const r = resolveInWorkspace(workspaceDir, p);
    if (!r.ok || !r.path) throw new Error(r.error ?? "Invalid path.");
    return r.path;
  };

  const listFiles = tool(
    async ({ path }) => {
      const abs = resolveInWorkspace(workspaceDir, path, true);
      if (!abs.ok || !abs.path) throw new Error(abs.error);
      const relBase = path === "." || path === "" ? "" : path;
      const entries = await listDir(abs.path, relBase);
      const limited = entries.slice(0, MAX_LIST_ENTRIES);
      const note = entries.length > MAX_LIST_ENTRIES ? `\n(truncated from ${entries.length} entries)` : "";
      return JSON.stringify({ path, entries: limited }, null, 2) + note;
    },
    {
      name: "list_files",
      description:
        "List the contents of a directory inside the active workspace. Pass path \".\" to list the workspace root. Returns each entry's relative path and type.",
      schema: z.object({
        path: z.string().default(".").describe("Directory path relative to the workspace root."),
      }),
    }
  );

  const readFile = tool(
    async ({ path }) => {
      const abs = resolve(path);
      let content = await fs.readFile(abs, "utf8");
      let truncated = false;
      if (content.length > MAX_READ_CHARS) {
        content = content.slice(0, MAX_READ_CHARS);
        truncated = true;
      }
      return `${content}${truncated ? `\n\n[... truncated at ${MAX_READ_CHARS} characters]` : ""}`;
    },
    {
      name: "read_file",
      description:
        "Read a text file inside the active workspace and return its contents. Long files are truncated.",
      schema: z.object({
        path: z.string().describe("Path to the file, relative to the workspace root."),
      }),
    }
  );

  const writeFile = tool(
    async ({ path, content }) => {
      const abs = resolve(path);
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return `Wrote ${content.length} characters to ${path}.`;
    },
    {
      name: "write_file",
      description:
        "Write a text file inside the active workspace, creating parent directories as needed. Overwrites the file if it already exists.",
      schema: z.object({
        path: z.string().describe("Path to the file, relative to the workspace root."),
        content: z.string().describe("Full text content to write."),
      }),
    }
  );

  const createDirectory = tool(
    async ({ path }) => {
      const abs = resolve(path);
      await fs.mkdir(abs, { recursive: true });
      return `Created directory ${path}.`;
    },
    {
      name: "create_directory",
      description: "Create a directory (and any missing parents) inside the active workspace.",
      schema: z.object({
        path: z.string().describe("Directory path, relative to the workspace root."),
      }),
    }
  );

  const deleteFile = tool(
    async ({ path }) => {
      const abs = resolve(path);
      const st = await fs.lstat(abs);
      if (st.isDirectory()) await fs.rmdir(abs);
      else await fs.unlink(abs);
      return `Deleted ${path}.`;
    },
    {
      name: "delete_file",
      description: "Delete a file or empty directory inside the active workspace.",
      schema: z.object({
        path: z.string().describe("Path to delete, relative to the workspace root."),
      }),
    }
  );

  return { listFiles, readFile, writeFile, createDirectory, deleteFile };
}