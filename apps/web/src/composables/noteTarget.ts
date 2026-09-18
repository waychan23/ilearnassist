import { ref, type Ref } from "vue";
import type { Note, NoteTargetKindChoice, WorkResource } from "@ilearnassist/shared";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import type { FigureViewer } from "./figureViewer";
import { resourceName } from "../utils/resourceView";

/**
 * What a note about an object is about — resolved now, rather than as it was written.
 *
 * A note stores its target as a **handle** (a diagram's canonical file name, a table's slug, a
 * reference's id) and a snapshot of the object's title in its 标注原文. The handle is what makes
 * the note survive a rename of anything around it; the snapshot is what makes it readable when the
 * object is gone. Neither tells the reader what the object says *today*, which is the question the
 * panel is actually asked — and it is the question a second lookup answers.
 *
 * **Three list endpoints, one per kind, and only the ones the list needs.** A note about a file
 * costs one request, not three, which matters because this runs whenever the notes list changes.
 * A failed lookup is swallowed rather than reported: the fallback is the snapshot already in the
 * note, so the reader sees a slightly stale 标注原文 rather than an error about a panel they were
 * reading happily.
 *
 * **One gap, stated rather than hidden.** A resource is looked up in the conversation's own union
 * (its references plus its workspace's), while the server resolves a resource note against the
 * whole account — so a note about a reference held by *another* workspace resolves on the server
 * and misses here. That note falls back to its snapshot and loses its 查看详情 control, which is
 * the correct degradation for an object this conversation cannot otherwise reach.
 */

/** What the panel knows about one note's target. */
export interface NoteTargetDetail {
  kind: NoteTargetKindChoice;
  /** The handle, canonical — the same string the note stores. */
  ref: string;
  /** What the object is called, as it is now. */
  title: string;
  /** What it says about itself, empty when it has no summary. */
  summary: string;
  /**
   * Show the object.
   *
   * Null when there is nothing to show *here* — a diagram whose file is gone, or a target this
   * conversation cannot reach. A control that renders and does nothing is the failure this
   * repository names most often, so the chip is drawn without it rather than disabled.
   */
  open: (() => void) | null;
}

/** The map key. Both halves are needed: a diagram and a table may share a name. */
const keyOf = (kind: NoteTargetKindChoice, ref: string): string => `${kind}:${ref}`;

/** A lookup that failed, as `null` — the caller falls back to the note's own snapshot. */
async function attempt<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch {
    return null;
  }
}

export interface NoteTargets {
  /** Every target the list names, newest answer wins. */
  load(sessionId: string, notes: readonly Note[]): Promise<void>;
  /** What is known about a note's target, or null while it is unknown or unreachable. */
  detailFor(note: Note): NoteTargetDetail | null;
}

/**
 * @param openFigure the caller's own figure viewer.
 *
 * Passed in rather than made here, and that is not tidiness: `useFigureViewer` is a *factory* —
 * each call gets its own `viewing` ref, and the caller is what renders the dialog off it. A second
 * instance constructed in here would set a ref nobody renders, so 查看详情 on a table would open
 * nothing at all while looking exactly like a control that works.
 */
export function useNoteTargets(
  openFigure: FigureViewer["open"]
): NoteTargets & { details: Ref<Map<string, NoteTargetDetail>> } {
  const store = useAppStore();
  const details = ref<Map<string, NoteTargetDetail>>(new Map());

  /** Which kinds the list actually names — the reason a file note costs one request. */
  function wanted(notes: readonly Note[]): Set<NoteTargetKindChoice> {
    const kinds = new Set<NoteTargetKindChoice>();
    for (const note of notes) {
      if (note.targetKind !== "text" && note.targetRef !== null) kinds.add(note.targetKind);
    }
    return kinds;
  }

  async function load(sessionId: string, notes: readonly Note[]): Promise<void> {
    const kinds = wanted(notes);
    if (kinds.size === 0) {
      details.value = new Map();
      return;
    }

    const [diagrams, tables, resources] = await Promise.all([
      kinds.has("diagram") ? attempt(api.listSessionDiagrams(sessionId)) : null,
      kinds.has("table") ? attempt(api.listSessionTables(sessionId)) : null,
      kinds.has("resource") ? attempt(api.listSessionResources(sessionId)) : null,
    ]);

    const found = new Map<string, NoteTargetDetail>();

    for (const diagram of diagrams?.diagrams ?? []) {
      found.set(keyOf("diagram", diagram.name), {
        kind: "diagram",
        ref: diagram.name,
        title: diagram.name,
        summary: diagram.summary,
        // A row whose file is gone is a drawing nothing can render, so the chip is drawn without
        // the control rather than as one that opens an empty preview.
        open: diagram.fileMissing
          ? null
          : () => void openFigure("diagram", diagram.name, diagram.name, diagram.summary),
      });
    }

    for (const table of tables?.tables ?? []) {
      found.set(keyOf("table", table.name), {
        kind: "table",
        ref: table.name,
        title: table.name,
        summary: table.summary,
        open: () => void openFigure("table", table.name, table.name, table.summary),
      });
    }

    for (const row of resources ?? []) {
      // Keyed by the **reference id**, which is what a note stores — not the file's, which is a
      // different id answering a different question.
      found.set(keyOf("resource", row.id), resourceDetail(row));
    }

    details.value = found;
  }

  /**
   * A reference, opened the way the library opens one.
   *
   * Through `openResourceFile` rather than `openFile`, and that is the whole of why a resource
   * note can have a 查看详情 at all: a reference is addressed by **id**, not by a path, so the
   * file tree's entry point cannot reach it. A web page has no file to preview and so no control,
   * which is stated here rather than in the chip.
   */
  function resourceDetail(row: WorkResource): NoteTargetDetail {
    const isFile = row.resourceType === "file";
    return {
      kind: "resource",
      ref: row.id,
      title: resourceName(row),
      summary: row.summary ?? "",
      open: isFile ? () => void store.openResourceFile(row) : null,
    };
  }

  function detailFor(note: Note): NoteTargetDetail | null {
    if (note.targetKind === "text" || note.targetRef === null) return null;
    return details.value.get(keyOf(note.targetKind, note.targetRef)) ?? null;
  }

  return { load, detailFor, details };
}
