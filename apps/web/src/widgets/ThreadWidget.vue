<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type { GetSessionThreadsResponse, PlanTreeNode } from "../api/types";
import { useAppStore } from "../stores/app";
import { emitWidgetEvent, subscribeWidgetEvents } from "../composables/widgetEvents";
import Icon from "../components/Icon.vue";
import {
  buildThreadTree,
  flattenThreadTree,
  OTHER_ROOT,
  PLAN_ROOT,
  type ThreadTreeRow,
} from "../utils/threadTree";

/**
 * The session-scoped thread (脉络) widget.
 *
 * A read-only tree of the topic chains the server derives after every turn: 计划 nests
 * threads by the live plan tree, 其他 holds background and off-plan chains, and every leaf
 * is one message (one line, ellipsised, full text in the tooltip). Clicking a heading or a
 * leaf scrolls the conversation to that message through the widget bus — this panel cannot
 * reach ChatView's scroll container itself.
 *
 * The classification runs server-side whether or not this panel is mounted; while it IS
 * mounted it drives the install-time backfill (one chunk per POST) and shows the remaining
 * count. A load failure is reported inside the panel, never as a toast.
 */
const { t } = useI18n();
const store = useAppStore();

const view = ref<GetSessionThreadsResponse | null>(null);
const planTree = ref<PlanTreeNode[] | null>(null);
const failed = ref(false);
const syncing = ref(false);
/** Explicitly collapsed node/thread ids; branches and everything else start expanded. */
const collapsed = ref<Set<string>>(new Set());

const rows = computed<ThreadTreeRow[]>(() =>
  flattenThreadTree(buildThreadTree(view.value?.threads ?? [], planTree.value), collapsed.value)
);
const hasRows = computed(() => rows.value.length > 0);

function resetView(): void {
  view.value = null;
  planTree.value = null;
  failed.value = false;
  syncing.value = false;
  collapsed.value = new Set();
}

/** Read the derived chains and the plan they nest under. The GET never classifies. */
async function refresh(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    resetView();
    return;
  }
  try {
    const [threadRes, planRes] = await Promise.all([
      api.getSessionThreads(sessionId),
      // The panel is readable without a plan; a plan fetch failing must not blank it.
      api.getPlan(sessionId).catch(() => ({ plan: null })),
    ]);
    view.value = threadRes;
    planTree.value = planRes.plan?.tree ?? null;
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

/**
 * Drive backfill one chunk per POST until everything is classified (or a call makes no
 * progress — a missing key or a classifier answer the server rejected leaves the backlog
 * untouched, and looping would ask the same question forever). Serialised: a turn ending
 * while the mount-time run is still going joins it rather than racing it.
 */
async function syncBacklog(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId || syncing.value) return;
  syncing.value = true;
  let previous = -1;
  try {
    for (;;) {
      if (store.activeSessionId !== sessionId) break;
      let res: GetSessionThreadsResponse;
      try {
        res = await api.syncSessionThreads(sessionId);
      } catch {
        failed.value = true;
        break;
      }
      failed.value = false;
      view.value = res;
      if (res.unassigned === 0 || res.unassigned === previous) break;
      previous = res.unassigned;
    }
    if (store.activeSessionId === sessionId) {
      // A plan may have been created/edited by the turn we just classified.
      const planRes = await api.getPlan(sessionId).catch(() => null);
      planTree.value = planRes?.plan?.tree ?? planTree.value;
    }
  } finally {
    syncing.value = false;
  }
}

