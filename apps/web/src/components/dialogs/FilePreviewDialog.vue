<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { isNarrow } from "../../composables/breakpoints";
import { codeCopyClick } from "../../composables/codeCopy";
import { canAnnotate, objectNoteRequest } from "../../composables/notes";
import { requestNoteEditor } from "../../composables/messageNotes";
import { isOpenableUrl, openExternal } from "../../utils/externalLink";
import { formatBytes } from "../../utils/format";
import { highlightFile, renderMarkdown } from "../../utils/markdown";
import Icon from "../Icon.vue";
import CopyButton from "../CopyButton.vue";
import FileViewer from "../FileViewer.vue";
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
 * everything the server calls `binary` is handed to `FileViewer` — which decides for itself
 * whether the format can be drawn, and says so plainly when it cannot. The choice is the `view`
 * computed's exhaustive `switch` — see its comment for why that matters more than it looks.
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
  | "markdown"
  | "markdown-source"
  | "text"
  | "diagram"
  | "diagram-source"
  | "binary";

const view = computed<FileView>(() => {
  // Both precede the kind: a file whose read failed has no `kind` yet, and the failure has one
  // home — the body of the dialog the user just asked for.
  if (store.fileContentLoading) return "loading";
  if (store.filePreviewError) return "error";

  const loaded = content.value;
  if (!loaded) return "loading";

  switch (loaded.kind) {
    case "markdown":
      return viewMode.value === "rendered" ? "markdown" : "markdown-source";
    case "text":
      return "text";
    case "diagram":
      // A diagram has the same two views as Markdown, and for the same two reasons: reading it
      // wants the picture, and checking what was actually written — or copying it to paste
      // somewhere — wants the source.
      return viewMode.value === "rendered" ? "diagram" : "diagram-source";
    case "binary":
      // Naming the viewer's case rather than a concrete rendering: whether *anything* can be
      // drawn is `FileViewer`'s to answer, from the file name and then from the library. Keeping
      // it out of here is what lets `view` stay a pure function of `kind` — the alternative is a
      // third input (an async support probe) and `unsupported` coming back into this union,
      // which is the state the server used to guess at and no longer does.
      return "binary";
    default:
      return unhandled(loaded.kind);
  }
});

/** Whether this kind has a rendered view and a source view to choose between. */
const hasTwoViews = computed(() => view.value.startsWith("markdown") || view.value.startsWith("diagram"));

/**
 * Whether what is on screen is a *page* — and so whether there is an original to go and look at.
 *
 * The preview of a page source shows the app's stored copy of the reading. Somebody who wants the
 * page itself is standing in exactly this dialog, which is why the control belongs in its header
 * as well as on the two lists: the lists are where a page is *found*, and this is where it is
 * *open*. Gated on the URL the route attaches, so every other file has no control at all rather
 * than a disabled one.
 */
const pageUrl = computed(() => (isOpenableUrl(content.value?.url) ? content.value!.url! : null));

function openPage(): void {
  if (pageUrl.value) void openExternal(pageUrl.value);
}

/**
 * Write a note about the file on screen.
 *
 * Anchored to the file's **reference**, which is the one handle the notes API accepts for a
 * piece of material — the file's own id is a different thing and the create refuses it. The route
 * resolves the path to that reference and puts its title and summary on the reply, which is what
 * the note's 标注原文 is built from; without it a note about `main.rs` would quote a uuid.
 *
 * **It closes the preview first**, which this used to argue against and was wrong about. The note
 * window is a floating card rendered by `ChatView`, so it lives at `--z-window` — *below*
 * `--z-preview`, the layer this dialog deliberately sits at because it is the one opened *from*
 * things. The card was therefore painted underneath the dialog that had just opened it, with its
 * own controls unreachable — the same failure `--z-confirm` was added for, one layer down.
 *
 * Closing loses nothing that matters: the file is one press away, because the note window now
 * draws its 标注对象 as a control that opens exactly this. That is `DiagramDialog`'s answer to the
 * same problem, and the two arrived at it from the same place.
 */
function noteAboutFile(): void {
  const reference = content.value?.reference;
  if (!reference) return;
  const request = objectNoteRequest({
    kind: "resource",
    ref: reference.id,
    label: reference.title,
    summary: reference.summary ?? reference.title,
  });
  if (!request) return;
  store.closeFile();
  requestNoteEditor(request);
}

/**
 * Whether the dialog is filling the viewport.
 *
 * Local state rather than a store field or a persisted preference: it is a property of *this*
 * look at *this* file, and the watcher above clears it on both halves of a change of file. What
 * warrants it is that a preview is often the thing you actually came for — a PDF, a large image,
 * a wide table — and the default `--modal-lg` is 720px of a 1600px screen.
 */
const maximized = ref(false);

