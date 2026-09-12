<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { attachmentUrl } from "../api/client";
import { translateParseError } from "../utils/apiError";
import { formatBytes } from "../utils/format";
import type { Attachment } from "../api/types";
import Icon from "./Icon.vue";

/**
 * Chips for the files on a message, or staged in the composer.
 *
 * There is no `sessionId` here, unlike the name this used to carry: a chip's thumbnail is
 * addressed by the **source**, which is what owns the bytes. The same file referenced from two
 * conversations therefore resolves to one URL — which is also why its response can be cached
 * immutably.
 */
const props = defineProps<{
  attachments: Attachment[];
  /** Composer mode: shows a remove control on each chip. */
  removable?: boolean;
}>();

const emit = defineEmits<{ remove: [id: string]; reparse: [attachment: Attachment] }>();

const { t } = useI18n();

interface Chip {
  attachment: Attachment;
  url: string;
  /** Short line under the filename: size, or what extraction is doing. */
  detail: string;
  /** Tooltip for a failure — the chip itself only has room for a marker. */
  title: string;
}

/**
 * Attachment chips.
 *
 * A document chip's second line reports parse state rather than size: whether the model
 * can actually read the file is the thing the user needs to know before sending, and a
 * failed parse otherwise looks identical to a successful one until the answer goes wrong.
 */
function formatChars(chars: number | undefined): string {
  // Below 1000 the raw count is exact and honest; "0k characters" for a one-paragraph
  // document reads as "nothing was extracted".
  if (!chars) return "";
  if (chars < 1000) return t("attachments.chars", { count: chars }, chars);
  return t("attachments.charsK", { count: (chars / 1000).toFixed(1) });
}

function describe(a: Attachment): { detail: string; title: string } {
  const size = formatBytes(a.size);
  switch (a.parseStatus) {
    case "pending":
    case "parsing":
      return { detail: t("attachments.parsing"), title: t("attachments.parsingTitle") };
    case "ready": {
      const pages = a.pageCount
        ? `${t("attachments.pages", { count: a.pageCount }, a.pageCount)} · `
        : "";
      const from = a.parserId && a.parserId !== "local" ? ` · ${t("attachments.cloud")}` : "";
      const chars = formatChars(a.parsedChars);
      // Composed fragments rather than one interpolated sentence: the chip has no room for
      // a full sentence, and each part is a different unit for a translator.
      return {
        detail: [t("attachments.ready"), size, pages + chars + from].filter(Boolean).join(" · "),
        title: t("attachments.readyTitle"),
      };
    }
    case "failed":
      // The code is canonical; `parseError` is the server's own sentence, used when the
      // client meets a code it has no message for (an older build, a newer server).
      return {
        detail: `${size} · ${t("attachments.failed")}`,
        title:
          translateParseError(a.parseErrorCode, undefined, a.parseError) ||
          t("attachments.failed"),
      };
    default:
      return { detail: size, title: a.name };
  }
}

const chips = computed<Chip[]>(() =>
  props.attachments.map((a) => {
    const { detail, title } = describe(a);
    return { attachment: a, url: attachmentUrl(a.id), detail, title };
  })
);

/** CSS modifier for the chip's state, so failures read as failures at a glance. */
function stateOf(a: Attachment): string {
  if (a.parseStatus === "failed") return "failed";
  if (a.parseStatus === "pending" || a.parseStatus === "parsing") return "busy";
  return "";
}
</script>

<template>
  <div class="attachments">
    <div
      v-for="c in chips"
      :key="c.attachment.id"
      class="chip"
      :class="stateOf(c.attachment)"
      data-testid="attachment-chip"
      :title="c.title"
    >
      <img
        v-if="c.attachment.kind === 'image'"
        class="thumb"
        :src="c.url"
        :alt="c.attachment.name"
        :title="c.attachment.name"
      />
      <span v-else class="file-icon"><Icon name="file" /></span>
      <div class="meta">
        <span class="name truncate" :title="c.attachment.name">{{ c.attachment.name }}</span>
        <span class="size" data-testid="attachment-detail">{{ c.detail }}</span>
      </div>
      <button
        v-if="c.attachment.parseStatus === 'failed' && removable"
        class="icon-btn retry"
        :title="t('attachments.reparse')"
        :aria-label="t('attachments.reparse')"
        data-testid="attachment-reparse"
        @click="emit('reparse', c.attachment)"
      >
        <Icon name="retry" />
      </button>
      <button
        v-if="removable"
        class="icon-btn danger remove"
        :title="t('attachments.remove')"
        :aria-label="t('attachments.remove')"
        @click="emit('remove', c.attachment.id)"
      >
        <Icon name="close" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}
.chip {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px var(--space-4) 5px 5px;
  max-width: 260px;
}
/* A document still being read, and one that failed — both need to look different from
   a plain attachment, because the user's next action depends on which it is. */
.chip.busy .file-icon {
  opacity: 0.5;
}
.chip.failed {
  border-color: var(--warning);
}
.chip.failed .size {
  color: var(--warning);
}
.retry {
  font-size: var(--fs-3);
  padding: var(--space-1) 5px;
}
.thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--code-bg);
}
.file-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: var(--panel);
  flex-shrink: 0;
  /* Needed only since the glyph became an `<Icon>`: the emoji it replaced was painted
   * by the emoji font at its own size, so this box never had to state one. */
  font-size: var(--fs-6);
}
.meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name {
  font-size: var(--fs-2);
}
.size {
  font-size: var(--fs-1);
  color: var(--text-3);
}
.remove {
  font-size: var(--fs-1);
  padding: var(--space-1) var(--space-2);
}
</style>
