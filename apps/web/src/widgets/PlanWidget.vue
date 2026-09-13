<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type {
  PlanNodeStatus,
  PlanSnapshot,
  PlanSnapshotNode,
  PlanTreeNode,
  PlanView,
} from "../api/types";
import { useAppStore } from "../stores/app";
import { emitWidgetEvent, subscribeWidgetEvents } from "../composables/widgetEvents";
import Icon from "../components/Icon.vue";

/**
 * The session-scoped plan widget.
 *
 * One plan per conversation, written only by the model through the three plan tools; this
 * panel is a read view. The current plan carries live node status and completion anchors;
 * historical versions carry structure only and are read-only. Expansion is client-side
 * state — the server always sends the whole tree — and resets when the version changes.
 */
const { t } = useI18n();
const store = useAppStore();

const plan = ref<PlanView | null>(null);
const snapshot = ref<PlanSnapshot | null>(null);
const failed = ref(false);
const historyFailed = ref(false);
/** "latest" or a historical version number. */
const selectedVersion = ref<number | "latest">("latest");
/** Explicitly collapsed branch ids; everything starts expanded. */
const collapsed = ref<Set<string>>(new Set());

async function loadCurrent(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    plan.value = null;
    snapshot.value = null;
    return;
  }
  try {
    const res = await api.getPlan(sessionId);
    plan.value = res.plan;
    failed.value = false;
    // While a history version is open we keep the current plan fetched (so the version list
    // moves when a new version lands) but stay on the snapshot.
    if (selectedVersion.value === "latest") snapshot.value = null;
  } catch {
    failed.value = true;
  }
}

function resetView(): void {
  plan.value = null;
  snapshot.value = null;
  failed.value = false;
  historyFailed.value = false;
  selectedVersion.value = "latest";
  collapsed.value = new Set();
}

