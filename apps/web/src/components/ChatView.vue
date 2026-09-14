<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { isCompact } from "../composables/breakpoints";
import { useScrollFollow } from "../composables/scrollFollow";
import { subscribeWidgetEvents } from "../composables/widgetEvents";
import {
  closeWidgetDrawer,
  openDrawer,
  openWidgetDrawer,
  showWorkspaceHome,
  uiState,
} from "../composables/ui";
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

/**
 * The widget panel's topbar control, on a compact viewport only.
 *
 * One function rather than an open/close pair, matching `toggleSidebar`: the only control that
 * reaches it is a toggle, and a pair would put the "which one am I" question at the call site,
 * answered by reading the flag the button already renders from.
 */
function toggleWidgetDrawer(): void {
  if (uiState.widgetDrawerOpen) closeWidgetDrawer();
  else openWidgetDrawer();
}

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
function scrollRectIntoView(container: HTMLElement, target: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  container.scrollTo({
    top: container.scrollTop + (targetRect.top - containerRect.top) - 8,
    behavior: "smooth",
  });
}

/** Scroll one persisted message to the top of the list. Shared by the minimap and widgets. */
function scrollToMessage(messageId: string): void {
  const container = messagesEl.value;
  if (!container) return;
  const target = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!target) return;
  scrollRectIntoView(container, target);
}

function jumpToAnchor(anchor: MessageMinimapAnchor) {
  scrollToMessage(anchor.messageId);
}

// A plan node's start anchor jumps to the exact tool-call card (placed before the node's
// teaching content), which is more precise than scrolling the whole message to the top.
// The widget cannot reach this scroll container, which is the one cross-component event the
// widget bus carries that is not about a turn.
onMounted(() => {
  unsubscribeFromWidgets = subscribeWidgetEvents((event) => {
    if (event.type !== "chat.jump") return;
    const container = messagesEl.value;
    if (!container) return;
    // The attribute is on every tool-call card, persisted or currently streaming.
    const target = container.querySelector<HTMLElement>(
      `[data-tool-call-id="${event.toolCallId}"]`
    );
    if (target) scrollRectIntoView(container, target);
  });
});
onBeforeUnmount(() => {
  unsubscribeFromWidgets?.();
  unsubscribeFromWidgets = null;
});
let unsubscribeFromWidgets: (() => void) | null = null;

/**
 * Keeping the viewport at the end is a decision, not a reflex — see `scrollFollow`.
 *
 * It is released by any scroll away from the end, which is what stops a reply being written
 * from dragging a reader back down on every token. The release is also what the return
 * control below is rendered from, so there is always a way back to a moving end.
 */
const { following, onScroll, scrollToBottom, follow } = useScrollFollow(messagesEl);

/**
 * Every shape a growing turn takes: text, chain of thought, a tool call appearing, and a tool
 * call's *output* landing. The last is watched by size rather than by count on purpose —
 * `tool_end` fills in a card that is already in the array, so its length does not change and
 * a watcher on the length alone would sit out the tallest growth of a turn.
 *
 * Growing the list also covers both halves of an exchange arriving — the reader's own bubble,
 * and the persisted assistant message that replaces the streaming one.
 */
watch(
  () => [
    store.messages.length,
    store.streaming.content,
    store.streaming.reasoning,
    store.streaming.toolCalls.length,
    store.streaming.toolCalls.reduce((chars, call) => chars + (call.output?.length ?? 0), 0),
  ],
  () => follow()
);

/**
 * A turn starting is the reader having just sent something — a message, or an answer to a
 * question the agent asked — so go to the end for it even if they had scrolled away. Asking
 * and then not showing the answer would be the release working against the person it is for.
 */
watch(
  () => store.streaming.active,
  (active) => {
    if (active) scrollToBottom();
  }
);

/** Another conversation is a different list, and it opens at its end. */
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
          <!-- Read from the conversation's snapshot, not from the Copilot list: it keeps
               naming the persona after that Copilot is renamed or deleted. -->
          <div
            v-if="store.activeCopilotName"
            class="subtitle truncate"
            :title="store.activeSystemPrompt"
          >
            <Icon name="diamond" /> {{ store.activeCopilotName }}
          </div>
        </template>
      </div>

      <!-- The title block takes the free space, so the actions land on the right. -->
      <TopbarControls />

      <!--
        The widget panel's only way in on a compact viewport, since it is off-canvas there — and
        the last thing in the row rather than beside the nav toggle, because the two drawers are
        at opposite edges of the screen: the sidebar's toggle stays on the left, next to the way
        out, and this one sits where the panel it opens actually appears.
      -->
      <button
        v-if="isCompact && store.enabledWidgetIds.length > 0"
        class="icon-btn widget-toggle"
        data-testid="widget-toggle"
        :title="t('widgets.open')"
        :aria-label="t('widgets.open')"
        :aria-expanded="uiState.widgetDrawerOpen"
        aria-controls="widget-panel"
        @click="toggleWidgetDrawer"
      >
        <Icon name="panel-right" />
      </button>
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
        @scroll.passive="onScroll"
      >
        <div v-if="store.messages.length === 0 && !store.streaming.active" class="empty-state">
          <h2>{{ store.activeCopilotName ?? t("chat.start") }}</h2>
          <p>{{ t("chat.startHint") }}</p>
          <button class="btn" @click="showNewSession = true">
            <Icon name="plus" /> {{ t("chat.startAction") }}
          </button>
        </div>
        <!-- `isLast` is what puts the tail actions (delete, regenerate) on one message and
             nobody else; the streaming bubble is not in the array, so it is never last. -->
        <MessageItem
          v-for="(m, i) in store.messages"
          :key="m.id"
          :message="m"
          :is-last="i === store.messages.length - 1"
        />
        <MessageItem v-if="store.streaming.active" :streaming="store.streaming" />
      </div>
      <MessageMinimapRail
        v-if="showMinimap"
        :anchors="minimapAnchors"
        @jump="jumpToAnchor"
      />

      <!--
        Only while the end has been let go of. Shown by the position rather than by the turn
        being live: a reader who has scrolled up into a finished conversation wants the same
        thing, and gating it on `streaming.active` would take the control away at the moment
        the reply they were reading was finally complete.
      -->
      <button
        v-if="!following"
        class="btn jump-to-latest"
        data-testid="jump-to-latest"
        :title="t('chat.jumpToLatest')"
        :aria-label="t('chat.jumpToLatest')"
        @click="scrollToBottom"
      >
        <Icon name="arrow-down" /> <span>{{ t("chat.jumpToLatest") }}</span>
      </button>
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
