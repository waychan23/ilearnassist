<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../api/types";
import { canAnnotate, objectNoteRequest } from "../composables/notes";
import { requestNoteEditor } from "../composables/messageNotes";
import { useAppStore, type FileRoot } from "../stores/app";
import { highlightFile } from "../utils/markdown";
import { formatBytes } from "../utils/format";
import CopyButton from "./CopyButton.vue";
import Icon from "./Icon.vue";

/**
 * `write_file`'s call, as the file it wrote.
 *
 * The complaint this answers is exact: the agent writes a Rust source file and then repeats the
 * whole of it as an inline code block, so a 200-line file takes 200 lines of the conversation
 * twice. A card is the answer the diagram already gives — the *artifact* is shown, not its text —
 * and the other half of it is the prompt: without `chat.guidance.fileWrite` the model still
 * pastes, and the card would be a third copy rather than the only one.
 *
 * **A header, a preview and a way in**, rather than the whole file folded up. A 500-line source
 * file rendered inside a bubble is still 500 lines of page, and the conversation is a place to
 * read an answer in; the preview is enough to recognise the file by, and the open control is where
 * reading it belongs. `FilePreviewDialog` already does that properly, with the viewer chunk, the
 * highlighting and the copy control.
 *
 * It is deliberately **not** one of the interactive cards and must never be added to
 * `INTERACTIVE_TOOL_NAMES`: that list means "suspends the turn". Its dispatch sits in
 * `ToolCallCard` beside the diagram's, for the diagram's reason.
 */

/** The lines shown before the fold. Enough to recognise a file, not enough to be the file. */
const PREVIEW_LINES = 20;

const props = defineProps<{ toolCall: ToolCall }>();

const { t, te } = useI18n();
const store = useAppStore();

/** The shared `tools.name.*` namespace, resolved the same way the generic card does. */
const label = computed(() => {
  const key = "tools.name." + props.toolCall.name;
  return te(key) ? t(key) : props.toolCall.name;
});

/** The call's arguments, parsed once. Malformed JSON renders as nothing rather than throwing. */
const args = computed<{ path?: unknown; content?: unknown; location?: unknown }>(() => {
  try {
    return JSON.parse(props.toolCall.input) as Record<string, unknown>;
  } catch {
    return {};
  }
});

const path = computed(() => (typeof args.value.path === "string" ? args.value.path : ""));
const content = computed(() => (typeof args.value.content === "string" ? args.value.content : ""));

/**
 * Whether the call itself failed.
 *
 * The loop writes a refusal as `Tool error: …` in the output. There is no file to show in that
 * case and no content worth previewing, so the card shows the model's own refusal — the sentence a
 * reader needs, where the alternative is an empty frame.
 */
const failed = computed(() => (props.toolCall.output ?? "").startsWith("Tool error:"));

/**
 * Which sandbox the file landed in, and which reference it became.
 *
 * Both are read out of the **tool's own result**, which is the only place that knows them: the
 * `location` argument is optional, so a call that omitted it was resolved by the write-location
 * chain, and the reference id is made by the registry after the bytes are on disk. The sentence is
 * a contract with `fileTools.ts` — see the note there — so it is parsed once here rather than
 * guessed at from the arguments.
 */
const written = computed(() => props.toolCall.output ?? "");
const root = computed<FileRoot>(() =>
  /in the workspace folder/.test(written.value)
    ? "workspace"
    : /in the session folder/.test(written.value)
      ? "session"
      : // No result yet, or one that does not name a folder: the argument is the next best
        // answer, and `session` is the product default — the same chain the write itself took.
        args.value.location === "workspace"
        ? "workspace"
        : "session"
);
const referenceId = computed(() => /\(id ([^)]+)\)/.exec(written.value)?.[1] ?? "");

/** The head of the file, and whether anything was dropped to get it. */
const lines = computed(() => content.value.split("\n"));
const preview = computed(() => lines.value.slice(0, PREVIEW_LINES).join("\n"));
const hidden = computed(() => Math.max(0, lines.value.length - PREVIEW_LINES));

/**
 * The preview, coloured by the one highlighter.
 *
 * `highlightFile` rather than a second call into `highlight.js`, and over the *sliced* text: the
 * preview is what is coloured, so a 40 000-line file costs the cap check rather than a tokenise.
 */