watch(
  () => store.activeSessionId,
  () => {
    resetView();
    void loadCurrent();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    switch (event.type) {
      // A plan tool committed mid-turn, and the turn ending moved nothing more: refetch the
      // current plan for this conversation only.
      case "plan.changed":
      case "turn.finished":
        if (event.sessionId === store.activeSessionId) void loadCurrent();
        break;
      default:
        break;
    }
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

/* --------------------------------- versions --------------------------------- */

const historyMode = computed(() => snapshot.value !== null);

/** Latest first, so the dropdown reads Vn … V1. */
const versionOptions = computed(() => {
  if (!plan.value) return [] as number[];
  return Array.from({ length: plan.value.version }, (_, i) => plan.value!.version - i);
});

/** The versions the dropdown offers below "latest": newest first, current excluded. */
const historicalVersions = computed(() =>
  versionOptions.value.filter((v) => v !== plan.value?.version)
);

async function chooseVersion(value: string): Promise<void> {
  if (value === "latest") {
    selectedVersion.value = "latest";
    snapshot.value = null;
    historyFailed.value = false;
    collapsed.value = new Set();
    return;
  }
  const sessionId = store.activeSessionId;
  const version = Number.parseInt(value, 10);
  if (!sessionId || !Number.isInteger(version)) return;
  try {
    snapshot.value = await api.getPlanVersion(sessionId, version);
    selectedVersion.value = version;
    historyFailed.value = false;
    collapsed.value = new Set();
  } catch {
    // The version disappeared between the dropdown and the fetch — stay put and say so.
    historyFailed.value = true;
  }
}

/* ---------------------------------- tree UI ---------------------------------- */

interface Row {
  id: string;
  title: string;
  depth: number;
  hasChildren: boolean;
  status?: PlanNodeStatus;
  doneToolCallId?: string;
}

type DisplayNode = PlanTreeNode | PlanSnapshotNode;

function isLive(node: DisplayNode): node is PlanTreeNode {
  return "status" in node;
}

const rows = computed<Row[]>(() => {
  const roots = (snapshot.value?.tree ?? plan.value?.tree ?? []) as DisplayNode[];
  const out: Row[] = [];
  const walk = (nodes: DisplayNode[], depth: number): void => {
    for (const node of nodes) {
      const children = node.children ?? [];
      const row: Row = {
        id: node.id,
        title: node.title,
        depth,
        hasChildren: children.length > 0,
      };
      if (isLive(node)) {
        row.status = node.status;
        row.doneToolCallId = node.doneToolCallId;
      }
      out.push(row);
      if (!collapsed.value.has(node.id)) walk(children, depth + 1);
    }
  };
  walk(roots, 1);
  return out;
});

function toggle(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

/** Collapse the branches at exactly `level`; the levels above stay open. */
function showOnlyLevel(level: number): void {
  const roots = (snapshot.value?.tree ?? plan.value?.tree ?? []) as DisplayNode[];
  const next = new Set<string>();
  const walk = (nodes: DisplayNode[], depth: number): void => {
    for (const node of nodes) {
      const children = node.children ?? [];
      if (children.length > 0 && depth === level) next.add(node.id);
      walk(children, depth + 1);
    }
  };
  walk(roots, 1);
  collapsed.value = next;
}

function expandAll(): void {
  collapsed.value = new Set();
}

/**
 * Open only the branch path to the leaf worth looking at: the first in-progress leaf, or
 * when nothing has started the first unstarted leaf. Every branch off that path collapses.
 */
function expandCurrentPath(): void {
  const roots = plan.value?.tree ?? [];
  const target = findCurrentLeaf(roots);
  if (!target) {
    expandAll();
    return;
  }
  const onPath = new Set<string>();
  const mark = (nodes: PlanTreeNode[]): boolean => {
    for (const node of nodes) {
      const children = node.children ?? [];
      if (children.length === 0 && node.id === target.id) return true;
      if (children.length > 0 && mark(children)) {
        onPath.add(node.id);
        return true;
      }
    }
    return false;
  };
  mark(roots);
  const next = new Set<string>();
  const walk = (nodes: PlanTreeNode[]): void => {
    for (const node of nodes) {
      const children = node.children ?? [];
      if (children.length > 0 && !onPath.has(node.id)) next.add(node.id);
      walk(children);
    }
  };
  walk(roots);
  collapsed.value = next;
}

function findCurrentLeaf(nodes: PlanTreeNode[]): PlanTreeNode | undefined {
  const dfs = (
    list: PlanTreeNode[],
    status: PlanNodeStatus
  ): PlanTreeNode | undefined => {
    for (const node of list) {
      const children = node.children ?? [];
      if (children.length === 0 && node.status === status) return node;
      const found = dfs(children, status);
      if (found) return found;
    }
    return undefined;
  };
  // Deleted nodes are not work, so a tombstone leaf is neither "doing" nor "to do".
  return dfs(nodes, "in_progress") ?? dfs(nodes, "not_started");
}

const currentPathDisabled = computed(() => historyMode.value || !plan.value);

/* --------------------------------- status UI --------------------------------- */

function statusLabel(status: PlanNodeStatus): string {
  switch (status) {
    case "not_started":
      return t("plan.status.not_started");
    case "in_progress":
      return t("plan.status.in_progress");
    case "completed":
      return t("plan.status.completed");
    case "skipped":
      return t("plan.status.skipped");
    case "deleted":
      return t("plan.status.deleted");
  }
}

function planStatusLabel(): string {
  const status = plan.value?.status;
  if (status === "in_progress") return t("plan.status.in_progress");
  if (status === "completed") return t("plan.status.completed");
  return t("plan.status.not_started");
}

function jumpToCompletion(row: Row): void {
  if (!row.doneToolCallId || historyMode.value) return;
  const messageId = store.messageIdForToolCall(row.doneToolCallId);
  // A completed node whose turn has been persisted always resolves; the guard covers a
  // snapshot read mid-turn that the click cannot really happen on.
  if (messageId) emitWidgetEvent({ type: "chat.jump", messageId });
}
</script>

<template>
  <div class="plan-widget" data-testid="widget-plan">
    <div v-if="!store.activeSession" class="widget-empty">
      {{ t("widgets.plan.noSession") }}
    </div>

    <div v-else-if="failed" class="widget-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="loadCurrent">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <div v-if="plan" class="plan-toolbar" data-testid="plan-toolbar">
        <label class="plan-version">
          <select
            :value="selectedVersion === 'latest' ? 'latest' : String(selectedVersion)"
            :aria-label="t('plan.version')"
            data-testid="plan-version-select"
            @change="chooseVersion(($event.target as HTMLSelectElement).value)"
          >
            <option value="latest">{{ t("plan.versionLatest", { n: plan.version }) }}</option>
            <option v-for="v in historicalVersions" :key="v" :value="String(v)">
              {{ t("plan.versionN", { n: v }) }}
            </option>
          </select>
        </label>
        <span
          class="badge plan-state"
          :class="plan.status"
          data-testid="plan-status-badge"
        >
          {{ planStatusLabel() }}
        </span>
      </div>

      <div v-if="plan" class="plan-tree-ops" data-testid="plan-tree-ops">
        <button
          class="icon-btn plan-op"
          :title="t('plan.showLevel', { n: 1 })"
          :aria-label="t('plan.showLevel', { n: 1 })"
          data-testid="plan-level-1"
          @click="showOnlyLevel(1)"
        >
          1
        </button>
        <button
          class="icon-btn plan-op"
          :title="t('plan.showLevel', { n: 2 })"
          :aria-label="t('plan.showLevel', { n: 2 })"
          data-testid="plan-level-2"
          @click="showOnlyLevel(2)"
        >
          2
        </button>
        <button
          class="icon-btn plan-op"
          :title="t('plan.expandAll')"
          :aria-label="t('plan.expandAll')"
          data-testid="plan-expand-all"
          @click="expandAll"
        >
          <Icon name="list-tree" />
        </button>
        <button
          class="icon-btn plan-op"
          :title="t('plan.expandCurrentPath')"
          :aria-label="t('plan.expandCurrentPath')"
          :disabled="currentPathDisabled"
          data-testid="plan-current-path"
          @click="expandCurrentPath"
        >
          <Icon name="target" />
        </button>
      </div>

      <div v-if="historyFailed" class="plan-history-error" data-testid="plan-history-error">
        {{ t("plan.historyLoadFailed") }}
      </div>

      <div v-if="snapshot" class="plan-history-banner" data-testid="plan-history-banner">
        <Icon name="history" />
        <span>{{ t("plan.historyBanner", { n: snapshot.version }) }}</span>
      </div>

      <ul v-if="plan" class="plan-tree" data-testid="plan-tree">
        <li
          v-for="row in rows"
          :key="row.id"
          class="plan-row"
          :class="{ deleted: row.status === 'deleted' }"
          :data-testid="'plan-node-' + row.id"
          :data-node-status="row.status ?? ''"
          :style="{ '--plan-depth': row.depth - 1 }"
        >
          <button
            v-if="row.hasChildren"
            class="plan-caret icon-btn"
            :aria-label="collapsed.has(row.id) ? t('plan.expand') : t('plan.collapse')"
            :data-testid="'plan-caret-' + row.id"
            @click="toggle(row.id)"
          >
            <Icon :name="collapsed.has(row.id) ? 'caret-right' : 'caret-down'" />
          </button>
          <span v-else class="plan-caret-spacer" aria-hidden="true" />

          <span class="plan-status-icon" :data-status="row.status ?? ''">
            <template v-if="!historyMode">
              <Icon v-if="row.status === 'completed'" name="check" />
              <Icon v-else-if="row.status === 'in_progress'" name="progress" />
              <Icon v-else-if="row.status === 'skipped'" name="skip" />
              <Icon v-else-if="row.status === 'deleted'" name="close" />
              <Icon v-else name="circle" />
            </template>
          </span>

          <button
            v-if="row.status === 'completed' && row.doneToolCallId"
            class="plan-title plan-link"
            :title="t('plan.jumpToCompletion')"
            :data-testid="'plan-jump-' + row.id"
            @click="jumpToCompletion(row)"
          >
            {{ row.title }}
          </button>
          <span
            v-else
            class="plan-title"
            :title="row.status ? statusLabel(row.status) : undefined"
          >
            {{ row.title }}
          </span>
        </li>
      </ul>

      <div v-else class="widget-empty" data-testid="plan-empty">
        {{ t("plan.empty") }}
      </div>
    </template>
  </div>
</template>
