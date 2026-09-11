<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import AttachmentChips from "./AttachmentChips.vue";
import TokenCountPopover from "./TokenCountPopover.vue";
import ModelSelector from "./ModelSelector.vue";
import SessionSettingsDialog from "./dialogs/SessionSettingsDialog.vue";
import { openSettings } from "../composables/ui";

const { t } = useI18n();
const store = useAppStore();
const text = ref("");
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const showSessionSettings = ref(false);

const canSend = computed(
  () =>
    !store.streaming.active &&
    !store.documentsParsing &&
    (!!text.value.trim() || store.pendingAttachments.length > 0)
);

/** Warn before sending an image to a model that cannot read it. */
const imageWithoutVision = computed(
  () => store.pendingAttachments.some((a) => a.kind === "image") && !store.supportsVision
);

/**
 * A document still being extracted cannot be sent yet.
 *
 * The extracted text is injected when the message is built, so sending now would produce a
 * turn where the model never saw the document — and it would not appear on a later turn
 * either, because the attachment belongs to this message. Waiting is the honest behaviour.
 */
const parsingDocuments = computed(() => store.documentsParsing);

/** Documents that failed to parse and are still staged — the model will not read them. */
const failedDocuments = computed(() =>
  store.pendingAttachments.filter((a) => a.parseStatus === "failed")
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
      <div v-if="parsingDocuments" class="parse-notice" data-testid="composer-parsing">
        {{ t("composer.parsing") }}
      </div>

      <div v-else-if="failedDocuments.length" class="vision-warning" data-testid="composer-parse-failed">
        {{ t("composer.parseFailed", { count: failedDocuments.length }, failedDocuments.length) }}
      </div>

      <div v-if="imageWithoutVision" class="vision-warning">
        {{ t("composer.visionWarning", { model: store.effectiveModel?.name ?? "" }) }}
      </div>

      <!-- One surface owns the input, the attachments and the toolbar (chatbox's
           InputBox layout), so the composer reads as a single control. -->
      <div class="surface">
        <div class="input-row">
          <textarea
            ref="textarea"
            v-model="text"
            data-testid="composer-input"
            rows="1"
            :placeholder="
              store.streaming.active ? t('composer.thinking') : t('composer.placeholder')
            "
            @keydown="onKeydown"
            @paste="onPaste"
          ></textarea>

          <button
            class="send-btn"
            data-testid="composer-send"
            :disabled="!canSend"
            :title="
            store.streaming.active
              ? t('composer.thinking')
              : parsingDocuments
                ? t('composer.parsingShort')
                : t('composer.send')
          "
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
          @reparse="store.reparseAttachment"
        />

        <div class="toolbar">
          <div class="toolbar-left">
            <button
              class="icon-btn attach-btn"
              :title="t('composer.attach')"
              :disabled="uploading || store.streaming.active || parsingDocuments"
              @click="fileInput?.click()"
            >
              {{ uploading ? "…" : "📎" }}
            </button>
            <button
              class="icon-btn params-btn"
              :title="t('composer.settings')"
              @click="showSessionSettings = true"
            >
              🎛
            </button>
            <span
              v-if="store.activeCopilot"
              class="pill copilot-tag truncate"
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
          data-testid="composer-file-input"
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
  font-size: var(--fs-2);
  color: var(--warning);
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-5);
}
/* Informational, not a warning: extraction is simply still running. */
.parse-notice {
  font-size: var(--fs-2);
  color: var(--text-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-5);
}
/*
 * `min-width` is what makes the ellipsis reachable. A flex item defaults to `min-width:
 * auto`, which refuses to shrink below its content — so `max-width` and `text-overflow`
 * were both inert and a long Copilot name pushed the toolbar's other controls off the row
 * instead of truncating.
 */
.copilot-tag {
  font-size: var(--fs-1);
  color: var(--text-3);
  padding: var(--space-1) var(--space-5);
  min-width: 0;
  flex: 0 1 auto;
  max-width: 240px;
}
</style>
