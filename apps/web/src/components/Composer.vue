<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import AttachmentChips from "./AttachmentChips.vue";
import SourceMentionPicker from "./SourceMentionPicker.vue";
import { activeMention, insertMention, type ActiveMention } from "../utils/mention";
import type { Source } from "../api/types";
import TokenCountPopover from "./TokenCountPopover.vue";
import ModelSelector from "./ModelSelector.vue";
import { openSessionSettings, showAdmin } from "../composables/ui";
import { autosizeTextarea } from "../utils/autosize";
import Icon from "./Icon.vue";

const { t } = useI18n();
const store = useAppStore();
const text = ref("");
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);

const canSend = computed(
  () =>
    !store.streaming.active &&
    !store.documentsParsing &&
    (!!text.value.trim() ||
      store.pendingAttachments.length > 0 ||
      store.pendingSources.length > 0)
);

/**
 * The `@` the caret is inside, if any — what opens the source picker.
 *
 * Read from the text and the caret rather than tracked in a flag, because the caret moves for
 * reasons no handler sees: an arrow key, a click, an undo. `utils/mention.ts` owns the rule;
 * this only asks it and hands the caret back afterwards.
 */
const mention = ref<ActiveMention | null>(null);

function refreshMention(): void {
  const el = textarea.value;
  mention.value = el ? activeMention(text.value, el.selectionStart ?? 0) : null;
}

/** Put the chosen source's name where the mention was, and put the caret after it. */
function onPickSource(source: Source): void {
  const el = textarea.value;
  const current = mention.value;
  if (!el || !current) return;

  const result = insertMention(text.value, current, source.name);
  text.value = result.text;
  mention.value = null;
  void store.referenceSource(source);
  // After Vue has written the new value: setting `selectionStart` before the DOM updates
  // would place the caret in the old text.
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(result.caret, result.caret);
    autosize();
  });
}

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

/**
 * Why the send button cannot be used, in one place: it is both the tooltip and the name.
 *
 * No `streaming.active` branch: while a reply streams the corner holds Stop, so Send is not
 * rendered for a state to describe. `composer.thinking` is still the textarea's placeholder
 * there, which is the only place that sentence belongs.
 */
const sendLabel = computed(() =>
  parsingDocuments.value ? t("composer.parsingShort") : t("composer.send")
);

/**
 * The stop control's wording. It says so while the request is in flight, because on a slow
 * link the round trip is long enough to press Stop twice.
 */
const stopLabel = computed(() =>
  store.streaming.stopping ? t("composer.stopping") : t("composer.stop")
);

function stop() {
  void store.stopMessage();
}

/** Documents that failed to parse and are still staged — the model will not read them. */
const failedDocuments = computed(() =>
  store.pendingAttachments.filter((a) => a.parseStatus === "failed")
);

/**
 * Grow the textarea with its content — including shrinking it again after a send, which is
 * what the reset inside `autosizeTextarea` is for.
 */
function autosize() {
  if (textarea.value) autosizeTextarea(textarea.value);
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
  // The picker gets first refusal on the keys it navigates with, and says so by consuming
  // them: Enter with it open must choose a source rather than send the message.
  if (picker.value?.handleKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

const picker = ref<InstanceType<typeof SourceMentionPicker> | null>(null);

function onInput() {
  refreshMention();
  autosize();
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
        <SourceMentionPicker ref="picker" :mention="mention" @pick="onPickSource" />
        <div class="input-row">
          <textarea
            ref="textarea"
            v-model="text"
            data-testid="composer-input"
            rows="1"
            :placeholder="
              store.streaming.active ? t('composer.thinking') : t('composer.placeholder')
            "
            @input="onInput"
            @keydown="onKeydown"
            @keyup="refreshMention"
            @click="refreshMention"
            @paste="onPaste"
            @blur="mention = null"
          ></textarea>

          <!--
            The same corner holds Stop for as long as a reply is streaming, which is also
            what chatbox does. Swapping the control rather than adding a second one keeps
            the composer from growing a toolbar while the user is watching it answer.
          -->
          <button
            v-if="store.streaming.active"
            class="send-btn stop-btn"
            data-testid="composer-stop"
            :disabled="store.streaming.stopping"
            :title="stopLabel"
            :aria-label="stopLabel"
            @click="stop"
          >
            <Icon name="stop" />
          </button>
          <button
            v-else
            class="send-btn"
            data-testid="composer-send"
            :disabled="!canSend"
            :title="sendLabel"
            :aria-label="sendLabel"
            @click="send"
          >
            <Icon name="send" />
          </button>
        </div>

        <div v-if="store.pendingAttachments.length" data-testid="composer-attachments">
          <AttachmentChips
            :attachments="store.pendingAttachments"
            removable
            @remove="store.removePendingAttachment"
            @reparse="store.reparseAttachment"
          />
        </div>

        <!--
          The referenced sources, as chips of their own. A `Source` is an `Attachment` in every
          field the chip reads, so the same component draws both — and drawing them as two rows
          rather than one is what says which was uploaded for this turn and which was pointed at.
        -->
        <div v-if="store.pendingSources.length" data-testid="composer-sources">
          <AttachmentChips
            :attachments="store.pendingSources"
            removable
            @remove="store.removePendingSource"
            @reparse="(source) => store.referenceSource(source as Source)"
          />
        </div>

        <div class="toolbar">
          <div class="toolbar-left">
            <button
              class="icon-btn attach-btn"
              :title="t('composer.attach')"
              :disabled="uploading || store.streaming.active || parsingDocuments"
              @click="fileInput?.click()"
            >
              <Icon v-if="!uploading" name="attach" /><template v-else>…</template>
            </button>
            <button
              class="icon-btn params-btn"
              data-testid="open-session-settings"
              :title="t('sessionSettings.open')"
              :aria-label="t('sessionSettings.open')"
              @click="openSessionSettings()"
            >
              <Icon name="sliders" />
            </button>
            <span
              v-if="store.activeCopilotName"
              class="pill copilot-tag truncate"
              data-testid="copilot-tag"
              :title="store.activeSystemPrompt"
            >
              <Icon name="diamond" /> {{ store.activeCopilotName }}
            </span>
          </div>

          <div class="toolbar-right">
            <TokenCountPopover :pending-text="text" />
            <!-- "Manage models…" is a platform administrator's screen, so it opens the console
                 on the model services rather than the dialog that used to hold them. -->
            <ModelSelector @manage="showAdmin('providers')" />
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
