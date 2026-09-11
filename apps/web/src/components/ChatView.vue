<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { useTheme } from "../composables/theme";
import { useLocale } from "../composables/locale";
import { buildMinimapAnchors, type MessageMinimapAnchor } from "../utils/minimap";
import type { Locale } from "../utils/locale";
import MessageItem from "./MessageItem.vue";
import MessageMinimapRail from "./MessageMinimapRail.vue";
import Composer from "./Composer.vue";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";

const store = useAppStore();
const theme = useTheme();
const { t } = useI18n();
const { locale, setLocale, available } = useLocale();
const showNewSession = ref(false);
const messagesEl = ref<HTMLElement | null>(null);

/* ----------------------------------- theme ----------------------------------- */

/** Icons are not translatable — only the labels are. */
const THEME_ICON = { light: "☀️", dark: "🌙", auto: "🖥️" } as const;

const themeIcon = computed(() => THEME_ICON[theme.mode.value]);
/** "自动（当前浅色）" reads clearer than just "自动" when the OS is doing the deciding. */
const themeLabel = computed(() =>
  theme.mode.value === "auto"
    ? t("theme.autoCurrent", { current: t(`theme.${theme.resolved.value}`) })
    : t(`theme.${theme.mode.value}`)
);

/* ---------------------------------- locale ----------------------------------- */
function onLocaleChange(event: Event): void {
  setLocale((event.target as HTMLSelectElement).value as Locale);
}

/* ------------------------------- title editing ------------------------------- */
const editingTitle = ref(false);
const titleDraft = ref("");
const titleInput = ref<HTMLInputElement | null>(null);

function startTitleEdit() {
  if (!store.activeSession) return;
  titleDraft.value = store.activeSession.title;
  editingTitle.value = true;
  nextTick(() => {
    titleInput.value?.focus();
    titleInput.value?.select();
  });
}

async function commitTitle() {
  const id = store.activeSessionId;
  const title = titleDraft.value;
  editingTitle.value = false;
  if (!id || !title.trim()) return;
  if (title.trim() === store.activeSession?.title) return;
  await store.renameSession(id, title).catch(() => undefined);
}

function cancelTitleEdit() {
  editingTitle.value = false;
}

/* ------------------------------ minimap rail ------------------------------ */
/** One anchor per user turn, paired with the reply it produced. */
const minimapAnchors = computed(() => buildMinimapAnchors(store.messages));

// Hidden on narrow viewports, matching chatbox — the rail would crowd the messages and
// the preview card would have nowhere to go.
const isNarrow = ref(false);
let narrowQuery: MediaQueryList | null = null;
function syncNarrow(e: MediaQueryList | MediaQueryListEvent) {
  isNarrow.value = e.matches;
}
onMounted(() => {
  if (typeof window.matchMedia !== "function") return;
  narrowQuery = window.matchMedia("(max-width: 900px)");
  syncNarrow(narrowQuery);
  narrowQuery.addEventListener("change", syncNarrow);
});
onBeforeUnmount(() => narrowQuery?.removeEventListener("change", syncNarrow));

const showMinimap = computed(() => !isNarrow.value && minimapAnchors.value.length > 0);

/**
 * Scroll the list so the anchored turn sits at the top. Computed from rects rather than
 * `offsetTop`, which is measured against whichever ancestor happens to be positioned.
 */
function jumpToAnchor(anchor: MessageMinimapAnchor) {
  const container = messagesEl.value;
  if (!container) return;
  const target = container.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"]`);
  if (!target) return;

  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  container.scrollTo({
    top: container.scrollTop + (targetRect.top - containerRect.top) - 8,
    behavior: "smooth",
  });
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
}

watch(
  () => [
    store.messages.length,
    store.streaming.content,
    store.streaming.reasoning,
    store.streaming.toolCalls.length,
  ],
  () => scrollToBottom()
);

watch(
  () => store.activeSessionId,
  () => scrollToBottom()
);
</script>

