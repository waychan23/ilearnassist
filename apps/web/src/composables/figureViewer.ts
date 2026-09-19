import { ref, type Ref } from "vue";
import type { NoteTargetKindChoice } from "@ilearnassist/shared";
import { api } from "../api/client";
import { i18n } from "../i18n";
import { useAppStore } from "../stores/app";
import type { FigureContent } from "../components/dialogs/DiagramDialog.vue";
import type { FigureTurnReference } from "../utils/turnRefs";

/**
 * Showing one 图, 表 or 资料, from wherever the reader pointed at it.
 *
 * Three surfaces offer "open this figure" — the 图表 panel on its own rows, the notes panel on
 * the chip that says what a note is about, and the note **window** on the object it names — and
 * they must not answer "how do I show one" three times. The answer is genuinely different per
 * kind, which is why it is worth having once: a **diagram is a file** in the conversation's own
 * folder, so it opens through the ordinary file preview, exactly as a preview from the file tree
 * does; a **table is a row** with no file at all, so the only viewer is `DiagramDialog` and its
 * markdown has to be fetched; and a **reference** is neither — it is addressed by id, so the row
 * has to be read back before the file preview can be handed anything.
 *
 * That asymmetry is not an accident of this module — it is the shape `docs/tables.md` and
 * `docs/resources.md` describe. A second implementation would be a second place for it to be
 * forgotten when a fourth kind arrives.
 *
 * What the caller renders is `<DiagramDialog v-if="viewing" …>`; a diagram never sets `viewing`,
 * because it has already opened in the preview by then. That reads like a wart and is the honest
 * split: this returns the thing that still needs *drawing*, and a diagram does not.
 */

/** What still needs a dialog: the kinds that have no file to open. */
export interface PendingFigure {
  content: FigureContent;
  name: string;
  summary?: string;
  /**
   * The figure itself, as a turn reference — so the dialog can offer to ask about it.
   *
   * Carried rather than re-derived by the caller, because the caller is what *opened* the figure
   * and only it knows the handle: a note's target name, a panel row's file name, a call's own
   * argument. Re-deriving one from the label would be a second answer to "what is this figure
   * called" and would be wrong for exactly the names that are awkward.
   */
  figure: FigureTurnReference;
}

export interface FigureViewer {
  /** The table waiting to be drawn, or null. Diagrams never land here — see the docblock. */
  viewing: Ref<PendingFigure | null>;
  /**
   * Show the object named `ref`.
   *
   * Resolves to nothing and reports nothing **for a figure**: one that cannot be found is a
   * control the caller should not have drawn — every caller knows whether its figure exists
   * before it offers one (`fileMissing`, `targetMissing`) — so this is the last line rather than a
   * user-facing failure. The dialog simply does not appear.
   *
   * A **reference** is the kind that cannot be known in advance: it is a database row reached by
   * id, and both callers that offer one — the note window and the reference chip in a sent
   * message — hold only the id. So a lookup that fails there is reported, because a click that
   * did nothing at all is the outcome nobody can act on.
   *
   * The chip passes the two *figure* kinds through here as well, and it is not a caller that can
   * know in advance either — but it does not have to be: a diagram's handle is a file name and a
   * table's is a row's name, both read off a message that is still on screen, and neither the
   * `session_diagrams` row nor the `session_tables` one can go while that message lives.
   */
  open(
    kind: NoteTargetKindChoice,
    ref: string,
    label: string,
    summary?: string
  ): Promise<void>;
  close(): void;
}

export function useFigureViewer(): FigureViewer {
  const store = useAppStore();
  const viewing = ref<PendingFigure | null>(null);

  async function open(
    kind: NoteTargetKindChoice,
    ref: string,
    label: string,
    summary?: string
  ): Promise<void> {
    if (kind === "diagram") {
      // Missing files are refused before the click, not here — but the preview is also what a
      // reader would want if one appeared, so this does not re-check. See the docblock.
      void store.openFile(ref, "session");
      return;
    }

    if (kind === "resource") {
      /*
       * Read the reference back, because an id is all a note stores and the preview needs the
       * whole row. `openResourceFile` is the library's own entry point — it addresses the bytes
       * by the *file* id and the description by the *reference* id, which is the split a resource
       * has and a path does not.
       */
      try {
        const row = await api.getResource(ref);
        if (row.resourceType !== "file") {
          // A web page has no file to preview. Reported rather than silently ignored, for the
          // reason the figure arm is not: the reader pressed a control the app drew.
          store.setError(i18n.global.t("notes.target.notViewable"));
          return;
        }
        await store.openResourceFile(row);
      } catch (e) {
        store.setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    const sessionId = store.activeSessionId;
    if (!sessionId) return;
    try {
      const { tables } = await api.listSessionTables(sessionId);
      // By name, which is the only handle a note stores and the same one the panel and the
      // model use. A table is upserted on `(session_id, name)`, so there is at most one.
      const found = tables.find((table) => table.name === ref);
      if (!found) return;
      viewing.value = {
        content: { kind: "table", markdown: found.content },
        name: label,
        summary: summary ?? found.summary,
        // The *canonical* name off the row rather than the one that was asked for: it is what the
        // server normalised to, and therefore what a reference has to carry.
        figure: { kind: "table", ref: found.name, label },
      };
    } catch {
      // Swallowed, for the reason above: the reader asked to look at something the panel had
      // already told them exists, and a toast about a failed *look* is noise. Retrying is a
      // click they still have.
    }
  }

  return {
    viewing,
    open,
    close: () => {
      viewing.value = null;
    },
  };
}
