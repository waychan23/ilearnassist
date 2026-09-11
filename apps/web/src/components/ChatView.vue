<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { isCompact } from "../composables/breakpoints";
import { openDrawer, showWorkspaceHome, uiState } from "../composables/ui";
import { buildMinimapAnchors, type MessageMinimapAnchor } from "../utils/minimap";
import MessageItem from "./MessageItem.vue";
import MessageMinimapRail from "./MessageMinimapRail.vue";
import Composer from "./Composer.vue";
import TopbarControls from "./TopbarControls.vue";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";
import Icon from "./Icon.vue";

const store = useAppStore();
const { t } = useI18n();
const showNewSession = ref(false);
const messagesEl = ref<HTMLElement | null>(null);

/* --------------------------------- leaving ----------------------------------- */

/**
 * Out of the workspace and back to the list.
 *
 * The workspace list is refetched rather than assumed: the conversation counts and last
 * activity on the cards are the whole reason the page exists, and a turn sent since the
 * user entered would leave the card they are about to look at stale. Not awaited — the
 * navigation must not wait on a request, and the page renders from what is already in the
 * store while the fresh numbers land.
 */
function leaveWorkspace(): void {
  showWorkspaceHome();
  void store.refreshWorkspaces().catch(() => undefined);
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
// the preview card would have nowhere to go. `isCompact` is shared with the drawer, which
// needs the same breakpoint: two copies of "900" is how a drawer ends up opening on a
// screen whose toggle is hidden.
const showMinimap = computed(() => !isCompact.value && minimapAnchors.value.length > 0);

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
      <!--
        The way out, on every viewport. `isCompact` does not gate it the way it gates the
        drawer toggle below: the drawer is one way to reach other conversations, but the
        workspace list is the only way to reach another workspace, and a phone needs that
        as much as a desktop does.
      -->
      <button
        class="icon-btn back-toggle"
        data-testid="back-to-workspaces"
        :title="t('chat.backToWorkspaces')"
        :aria-label="t('chat.backToWorkspaces')"
        @click="leaveWorkspace"
      >
        <Icon name="arrow-left" />
      </button>

      <!--
        Only on a compact viewport, which also means no desktop spec can click it by
        accident. `aria-expanded` conveys the state without a second string; `aria-controls`
        needs the id the sidebar carries.
      -->
      <button
        v-if="isCompact"
        class="icon-btn nav-toggle"
        data-testid="nav-toggle"
        :title="t('sidebar.openNav')"
        :aria-label="t('sidebar.openNav')"
        :aria-expanded="uiState.drawerOpen"
        aria-controls="app-sidebar"
        @click="openDrawer"
      >
        <Icon name="menu" />
      </button>

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
              <Icon name="edit" /> <span class="label">{{ t("chat.editTitle") }}</span>
            </button>
            <span
              v-if="store.activeSession?.titleSource === 'auto'"
              class="badge muted"
              :title="t('chat.autoBadgeTitle')"
            >
              AI
            </span>
          </div>
          <div
            v-if="store.activeCopilot"
            class="subtitle truncate"
            :title="store.activeCopilot.systemPrompt"
          >
            <Icon name="diamond" /> {{ store.activeCopilot.name }}
          </div>
        </template>
      </div>

      <!-- The title block takes the free space, so the actions land on the right. -->
      <TopbarControls />
    </header>

    <!-- Split into three keys rather than one message with <strong> in it: no message
         carries HTML, so there is nothing for `v-html` to inject. -->
    <div v-if="!store.isConfigured" class="config-banner">
      <Icon name="warning" />
      {{ t("app.configBanner.before") }}
      <strong><Icon name="gear" /> {{ t("app.configBanner.action") }}</strong>
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
          <button class="btn" @click="showNewSession = true">
            <Icon name="plus" /> {{ t("chat.startAction") }}
          </button>
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
/* The language picker and the theme button moved to `TopbarControls.vue` when the
   workspace home needed the same pair; their rules went with them. */
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
