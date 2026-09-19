import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FileLocation } from "@ilearnassist/shared";
import { buildFileTools, type FileToolContext } from "../../src/tools/fileTools.js";

/**
 * The file tools, with both sandboxes under one root and every write recorded.
 *
 * A helper rather than a line per test, because the context grew from one string to four
 * fields and eight call sites would otherwise each carry their own idea of what a
 * `FileToolContext` is — which is the same reason the type is not optional: a caller that has
 * not thought about the second sandbox should not compile.
 *
 * `sessionDefault` is `session` (the product default) so a test that does not care about the
 * setting gets the behaviour a fresh conversation has.
 */
export interface FileToolHarness {
  tools: ReturnType<typeof buildFileTools>;
  ctx: FileToolContext;
  /** Every `register` call, in order — what the registry would have been handed. */
  written: Array<{ location: FileLocation; relPath: string; size: number }>;
  /** Every `unregister` call, in order — the deletions the registry would have performed. */
  removed: Array<{ location: FileLocation; relPath: string }>;
  /**
   * Whether `unregister` claims to have handled the file, per test.
   *
   * The real one answers by whether the file has a reference; here it is a switch, because the
   * tool's own behaviour is what these tests are about — "did it unlink when the registry said
   * no" and "did it leave the bytes alone when the registry said yes" are the two cases.
   */
  handlesRemoval: boolean;
  workdir: string;
  sessionDir: string;
}

export function fileToolsFor(
  workspaceRoot: string,
  options: { defaultLocation?: FileLocation; sessionId?: string } = {}
): FileToolHarness {
  const workdir = join(workspaceRoot, "workdir");
  const sessionDir = join(workspaceRoot, "sessions", options.sessionId ?? "s1");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const written: FileToolHarness["written"] = [];
  const removed: FileToolHarness["removed"] = [];
  /*
   * A mutable holder rather than a plain field: a test flips this *after* the harness is built,
   * and `{ ...harness }` would copy the boolean and leave the closure reading the original.
   *
   * `false` is the default because this harness has no registry behind it — nothing it wrote was
   * ever made referenceable — so a file it deletes is deleted by the tool, which is what every
   * test here that does not say otherwise is about.
   */
  const state = { handlesRemoval: false };
  const ctx: FileToolContext = {
    workdir,
    sessionDir,
    defaultLocation: options.defaultLocation ?? "session",
    /*
     * A reference id per write, in the shape the real registry makes them. Returned rather than
     * ignored because the tools put it *in their result* — the model gets a handle for
     * `read_document` and the file card gets one for 标注/笔记 — so a harness that returned
     * nothing would hide the whole of that half from every test that writes a file.
     */
    register: (input) => {
      const id = `wr-${written.length + 1}`;
      written.push(input);
      return id;
    },
    unregister: async (input) => {
      removed.push(input);
      return state.handlesRemoval;
    },
  };

  return {
    tools: buildFileTools(ctx),
    ctx,
    written,
    removed,
    workdir,
    sessionDir,
    get handlesRemoval(): boolean {
      return state.handlesRemoval;
    },
    set handlesRemoval(next: boolean) {
      state.handlesRemoval = next;
    },
  };
}
