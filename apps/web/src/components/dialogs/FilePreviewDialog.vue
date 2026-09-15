<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { formatBytes } from "../../utils/format";
import { highlightFile, renderMarkdown } from "../../utils/markdown";
import Icon from "../Icon.vue";
import MermaidDiagram from "../MermaidDiagram.vue";
import DiagramDialog from "./DiagramDialog.vue";

/**
 * A file's contents, read-only.
 *
 * A dialog rather than a pane, because the sidebar it is opened from is 272px wide and the
 * content it shows is prose and code. `Teleport` to `body` is not a preference here — on a
 * compact viewport the sidebar is a fixed-position element inside a transform, so an overlay
 * left in place would be laid out in the off-canvas panel and render off-screen. See
 * `ConfirmDialog`, which this deliberately mirrors down to the window-level Escape listener.
 *
 * The rendering is chosen by `kind` from the server rather than by the extension here: text is
 * syntax-highlighted into a `<pre>`, Markdown goes through the same renderer the messages use
 * (so `html: false` is what keeps a file from injecting markup), a diagram is drawn, and
 * anything else gets the file's name and size with a note that the format is not previewable
 * yet. The choice is the `view` computed's exhaustive `switch` — see its comment for why that
 * matters more than it looks.
 *
 * It reads **either root**: a workspace file, from the tree, or one of a conversation's own
 * files, from the diagram widget. `store.filePreviewRoot` is which, and it exists because the
 * dialog is always mounted and only ever sees the store.
 *
 * Markdown gets both views rather than one, because they answer different questions: reading
 * a document wants it rendered, and reading what the agent *wrote* wants the source. The
 * source view is also the only place Markdown's own highlighting appears.
 */

const { t } = useI18n();
const store = useAppStore();

const content = computed(() => store.fileContent);
const name = computed(() => content.value?.name ?? basename(store.filePreviewPath ?? ""));
const meta = computed(() => (content.value ? formatBytes(content.value.size) : ""));

/**
 * Which of a kind's two views is showing — the rendered one, or the source behind it.
 *
 * Named for the choice rather than for Markdown, because diagrams make the same one: both
 * kinds have something to look at and something that was written. Files with only one view
 * ignore it. Reset for each file; see the watcher below.
 */
const viewMode = ref<"rendered" | "source">("rendered");

/**
 * Whether the enlarged viewer is open over this dialog.
 *
 * A second overlay rather than replacing the preview: the preview is the file at the size the
 * dialog is, and the viewer is the same picture with room and a zoom. Closing the viewer puts
 * the reader back where they were rather than at the end of the file list.
 */
const viewingDiagram = ref(false);

/** A `FileContentKind` this build cannot render. Unreachable, and the point is the compiler. */
function unhandled(kind: never): never {
  throw new Error(`Unhandled file preview kind: ${String(kind)}`);
}

/**
 * Which of the body's renderings is showing.
 *
 * A closed union resolved by an exhaustive `switch`, rather than the chain of `v-else-if`s
 * this used to be. That chain is what to watch for: its last branch was
 * `<pre v-else-if="content">`, so a member added to `FileContentKind` compiled cleanly and
 * rendered as highlighted source — plausible-looking, and wrong. `diagram` is how that was
 * found: the server could classify a `flow.mmd` as a diagram and the dialog would have shown
 * mermaid source as code. The `switch` below is where `unhandled` turns the next member into
 * a `vue-tsc` error, which is what `FILE_CONTENT_KINDS`' own doc-comment promises and what
 * was only true of sites that happened to switch.
 */
type FileView =
  | "loading"
  | "error"
  | "unsupported"
  | "markdown"
  | "markdown-source"
  | "text"
  | "diagram"
  | "diagram-source";

const view = computed<FileView>(() => {
  // Both precede the kind: a file whose read failed has no `kind` yet, and the failure has one
  // home — the body of the dialog the user just asked for.
  if (store.fileContentLoading) return "loading";
  if (store.filePreviewError) return "error";

  const loaded = content.value;
  if (!loaded) return "loading";

  switch (loaded.kind) {
    case "unsupported":
      return "unsupported";
    case "markdown":
      return viewMode.value === "rendered" ? "markdown" : "markdown-source";
    case "text":
      return "text";
    case "diagram":
      // A diagram has the same two views as Markdown, and for the same two reasons: reading it
      // wants the picture, and checking what was actually written — or copying it to paste
      // somewhere — wants the source.
      return viewMode.value === "rendered" ? "diagram" : "diagram-source";
    default:
      return unhandled(loaded.kind);
  }
});