/**
 * Whether the control is offered at all.
 *
 * Hidden under the `narrow` breakpoint, where `.modal` is already a full-width bottom sheet sized
 * to `92dvh` — so the control could only be a no-op, and a control that renders but does nothing
 * is worse than no control. `isNarrow` rather than a local media query: the sheet spells the same
 * breakpoint in CSS, and `utils/breakpoints` is where the two are held in step.
 */
const canMaximize = computed(() => !isNarrow.value);

/** The words `renderMarkdown` bakes into a code block's copy control. */
const markdownLabels = computed(() => ({
  copy: t("common.copy"),
  copied: t("common.copied"),
}));

const rendered = computed(() =>
  content.value?.kind === "markdown" && content.value.text !== null
    ? renderMarkdown(content.value.text, markdownLabels.value)
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
    /*
     * And so does the *size*. The dialog is always mounted (`App.vue` has no `v-if` on it), so a
     * `maximized` left true would open the next file full-screen — a mode nobody asked for, in a
     * dialog that only looks like it was reopened.
     */
    maximized.value = false;
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
      class="modal-overlay preview-overlay"
      data-testid="file-preview"
      @click.self="store.closeFile()"
    >
      <div class="modal lg" :class="{ maximized }">
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
          <!--
            Two groups at the right-hand end, and the *split* is the point.

            The head is a plain `space-between` row, so six siblings would have spread themselves
            evenly across it — the file's name, then five controls at no particular distances from
            each other. Grouping them is what makes the row read as the convention it is: the name
            on the left, and everything you can *do* to the right of it.

            What the two groups separate is **what they act on**. The first is the file — what you
            are looking at, and what you can take out of it; the second is the box holding it,
            which is what a window's controls have always been. That is why the maximize button
            belongs with the close button rather than with the copy button: they are both about
            the dialog, and only one of them is about the document.
          -->
          <div class="file-actions">
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

            <!--
              The whole file, in one press. Only for the kinds that *are* text: a PDF's bytes are
              not something the clipboard should receive, and the viewer for those has its own
              controls. The tooltip changes when the server sent only the head of the file, which
              is the one case where "copy" would otherwise overstate what was copied — the note
              under the text says it too, but the button is what travels to the clipboard.
            -->
            <CopyButton
              v-if="content?.text !== null && content?.text !== undefined"
              :value="content.text"
              :hint="content.truncated ? t('sources.copyFilePartial') : t('sources.copyFile')"
              testid="file-preview-copy"
            />

            <button
              v-if="pageUrl"
              class="icon-btn"
              data-testid="file-preview-browser"
              :title="t('sources.openInBrowser')"
              :aria-label="t('sources.openInBrowser')"
              @click="openPage"
            >
              <Icon name="link" />
            </button>

            <!-- Beside the other conversation-scoped actions, and absent rather than disabled
                 when either half of the capability is missing: no notes widget is installed, or
                 this file is held by no reference for the note to anchor to. A control that
                 renders and does nothing is the failure this repository names most often. -->
            <button
              v-if="canAnnotate && content?.reference"
              class="icon-btn"
              data-testid="file-preview-note"
              :title="t('notes.annotate')"
              :aria-label="t('notes.annotate')"
              @click="noteAboutFile"
            >
              <Icon name="marker" />
            </button>
          </div>

          <!-- The window's own two: growing the box, and closing it. Maximise first, close
               last — the order a window's controls have had for forty years, and the one that
               keeps the dismiss control in the corner where the pointer already is. -->
          <div class="window-actions">
            <button
              v-if="canMaximize"
              class="icon-btn"
              data-testid="file-preview-maximize"
              :aria-pressed="maximized"
              :title="maximized ? t('files.preview.restore') : t('files.preview.maximize')"
              :aria-label="maximized ? t('files.preview.restore') : t('files.preview.maximize')"
              @click="maximized = !maximized"
            >
              <Icon :name="maximized ? 'collapse' : 'expand'" />
            </button>

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
        </div>

        <div
          class="modal-body file-body"
          :class="{ 'file-body-filled': view === 'binary' }"
          data-testid="file-preview-body"
        >
          <p v-if="view === 'loading'" class="file-note" data-testid="file-preview-loading">
            {{ t("files.preview.loading") }}
          </p>

          <!-- The dialog stays open with the reason: it was opened deliberately, and closing
               it on a failure would leave the click looking like it did nothing. -->
          <p v-else-if="view === 'error'" class="file-note error" data-testid="file-preview-error">
            {{ store.filePreviewError }}
          </p>

          <!--
            Everything the server calls `binary`, handed to the viewer. Whether anything can be
            drawn — and the "this format is not previewable" panel when nothing can — is decided
            in there, because the answer depends on a plugin registry that lives in a lazily
            fetched chunk. The dialog has no opinion to offer and no chunk to consult.
          -->
          <FileViewer
            v-else-if="view === 'binary'"
            :file="store.filePreviewFile"
            :name="content?.name ?? name"
          />

          <div
            v-else-if="view === 'markdown'"
            class="markdown"
            v-html="rendered"
            @click="codeCopyClick"
          ></div>

          <div v-else-if="view === 'diagram'" class="diagram-host">
            <p v-if="content?.summary" class="diagram-summary" data-testid="file-preview-diagram-summary">
              <span class="diagram-summary-label">{{ t("diagram.summary") }}</span>
              {{ content.summary }}
            </p>
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
            :content="{ kind: 'diagram', source: content.text }"
            :name="name"
            :summary="content.summary"
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
/*
 * Above the dialogs that open it — see `--z-preview`. This is the layer opened *from* the file
 * tree, the source browser and a diagram row, and a dialog teleported into existence when it
 * opens would otherwise land after it in `body` and paint over it.
 */
.preview-overlay {
  z-index: var(--z-preview);
}

.file-title {
  min-width: 0;
}
.file-title h3 {
  margin: 0;
}
/*
 * The two groups of controls, at the right-hand end.
 *
 * `margin-left: auto` on the first rather than relying on the head's `justify-content:
 * space-between`: that rule is the global sheet's and is shared by every dialog, and it would
 * spread three children evenly — title, then a group in the middle, then another at the right.
 * Pinning the first group here rather than loosening the shared rule is also what keeps every
 * other dialog's head untouched.
 *
 * `flex: none` so neither group gives up room: the title is the part that can afford to be
 * truncated (`min-width: 0` and `.truncate` above), and a squeezed copy button would lose its
 * label before the file's name lost a character.
 */
.file-actions,
.window-actions {
  display: flex;
  align-items: center;
  flex: none;
}
.file-actions {
  gap: var(--space-4);
  margin-left: auto;
}
/*
 * The window's pair, set apart from the file's controls by more than any gap inside either —
 * which is the whole of what makes them read as two groups rather than one row of five. The
 * buttons themselves sit closer together than the file's do, because they are a pair in the way
 * a window's maximise and close have always been.
 */
.window-actions {
  gap: var(--space-2);
  margin-left: var(--space-8);
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
/*
 * Maximised: the dialog fills the viewport, and the body takes the room that is left.
 *
 * `.modal.lg.maximized` rather than `.modal.maximized`: the global sheet's `.modal.lg` sets the
 * width and has the same specificity as two classes, so this has to *outrank* it rather than
 * depend on which stylesheet the bundler put last. `border-radius: 0` because a rounded box that
 * touches all four edges reads as a mistake.
 */
.modal.lg.maximized {
  width: 100vw;
  height: 100dvh;
  max-width: none;
  max-height: none;
  border-radius: 0;
}
.modal.lg.maximized .file-body {
  max-height: none;
  flex: 1;
  /* A flex child will not shrink below its content without this, which would push the body out
   * of the dialog rather than scrolling inside it. */
  min-height: 0;
}
/*
 * And the viewer's box, which asks for a *definite* height. `auto` here would hand the library a
 * zero-height container and it would draw nothing at all — silently, which is the failure
 * `.file-body-filled`'s own comment exists to prevent. `flex: 1` resolves to a used height, so
 * the viewer still measures something.
 */
.modal.lg.maximized .file-body-filled {
  height: auto;
  flex: 1;
}
/*
 * The viewer's case, and it is a different box rather than the same one with a tweak.
 *
 * The library measures its container, so a `height: auto` parent hands it zero and it draws
 * nothing at all — silently, which is the failure this rule exists to prevent. A definite
 * height is required, in a flex column, so the viewer's root can fill it.
 *
 * `overflow: hidden` for the same kind of reason: the viewer scrolls and zooms its own content,
 * so the body's `auto` would wrap a second scrollbar around the first one.
 */
.file-body-filled {
  display: flex;
  flex-direction: column;
  height: 70vh;
  overflow: hidden;
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
.diagram-summary {
  align-self: stretch;
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-3);
  line-height: 1.5;
}
.diagram-summary-label {
  color: var(--text-3);
  margin-right: var(--space-2);
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
/*
 * And the children of both hold theirs, for the reason one level up again — a constricted flex
 * line would clip the segmented control's labels and the copy button's icon before it would touch
 * the title, and the title is the part that can afford to truncate.
 *
 * This replaced a `margin-left: auto; margin-right: var(--space-4)` nudge on `.segmented` alone —
 * its job was pinning that one control to the right-hand end, which the groups now do for all of
 * them, and its margin was the odd 16px gap in an otherwise even row.
 */
.file-actions > *,
.window-actions > * {
  flex: none;
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
