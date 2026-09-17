<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../api/types";
import CopyButton from "./CopyButton.vue";
import Icon from "./Icon.vue";
import { renderMarkdown } from "../utils/markdown";
import { tableHtmlForClipboard } from "../utils/tableClipboard";

/**
 * `ila_table`'s call, as a line — **not** as the table.
 *
 * The table itself is in the reply, written out as ordinary Markdown by the model, and that is
 * the requirement rather than an accident of layout: a reader meets a table in the prose it
 * belongs to, not inside a tool call. This card exists for three things the conversation still
 * needs from the call, and its docblock says them so the next reader does not delete it as
 * redundant:
 *
 * - **定位**. The panel's 定位 button emits `chat.jump`, which targets `[data-tool-call-id]` —
 *   and that attribute is on every card, including the generic one, so this is not strictly why.
 *   What *is* why is the next item.
 * - **The generic card would show the table twice, in the wrong place.** Its disclosure renders
 *   `JSON.stringify(args, null, 2)` under "参数", so the whole markdown would be readable in a
 *   fold — a table inside a tool container, which is the one shape the feature rules out. This
 *   card shows a name, the summary, and a disclosure of the source that a reader has to ask for.
 * - The copy control, which belongs where the table is registered rather than where it is read.
 *
 * So it is deliberately quiet: one line, no drawing, no rendering of the content. The mark is the
 * 表 half of the 图表 icon set, so a conversation's cards and its panel say the same word.
 *
 * It is **not** an interactive card and must never be added to `INTERACTIVE_TOOL_NAMES`, whose
 * meaning is "suspends the turn": the server routes submitted answers by that list and
 * `MessageItem` groups calls by it. A table suspends nothing. See `DiagramCard`, its sibling.
 */

const props = defineProps<{ toolCall: ToolCall }>();

const { t, te } = useI18n();

/** The shared `tools.name.*` namespace, resolved the same way the generic card does. */
const label = computed(() => {
  const key = "tools.name." + props.toolCall.name;
  return te(key) ? t(key) : props.toolCall.name;
});

const done = computed(() => props.toolCall.output !== undefined);

/**
 * The call's arguments, parsed once. Malformed JSON renders as nothing rather than throwing.
 *
 * `table`, never `content` — and the tool's schema names it that way for this reason among
 * others: the generic card's head previews `content` as one of its own keys, so a table arriving
 * under that name would print eighty characters of markdown in a card header.
 */
const args = computed<{ name?: unknown; table?: unknown; summary?: unknown }>(() => {
  try {
    return JSON.parse(props.toolCall.input) as {
      name?: unknown;
      table?: unknown;
      summary?: unknown;
    };
  } catch {
    return {};
  }
});

const name = computed(() => (typeof args.value.name === "string" ? args.value.name : ""));
const markdown = computed(() => (typeof args.value.table === "string" ? args.value.table : ""));
const summary = computed(() =>
  typeof args.value.summary === "string" ? args.value.summary : ""
);

/**
 * Whether the call itself failed — an empty table, one past the cap, or one that is not a table.
 * The loop writes all three as `Tool error: …`, and there is nothing to register in that case, so
 * the card shows the model's own refusal rather than a row that claims to be one.
 */
const failed = computed(() => (props.toolCall.output ?? "").startsWith("Tool error:"));

/** The source disclosure. Closed by default: this card is an index, not a reading surface. */
const open = ref(false);

/** What the copy control writes. The markdown is the table; the markup is for a document. */
const markdownLabels = computed(() => ({ copy: t("common.copy"), copied: t("common.copied") }));
const html = computed(
  () => tableHtmlForClipboard(renderMarkdown(markdown.value, markdownLabels.value)) ?? markdown.value
);
</script>

<template>
  <div class="table-card" data-testid="table-card" :data-tool-call-id="toolCall.id">
    <div class="table-head" data-testid="table-head" @click="open = !open">
      <Icon name="table" class="mark" />
      <span class="name">{{ label }}</span>
      <!-- The row's canonical name, which is what the panel lists and what a revise reuses. The
           model's own label is that name only after slugifying, so the card shows the slug: it is
           the identity a later call has to match. -->
      <span class="file truncate" :title="name">{{ name }}</span>
      <span class="status">{{ done ? t("tools.done") : t("tools.running") }}</span>
      <!-- The table is *in the reply*; this says so rather than repeating it. A reader who
           expected a frame here would otherwise think the tool had shown them nothing. -->
      <span class="hint" :title="t('tools.table.inlineHint')">{{ t("tools.table.inlineHint") }}</span>
      <CopyButton v-if="!failed && markdown" class="copy" testid="table-copy" :value="markdown" :html="html" />
      <Icon class="toggle" :name="open ? 'caret-down' : 'caret-right'" />
    </div>

    <div v-if="failed" class="table-failed" data-testid="table-failure">
      {{ props.toolCall.output }}
    </div>

    <template v-else>
      <p v-if="summary" class="table-summary">{{ summary }}</p>

      <div v-if="open" class="table-source">
        <div class="key">{{ t("diagram.source") }}</div>
        <pre><code>{{ markdown }}</code></pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.table-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: hidden;
}
.table-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  font-size: var(--fs-3);
}
.table-head:hover {
  background: var(--panel-2);
}
.table-head .mark {
  flex: none;
  color: var(--text-3);
}
.table-head .name {
  color: var(--text);
  flex: none;
}
.table-head .file {
  min-width: 0;
  color: var(--text-3);
}
.table-head .status {
  margin-left: auto;
  flex: none;
  color: var(--text-3);
}
/* The one sentence this card exists to say. Quiet, and there rather than in a tooltip only:
   a chip that has to be hovered is a chip nobody reads on a tablet. */
.table-head .hint {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.table-head .copy {
  flex: none;
}
.table-head .toggle {
  flex: none;
  color: var(--text-3);
}
.table-summary {
  margin: 0;
  padding: 0 var(--space-4) var(--space-3);
  color: var(--text-2);
  font-size: var(--fs-3);
  line-height: 1.5;
}
.table-failed {
  padding: 0 var(--space-4) var(--space-3);
  color: var(--danger-text);
  font-size: var(--fs-3);
}
.table-source {
  padding: 0 var(--space-4) var(--space-4);
}
.table-source .key {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin-bottom: var(--space-2);
}
.table-source pre {
  margin: 0;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--code-bg);
  color: var(--code-fg);
  font-size: var(--fs-2);
  overflow-x: auto;
}
</style>
