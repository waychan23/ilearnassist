<script setup lang="ts">
import { computed } from "vue";
import { attachmentUrl } from "../api/client";
import { formatBytes } from "../utils/format";
import type { Attachment } from "../api/types";

const props = defineProps<{
  sessionId: string;
  attachments: Attachment[];
  /** Composer mode: shows a remove control on each chip. */
  removable?: boolean;
}>();

const emit = defineEmits<{ remove: [id: string] }>();

interface Chip {
  attachment: Attachment;
  url: string;
}

const chips = computed<Chip[]>(() =>
  props.attachments.map((a) => ({
    attachment: a,
    url: attachmentUrl(props.sessionId, a.id),
  }))
);
</script>

<template>
  <div class="attachments">
    <div v-for="c in chips" :key="c.attachment.id" class="chip" data-testid="attachment-chip">
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
        <span class="size">{{ formatBytes(c.attachment.size) }}</span>
      </div>
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
  max-width: 240px;
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
