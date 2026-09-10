<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useAppStore } from "../stores/app";
import AttachmentChips from "./AttachmentChips.vue";
import TokenCountPopover from "./TokenCountPopover.vue";
import ModelSelector from "./ModelSelector.vue";
import SessionSettingsDialog from "./dialogs/SessionSettingsDialog.vue";
import { openSettings } from "../composables/ui";

const store = useAppStore();
const text = ref("");
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const showSessionSettings = ref(false);

const canSend = computed(
  () => !store.streaming.active && (!!text.value.trim() || store.pendingAttachments.length > 0)
);

/** Warn before sending an image to a model that cannot read it. */
const imageWithoutVision = computed(
  () => store.pendingAttachments.some((a) => a.kind === "image") && !store.supportsVision
);

/**
 * Grow the textarea with its content. Height is reset first so the box can shrink
 * again after a send, which `scrollHeight` alone would never do.
 */
function autosize() {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

watch(text, () => nextTick(autosize));

async function addFiles(files: FileList | File[] | null) {
  if (!files) return;
  const list = Array.from(files);
  if (list.length === 0) return;
  uploading.value = true;
  try {
    for (const file of list) await store.uploadAttachment(file);
  } finally {
    uploading.value = false;
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  void addFiles(input.files);
  // Reset so picking the same file again still fires a change event.
  input.value = "";
}

/** Screenshots are the common case for pasting, so intercept clipboard files. */
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  void addFiles(files);
}

function send() {
  const t = text.value.trim();
  if (!canSend.value) return;
  const attachments = [...store.pendingAttachments];
  text.value = "";
  nextTick(autosize);
  void store.sendMessage(t, attachments);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="composer">
    <div class="inner-wrap">
      <div v-if="imageWithoutVision" class="vision-warning">
        当前模型「{{ store.effectiveModel?.name }}」未标记支持图片输入，图片将以文字占位符发送。
        可在「设置 → Providers」中为它勾选「图片输入」。
      </div>

      <!-- One surface owns the input, the attachments and the toolbar (chatbox's
           InputBox layout), so the composer reads as a single control. -->
      <div class="surface">
        <div class="input-row">
          <textarea
            ref="textarea"
            v-model="text"
            rows="1"
            :placeholder="
              store.streaming.active ? 'Agent 正在思考…' : '输入消息，Enter 发送，Shift+Enter 换行'
            "
            @keydown="onKeydown"
            @paste="onPaste"
          ></textarea>

          <button
            class="send-btn"
            :disabled="!canSend"
            :title="store.streaming.active ? 'Agent 正在思考…' : '发送 (Enter)'"
            @click="send"
          >
            ↑
          </button>
        </div>

        <AttachmentChips
          v-if="store.pendingAttachments.length"
          :session-id="store.activeSessionId ?? ''"
          :attachments="store.pendingAttachments"
          removable
          @remove="store.removePendingAttachment"
        />

        <div class="toolbar">
          <div class="toolbar-left">
            <button
              class="icon-btn attach-btn"
              title="添加图片或文件"
              :disabled="uploading || store.streaming.active"
              @click="fileInput?.click()"
            >
              {{ uploading ? "…" : "📎" }}
            </button>
            <button
              class="icon-btn params-btn"
              title="会话参数（Temperature、上下文长度、工具轮数…）"
              @click="showSessionSettings = true"
            >
              🎛
            </button>
            <span
              v-if="store.activeCopilot"
              class="copilot-tag"
              :title="store.activeCopilot.systemPrompt"
            >
              ◈ {{ store.activeCopilot.name }}
            </span>
          </div>

          <div class="toolbar-right">
            <TokenCountPopover :pending-text="text" />
            <ModelSelector @manage="openSettings()" />
          </div>
        </div>

        <input
          ref="fileInput"
          class="hidden-input"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,text/csv,text/html,text/css,text/xml,application/xml,application/json,application/javascript,application/typescript,application/pdf,.md,.txt,.json,.csv"
          @change="onPick"
        />
      </div>
    </div>

    <SessionSettingsDialog v-if="showSessionSettings" @close="showSessionSettings = false" />
  </div>
</template>

<style scoped>
.hidden-input {
  display: none;
}
.vision-warning {
  font-size: 12px;
  color: #e6c06a;
  background: rgba(230, 179, 60, 0.1);
  border: 1px solid rgba(230, 179, 60, 0.3);
  border-radius: var(--radius);
  padding: 6px 10px;
}
.copilot-tag {
  font-size: 11px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 2px 10px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