const previewHtml = computed(() =>
  path.value ? highlightFile(preview.value, path.value) : ""
);

const size = computed(() => new TextEncoder().encode(content.value).length);

/** The disclosure. Closed by default: the file is what this card is for. */
const open = ref(false);

/**
 * Show the whole file — in the preview dialog, at the root it was written into.
 *
 * The root matters and is why it is parsed rather than assumed: the same name in `workdir/` and in
 * a conversation's own folder is two different files, and opening the wrong one is a preview that
 * silently shows something else.
 */
function openFile(): void {
  if (path.value) void store.openFile(path.value, root.value);
}

/**
 * Write a note about the file this call wrote.
 *
 * Anchored to the **reference** the write created, not to the path — the notes API addresses
 * material by reference id, and a path is not one. That id is in the tool's result, which is what
 * makes this button possible at all; a file the agent did not just write has no card and no
 * reference here, and is annotated from the preview dialog instead.
 */
function noteAbout(): void {
  if (!referenceId.value) return;
  const request = objectNoteRequest({
    kind: "resource",
    ref: referenceId.value,
    label: path.value,
  });
  if (request) requestNoteEditor(request);
}
</script>

<template>
  <div class="file-card" data-testid="file-card" :data-tool-call-id="toolCall.id">
    <div class="file-head" data-testid="file-head" @click="open = !open">
      <Icon name="file" class="mark" />
      <span class="name">{{ label }}</span>
      <span class="path truncate" :title="path">{{ path }}</span>
      <span class="size">{{ formatBytes(size) }}</span>

      <!--
        Open it properly. In the head rather than floating over the preview, so it is not on top
        of the text it is offering to show more of; `.stop` so it does not also toggle the
        disclosure underneath it.
      -->
      <button
        v-if="!failed"
        class="icon-btn"
        data-testid="file-open"
        :title="t('files.card.open')"
        :aria-label="t('files.card.open')"
        @click.stop="openFile"
      >
        <Icon name="expand" />
      </button>
      <!-- Beside it, and absent rather than disabled when either half is missing: no notes widget
           to render the window, or no reference for a note to anchor to. -->
      <button
        v-if="!failed && canAnnotate && referenceId"
        class="icon-btn"
        data-testid="file-note"
        :title="t('notes.annotate')"
        :aria-label="t('notes.annotate')"
        @click.stop="noteAbout"
      >
        <Icon name="marker" />
      </button>
      <Icon class="toggle" :name="open ? 'caret-down' : 'caret-right'" />
    </div>

    <div v-if="failed" class="file-failed" data-testid="file-failure">
      {{ toolCall.output }}
    </div>

    <template v-else>
      <!--
        The head of the file, not the file. Bounded the same way the diagram window is: the
        conversation is a place to read an answer in, and the open control is where reading a
        source belongs.
      -->
      <div v-if="open" class="file-preview" data-testid="file-preview">
        <pre class="hljs" v-html="previewHtml"></pre>
        <div v-if="hidden > 0" class="file-more">
          {{ t("files.card.moreLines", { count: hidden }) }}
        </div>
      </div>

      <div class="file-actions">
        <CopyButton :value="content" :hint="t('files.card.copy')" testid="file-copy" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  margin-bottom: var(--space-4);
  overflow: hidden;
}
.file-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  cursor: pointer;
  color: var(--text-2);
  font-size: var(--fs-3);
}
.file-head .mark {
  color: var(--accent);
  flex-shrink: 0;
}
.name {
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
}
.path {
  flex: 1;
  color: var(--text-3);
}
.size {
  font-size: var(--fs-2);
  white-space: nowrap;
}
.toggle {
  flex-shrink: 0;
}
.file-preview {
  border-top: 1px solid var(--border);
  max-height: 24rem;
  overflow: auto;
}
.file-preview pre {
  margin: 0;
  padding: var(--space-4);
  font-size: var(--fs-2);
  color: var(--code-fg);
}
.file-more {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: var(--fs-1);
}
.file-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border);
}
.file-failed {
  border-top: 1px solid var(--border);
  padding: var(--space-5);
  color: var(--danger-text);
  font-size: var(--fs-2);
}
</style>