watch(
  () => store.activeSessionId,
  () => {
    resetView();
    void refresh();
    void syncBacklog();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    if (event.type !== "turn.finished" || event.sessionId !== store.activeSessionId) return;
    void refresh().then(() => syncBacklog());
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

/* ---------------------------------- rows ---------------------------------- */

function toggle(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function branchLabel(id: string): string {
  return id === PLAN_ROOT ? t("thread.planBranch") : t("thread.otherBranch");
}

function branchTestId(id: string): string {
  return id === PLAN_ROOT ? "thread-branch-plan" : "thread-branch-other";
}

function collapsible(row: ThreadTreeRow): boolean {
  if (row.kind === "node") return row.messageCount > 0;
  if (row.kind === "thread") return row.messageCount > 0;
  return false;
}

function isCollapsed(row: ThreadTreeRow): boolean {
  return row.kind !== "branch" && row.kind !== "message" && collapsed.value.has(row.id);
}

/** A heading with a first message jumps there; container nodes just toggle. */
function activate(row: ThreadTreeRow): void {
  if (row.kind === "message") {
    emitWidgetEvent({ type: "chat.jumpToMessage", messageId: row.message.id });
    return;
  }
  if (row.kind === "node" || row.kind === "thread") {
    if (row.firstMessageId) {
      emitWidgetEvent({ type: "chat.jumpToMessage", messageId: row.firstMessageId });
    } else if (collapsible(row)) {
      toggle(row.id);
    }
  }
}

function onCaret(row: ThreadTreeRow): void {
  if (row.kind !== "message" && row.kind !== "branch") toggle(row.id);
}

function leafText(row: Extract<ThreadTreeRow, { kind: "message" }>): string {
  return row.message.preview || t("thread.toolCall");
}

function leafTitle(row: Extract<ThreadTreeRow, { kind: "message" }>): string {
  return row.message.content || t("thread.toolCall");
}
</script>

<template>
  <div class="thread-widget" data-testid="widget-thread">
    <div v-if="!store.activeSession" class="widget-empty">
      {{ t("widgets.thread.noSession") }}
    </div>

    <div v-else-if="failed" class="widget-error" data-testid="thread-sync-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="thread-retry" @click="refresh(); syncBacklog()">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <div class="thread-scroll" data-testid="thread-scroll">
      <div
        v-if="syncing && !hasRows"
        class="widget-empty"
        data-testid="thread-syncing"
      >
        {{ t("thread.syncing") }}
      </div>
      <div v-else-if="!hasRows" class="widget-empty" data-testid="thread-empty">
        {{ t("thread.empty") }}
      </div>

      <ul v-else class="thread-tree" data-testid="thread-tree">
        <li v-for="row in rows" :key="row.kind + ':' + row.id" :style="{ '--thread-depth': row.depth }">
          <!-- Branch headings: static, translated, with the total they contain. -->
          <div
            v-if="row.kind === 'branch'"
            class="thread-branch"
            :data-testid="branchTestId(row.id)"
          >
            <span class="caret-spacer" aria-hidden="true" />
            <span class="branch-title">{{ branchLabel(row.id) }}</span>
            <span class="node-count">{{ row.messageCount }}</span>
          </div>

          <!-- A plan node: caret and title are sibling controls (a jump button must not
               nest another button). Its own thread makes the title a jump target; a
               container node's title toggles instead. -->
          <div
            v-else-if="row.kind === 'node'"
            class="thread-node-row"
            :class="{ missing: row.missing }"
            :data-testid="'thread-node-' + row.id"
          >
            <button
              v-if="collapsible(row) || row.hasChildren"
              type="button"
              class="caret-btn icon-btn"
              :aria-label="isCollapsed(row) ? t('thread.expand') : t('thread.collapse')"
              :data-testid="'thread-caret-' + row.id"
              @click="onCaret(row)"
            >
              <Icon :name="isCollapsed(row) ? 'caret-right' : 'caret-down'" />
            </button>
            <span v-else class="caret-spacer" aria-hidden="true" />
            <button
              type="button"
              class="t-title"
              :class="{ link: Boolean(row.firstMessageId) }"
              :title="row.firstMessageId ? t('thread.locate') : undefined"
              @click="activate(row)"
            >
              <span v-if="row.number" class="node-number">{{ row.number }}</span>
              <span class="node-title">{{ row.title }}</span>
              <span v-if="row.missing" class="node-missing">（{{ t("thread.nodeMissing") }}）</span>
              <span v-if="row.messageCount > 0" class="node-count">{{ row.messageCount }}</span>
            </button>
          </div>

          <!-- An "other" thread: same sibling shape. -->
          <div v-else-if="row.kind === 'thread'" class="thread-node-row">
            <button
              v-if="collapsible(row)"
              type="button"
              class="caret-btn icon-btn"
              :aria-label="isCollapsed(row) ? t('thread.expand') : t('thread.collapse')"
              :data-testid="'thread-caret-' + row.id"
              @click="onCaret(row)"
            >
              <Icon :name="isCollapsed(row) ? 'caret-right' : 'caret-down'" />
            </button>
            <span v-else class="caret-spacer" aria-hidden="true" />
            <button
              type="button"
              class="t-title link"
              :title="t('thread.locate')"
              :data-testid="'thread-thread-' + row.id"
              @click="activate(row)"
            >
              <span class="node-title">{{ row.title }}</span>
              <span class="node-count">{{ row.messageCount }}</span>
            </button>
          </div>

          <!-- A message leaf: one line, full text in the native tooltip. -->
          <button
            v-else
            type="button"
            class="thread-leaf"
            :class="row.message.role"
            :title="leafTitle(row)"
            :data-testid="'thread-message-' + row.message.id"
            @click="activate(row)"
          >
            <span class="leaf-icon" aria-hidden="true">
              <Icon :name="row.message.role === 'user' ? 'user' : 'robot'" />
            </span>
            <span class="leaf-text">{{ leafText(row) }}</span>
          </button>
        </li>
      </ul>

      <div
        v-if="view && view.unassigned > 0"
        class="thread-status"
        data-testid="thread-status"
      >
        {{ syncing ? t("thread.syncing") : t("thread.unassigned", { count: view.unassigned }) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.thread-scroll {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.thread-tree {
  list-style: none;
  margin: 0;
  padding: var(--space-2) var(--space-3) var(--space-4);
  display: grid;
  gap: 1px;
}
.thread-branch,
.thread-node-row,
.thread-leaf {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-3);
  color: var(--text);
}
.thread-branch {
  padding: var(--space-2) var(--space-3) var(--space-1);
  font-weight: 500;
}
.thread-node-row {
  border-radius: var(--radius-sm);
}
.thread-node-row:hover {
  background: var(--panel-2);
}
.thread-node-row.missing .node-title {
  color: var(--text-3);
}
.t-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border: 0;
  background: transparent;
  padding: var(--space-1) var(--space-3) var(--space-1) 0;
  text-align: left;
  font-size: var(--fs-3);
  color: var(--text);
  cursor: default;
}
.t-title.link {
  cursor: pointer;
}
.thread-leaf {
  border: 0;
  background: transparent;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.thread-leaf:hover {
  background: var(--panel-2);
}
.caret-btn {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.caret-spacer {
  width: var(--fs-2);
  flex: none;
}
.node-number {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
  min-width: 2.5em;
}
.node-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-missing {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.node-count {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-2);
  color: var(--text-3);
}
.thread-leaf {
  color: var(--text-2);
  padding-left: calc(var(--space-3) + var(--thread-depth, 1) * var(--space-4));
}
.leaf-icon {
  flex: none;
  display: inline-flex;
  font-size: var(--fs-2);
  color: var(--text-3);
}
.leaf-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-status {
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-2);
  color: var(--text-3);
}
</style>