<template>
  <main class="main">
    <header class="topbar">
      <div class="title-block">
        <div v-if="editingTitle" class="title-edit">
          <input
            ref="titleInput"
            v-model="titleDraft"
            class="input title-input"
            :placeholder="t('chat.titlePlaceholder')"
            @keydown.enter.prevent="commitTitle"
            @keydown.esc.prevent="cancelTitleEdit"
            @blur="commitTitle"
          />
          <span v-if="store.activeSession?.titleSource === 'auto'" class="title-hint">
            {{ t("chat.titleHint") }}
          </span>
        </div>

        <template v-else>
          <div class="title-row">
            <span
              class="title"
              data-testid="session-title"
              :class="{ editable: !!store.activeSession }"
              :title="store.activeSession ? t('chat.editTitleHint') : undefined"
              @click="startTitleEdit"
            >
              {{ store.activeSession?.title || store.activeWorkspace?.name || t("app.title") }}
            </span>
            <button
              v-if="store.activeSession"
              class="btn title-edit-btn"
              :title="t('chat.editTitle')"
              @click="startTitleEdit"
            >
              ✎ {{ t("chat.editTitle") }}
            </button>
            <span
              v-if="store.activeSession?.titleSource === 'auto'"
              class="auto-badge"
              :title="t('chat.autoBadgeTitle')"
            >
              AI
            </span>
          </div>
          <div
            v-if="store.activeCopilot"
            class="subtitle"
            :title="store.activeCopilot.systemPrompt"
          >
            ◈ {{ store.activeCopilot.name }}
          </div>
        </template>
      </div>

      <!-- The title block takes the free space, so the actions land on the right. -->
      <div class="topbar-actions">
        <!-- A select, not a cycle button: N locales on one icon is not legible, and the
             labels are autonyms so they stay readable in either language. -->
        <select
          class="locale-select"
          :value="locale"
          :title="t('locale.switchLabel')"
          :aria-label="t('locale.switchLabel')"
          data-testid="locale-select"
          @change="onLocaleChange"
        >
          <option v-for="l in available" :key="l" :value="l">
            {{ l === "zh-CN" ? t("locale.zhCN") : t("locale.en") }}
          </option>
        </select>
        <button
          class="icon-btn theme-toggle"
          :title="t('theme.toggleTitle', { label: themeLabel })"
          data-testid="theme-toggle"
          @click="theme.cycle()"
        >
          {{ themeIcon }}
        </button>
      </div>
    </header>

    <!-- Split into three keys rather than one message with <strong> in it: no message
         carries HTML, so there is nothing for `v-html` to inject. -->
    <div v-if="!store.isConfigured" class="config-banner">
      {{ t("app.configBanner.before") }}
      <strong>{{ t("app.configBanner.action") }}</strong>
      {{ t("app.configBanner.after") }}
    </div>

    <!-- The rail is a sibling of the scroller, not a child: inside it would scroll away. -->
    <div class="messages-wrap">
      <div
        ref="messagesEl"
        class="messages"
        data-testid="messages"
        :class="{ 'with-rail': showMinimap }"
      >
        <div v-if="store.messages.length === 0 && !store.streaming.active" class="empty-state">
          <h2>{{ store.activeCopilot?.name ?? t("chat.start") }}</h2>
          <p>{{ t("chat.startHint") }}</p>
          <button class="btn" @click="showNewSession = true">{{ t("chat.startAction") }}</button>
        </div>
        <MessageItem v-for="m in store.messages" :key="m.id" :message="m" />
        <MessageItem v-if="store.streaming.active" :streaming="store.streaming" />
      </div>
      <MessageMinimapRail
        v-if="showMinimap"
        :anchors="minimapAnchors"
        @jump="jumpToAnchor"
      />
    </div>

    <Composer />

    <NewSessionDialog v-if="showNewSession" @close="showNewSession = false" />
  </main>
</template>

<style scoped>
.title-block {
  flex: 1;
  min-width: 0;
}
.topbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}
.theme-toggle {
  font-size: var(--fs-5);
  padding: var(--space-2) var(--space-4);
}
.locale-select {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-2);
  padding: 3px var(--space-2);
  cursor: pointer;
}
.locale-select:hover {
  color: var(--text);
}
.title-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
/*
 * Sizes to its text (`flex: 0 1 auto`), so the edit button and the AI badge sit right
 * after the title instead of being pushed to the far edge of the header. `min-width`
 * gives a short title a stable floor — otherwise a two-character name would put the
 * button under the cursor and it would jump around from conversation to conversation.
 */
.topbar .title {
  flex: 0 1 auto;
  min-width: 15ch;
  max-width: 100%;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar .title.editable {
  cursor: text;
  border-radius: var(--radius-xs);
}
.topbar .title.editable:hover {
  color: var(--accent);
}
/* Always visible — a hover-only affordance is undiscoverable. */
.title-edit-btn {
  flex-shrink: 0;
  padding: 3px 9px;
  font-size: var(--fs-2);
  color: var(--text-2);
}
.title-edit-btn:hover {
  color: var(--text);
  border-color: var(--text-3);
}
.auto-badge {
  flex-shrink: 0;
  font-size: var(--fs-1);
  line-height: 1;
  padding: var(--space-1) 5px;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  border: 1px solid var(--border);
}
.title-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.title-input {
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-4);
  font-weight: 600;
}
.title-hint {
  font-size: var(--fs-1);
  color: var(--text-3);
}
.subtitle {
  font-size: var(--fs-1);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.config-banner {
  margin: 0;
  padding: var(--space-4) var(--space-7);
  background: var(--warning-bg);
  border-bottom: 1px solid var(--warning-border);
  color: var(--warning);
  font-size: var(--fs-3);
  flex-shrink: 0;
}
.empty-state button {
  margin-top: var(--space-4);
}
</style>
