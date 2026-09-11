<script setup lang="ts">
import { computed } from "vue";
import { attachmentUrl } from "../api/client";
import { translateParseError } from "../utils/apiError";
import { formatBytes } from "../utils/format";
import type { Attachment } from "../api/types";

const props = defineProps<{
  sessionId: string;
  attachments: Attachment[];
  /** Composer mode: shows a remove control on each chip. */
  removable?: boolean;
}>();

const emit = defineEmits<{ remove: [id: string]; reparse: [attachment: Attachment] }>();

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
/** `0k 字符` for a one-paragraph document reads as "nothing was extracted". */
function formatChars(chars: number | undefined): string {
  if (!chars) return "";
  if (chars < 1000) return `${chars} 字符`;
  return `${(chars / 1000).toFixed(1)}k 字符`;
}

function describe(a: Attachment): { detail: string; title: string } {
  const size = formatBytes(a.size);
  switch (a.parseStatus) {
    case "pending":
    case "parsing":
      return { detail: "解析中…", title: "正在提取文本，完成后才能发送" };
    case "ready": {
      const pages = a.pageCount ? `${a.pageCount} 页 · ` : "";
      const from = a.parserId && a.parserId !== "local" ? " · 云解析" : "";
      return {
        detail: `已解析 · ${size} · ${pages}${formatChars(a.parsedChars)}${from}`,
        title: "已解析，内容会随消息一起发送",
      };
    }
    case "failed":
      // The code is canonical; `parseError` is the server's own sentence, used when the
      // client meets a code it has no message for (an older build, a newer server).
      return {
        detail: `${size} · 解析失败`,
        title: translateParseError(a.parseErrorCode, undefined, a.parseError) || "解析失败",
      };
    default:
      return { detail: size, title: a.name };
  }
}

const chips = computed<Chip[]>(() =>
  props.attachments.map((a) => {
    const { detail, title } = describe(a);
    return { attachment: a, url: attachmentUrl(props.sessionId, a.id), detail, title };
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
      <span v-else class="file-icon">📄</span>
      <div class="meta">
        <span class="name" :title="c.attachment.name">{{ c.attachment.name }}</span>
        <span class="size" data-testid="attachment-detail">{{ c.detail }}</span>
      </div>
      <button
        v-if="c.attachment.parseStatus === 'failed' && removable"
        class="icon-btn retry"
        title="重新解析"
        data-testid="attachment-reparse"
        @click="emit('reparse', c.attachment)"
      >
        ↻
      </button>
      <button
        v-if="removable"
        class="icon-btn danger remove"
        title="移除"
        @click="emit('remove', c.attachment.id)"
      >
        ✕
      </button>
    </div>
  </div>
</template>

<style scoped>
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px 8px 5px 5px;
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
  font-size: 13px;
  padding: 2px 5px;
}
.thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 5px;
  flex-shrink: 0;
  background: var(--code-bg);
}
.file-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: var(--panel);
  flex-shrink: 0;
}
.meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.size {
  font-size: 11px;
  color: var(--text-3);
}
.remove {
  font-size: 11px;
  padding: 2px 4px;
}
</style>
