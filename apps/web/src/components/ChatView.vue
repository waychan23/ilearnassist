<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAppStore } from "../stores/app";
import { buildMinimapAnchors, type MessageMinimapAnchor } from "../utils/minimap";
import MessageItem from "./MessageItem.vue";
import MessageMinimapRail from "./MessageMinimapRail.vue";
import Composer from "./Composer.vue";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";

const store = useAppStore();
const showNewSession = ref(false);
const messagesEl = ref<HTMLElement | null>(null);


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
            placeholder="会话标题"
            @keydown.enter.prevent="commitTitle"
            @keydown.esc.prevent="cancelTitleEdit"
            @blur="commitTitle"
          />
          <span v-if="store.activeSession?.titleSource === 'auto'" class="title-hint">
            标题由 AI 自动生成，修改后将不再自动更新
          </span>
        </div>

        <template v-else>
          <div class="title-row">
            <span
              class="title"
              data-testid="session-title"
              :class="{ editable: !!store.activeSession }"
              :title="store.activeSession ? '点击编辑标题' : undefined"
              @click="startTitleEdit"
            >
              {{ store.activeSession?.title || store.activeWorkspace?.name || "guided-learning" }}
            </span>
            <button
              v-if="store.activeSession"
              class="btn title-edit-btn"
              title="编辑标题"
              @click="startTitleEdit"
            >
              ✎ 编辑标题
            </button>
            <span
              v-if="store.activeSession?.titleSource === 'auto'"
              class="auto-badge"
              title="标题由 AI 根据第一轮对话自动生成"
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

    </header>

    <div v-if="!store.isConfigured" class="config-banner">
      ⚠ 尚未配置可用的 API Key。点击右上角 <strong>⚙ 设置 → Providers</strong> 添加一个
      Provider 并填入 Key，保存后即刻生效。
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
          <h2>{{ store.activeCopilot?.name ?? "开始对话" }}</h2>
          <p>在下方输入消息，Agent 将按需调用工具。</p>
          <button class="btn" @click="showNewSession = true">＋ 新建会话（选择 Copilot）</button>
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
.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
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
  border-radius: 4px;
}
.topbar .title.editable:hover {
  color: var(--accent);
}
/* Always visible — a hover-only affordance is undiscoverable. */
.title-edit-btn {
  flex-shrink: 0;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--text-2);
}
.title-edit-btn:hover {
  color: var(--text);
  border-color: var(--text-3);
}
.auto-badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 6px;
  color: var(--text-3);
  border: 1px solid var(--border);
}
.title-edit {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title-input {
  padding: 4px 8px;
  font-size: 14px;
  font-weight: 600;
}
.title-hint {
  font-size: 11px;
  color: var(--text-3);
}
.subtitle {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.config-banner {
  margin: 0;
  padding: 8px 16px;
  background: rgba(230, 179, 60, 0.12);
  border-bottom: 1px solid rgba(230, 179, 60, 0.35);
  color: #e6c06a;
  font-size: 13px;
  flex-shrink: 0;
}
.empty-state button {
  margin-top: 8px;
}
</style>