/** Whether this kind has a rendered view and a source view to choose between. */
const hasTwoViews = computed(() => view.value.startsWith("markdown") || view.value.startsWith("diagram"));

const rendered = computed(() =>
  content.value?.kind === "markdown" && content.value.text !== null
    ? renderMarkdown(content.value.text)
    : ""
);

/**
 * The text as highlighted HTML, whatever the file is — plain text and Markdown source alike.
 *
 * An unknown language comes back escaped rather than coloured, so one `v-html` serves both
 * cases and neither can render the file as markup. `highlightFile` is what escapes.
 */
const highlighted = computed(() => {
  const loaded = content.value;
  if (!loaded || loaded.text === null) return "";
  return highlightFile(loaded.text, loaded.name);
});

/** `"notes/a.md"` → `"a.md"`. The server sends the name too; this covers the loading state. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  store.closeFile();
}

/*
 * On `window`, like `ConfirmDialog`: the overlay is not focusable, so key events never reach
 * it. `App.vue`'s drawer handler returns early while this dialog is open — otherwise one
 * Escape would close the dialog *and* the drawer underneath it.
 */
watch(
  () => store.filePreviewPath,
  (open) => {
    // The viewer belongs to the diagram that opened it, so it goes on both halves of a
    // change of file — opening the next one, and closing this one.
    viewingDiagram.value = false;
    if (open) {
      // Each file starts rendered: the view is a property of what is on screen, not a
      // preference, and carrying "source" onto the next Markdown file would be a mode the
      // user never asked for.
      viewMode.value = "rendered";
      window.addEventListener("keydown", onKeydown);
    } else {
      window.removeEventListener("keydown", onKeydown);
    }
  }
);

onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.filePreviewPath"
      class="modal-overlay"
      data-testid="file-preview"
      @click.self="store.closeFile()"
    >
      <div class="modal lg">
        <div class="modal-head">
          <div class="file-title">
            <h3 class="truncate" :title="store.filePreviewPath">{{ name }}</h3>
            <!-- The path, then the size once it is known. The `·` is the list separator the
                 copy is built from, not an icon. -->
            <span class="file-meta truncate">
              <span>{{ store.filePreviewPath }}</span>
              <template v-if="meta"><span> · </span><span>{{ t("files.preview.size") }} {{ meta }}</span></template>
            </span>
          </div>
          <!-- Markdown and diagrams: the two formats with something to look at *and*
               something that was written. A segmented control rather than two buttons,
               because it is one choice — see `.segmented` in
               the sheet for why the shared track is the whole point. `aria-pressed` is both
               what a reader announces and what the sheet paints the selected segment from. -->
          <div
            v-if="hasTwoViews"
            class="segmented"
            role="group"
            :aria-label="t('files.preview.viewLabel')"
          >
            <button
              class="segment"
              data-testid="file-preview-rendered"
              :aria-pressed="viewMode === 'rendered'"
              @click="viewMode = 'rendered'"
            >
              {{ t("files.preview.rendered") }}
            </button>
            <button
              class="segment"
              data-testid="file-preview-source"
              :aria-pressed="viewMode === 'source'"
              @click="viewMode = 'source'"
            >
              {{ t("files.preview.source") }}
            </button>
          </div>

          <button
            class="icon-btn"
            data-testid="file-preview-close"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="store.closeFile()"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body file-body" data-testid="file-preview-body">
          <p v-if="view === 'loading'" class="file-note" data-testid="file-preview-loading">
            {{ t("files.preview.loading") }}
          </p>

          <!-- The dialog stays open with the reason: it was opened deliberately, and closing
               it on a failure would leave the click looking like it did nothing. -->
          <p v-else-if="view === 'error'" class="file-note error" data-testid="file-preview-error">
            {{ store.filePreviewError }}
          </p>

          <div
            v-else-if="view === 'unsupported'"
            class="file-unsupported"
            data-testid="file-preview-unsupported"
          >
            <Icon name="file" size="2em" />
            <p>{{ t("files.preview.unsupported") }}</p>
            <p class="hint">{{ t("files.preview.unsupportedHint") }}</p>
          </div>

          <div v-else-if="view === 'markdown'" class="markdown" v-html="rendered"></div>

          <div v-else-if="view === 'diagram'" class="diagram-host">
            <div class="diagram-stage" data-testid="file-preview-diagram">
              <MermaidDiagram :source="content?.text ?? ''" />
            </div>
            <!-- The same viewer the conversation's card opens, so the zoom exists once. The
                 preview is the middle view — the file at the size the dialog is — and this is
                 the way to the one that can be scrolled and zoomed. -->
            <button
              class="btn small diagram-expand"
              data-testid="file-preview-diagram-expand"
              @click="viewingDiagram = true"
            >
              <Icon name="expand" />
              {{ t("diagram.expand") }}
            </button>
          </div>

          <DiagramDialog
            v-if="viewingDiagram && content?.text"
            :source="content.text"
            :name="name"
            @close="viewingDiagram = false"
          />

          <!-- The source of a diagram, which is what the segmented control switches to. The
               same `<pre>` a text file gets, so a mermaid source is highlighted and selectable
               like any other code the agent wrote. -->
          <pre
            v-else-if="view === 'diagram-source'"
            class="hljs file-text"
            data-testid="file-preview-diagram-source"
          ><code v-html="highlighted"></code></pre>

          <!-- `hljs` on the `<pre>`, not on the `<code>`, matching what the message renderer
               emits — the token colours key off the class either way, and the vendor's
               `pre code.hljs { padding }` rule is what adding it to the code element would
               wake up. `highlightFile` escapes, so this `v-html` carries nothing live. -->
          <pre
            v-else-if="view === 'text' || view === 'markdown-source'"
            class="hljs file-text"
            data-testid="file-preview-text"
          ><code v-html="highlighted"></code></pre>

          <p
            v-if="content && content.truncated"
            class="file-note"
            data-testid="file-preview-truncated"
          >
            {{ t("files.preview.truncated", { size: formatBytes(content.size) }) }}
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.file-title {
  min-width: 0;
}
.file-title h3 {
  margin: 0;
}
.file-meta {
  display: block;
  color: var(--text-3);
  font-size: var(--fs-2);
}
/* The body scrolls rather than the dialog, so the header stays put on a long file. */
.file-body {
  overflow: auto;
  max-height: 70vh;
}
/* The stage is `.diagram-stage` from the global sheet — global because the SVG arrives through
   `v-html` and a scoped rule would not reach it. Only the button under it is this dialog's. */
.diagram-host {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  align-items: flex-end;
}
.diagram-host .diagram-stage {
  align-self: stretch;
}
/* Pre-formatted, and the one place a horizontal scrollbar is the right answer: wrapping code
   would renumber the lines the reader is looking at. */
.file-text {
  margin: 0;
  padding: var(--space-6);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--code-bg);
  color: var(--code-fg);
  font-size: var(--fs-3);
  line-height: var(--lh-base);
  white-space: pre;
  overflow-x: auto;
}
/* The vendor sheet colours `pre code.hljs` and pads it; our markup puts the class on the
   `<pre>`, so the inner element needs its own reset. The same rule `.markdown pre code`
   carries, for the same block. */
.file-text code {
  background: transparent;
  border: none;
  padding: 0;
}
/* Pushed to the end of the dialog's head, beside the close button — a layout nudge that
   belongs to this dialog, so the shared control stays free of where it happens to sit. */
.segmented {
  margin-left: auto;
  margin-right: var(--space-4);
  flex-shrink: 0;
}
.file-unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-10) var(--space-8);
  color: var(--text-3);
  text-align: center;
}
.file-unsupported p {
  margin: 0;
}
.file-unsupported .hint {
  font-size: var(--fs-2);
}
.file-note {
  margin: 0;
  padding: var(--space-5) 0;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.file-note.error {
  color: var(--danger-text);
}
</style>
