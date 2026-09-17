import { ref, type Ref } from "vue";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import type { FigureContent } from "../components/dialogs/DiagramDialog.vue";
import type { FigureTurnReference } from "../utils/turnRefs";

/**
 * Showing one 图 or 表, from wherever the reader pointed at it.
 *
 * Two panels now offer "open this figure" — the 图表 panel, on its own rows, and the notes panel,
 * on the chip that says what a note is about — and the two must not answer "how do I show a
 * figure" twice. The answer is genuinely different per kind, which is why it is worth having
 * once: a **diagram is a file** in the conversation's own folder, so it opens through the
 * ordinary file preview, exactly as a preview from the file tree does; a **table is a row** with
 * no file at all, so the only viewer is `DiagramDialog` and its markdown has to be fetched.
 *
 * That asymmetry is not an accident of this module — it is the shape `docs/tables.md` describes,
 * where the row *is* the content. A second implementation would be a second place for it to be
 * forgotten when a third kind of figure arrives.
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
   * Show the figure named `ref`.
   *
   * Resolves to nothing and reports nothing: a figure that cannot be found is a control the
   * caller should not have drawn — every caller knows whether its figure exists before it
   * offers one (`fileMissing`, `targetMissing`) — so this is the last line rather than a
   * user-facing failure. The dialog simply does not appear.
   */
  open(kind: "diagram" | "table", ref: string, label: string, summary?: string): Promise<void>;
  close(): void;
}

export function useFigureViewer(): FigureViewer {
  const store = useAppStore();
  const viewing = ref<PendingFigure | null>(null);

  async function open(
    kind: "diagram" | "table",
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
