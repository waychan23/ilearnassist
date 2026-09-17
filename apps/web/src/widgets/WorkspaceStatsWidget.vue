<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client";
import type { WorkspaceStats } from "../api/types";
import { useAppStore } from "../stores/app";
import { openSession } from "../composables/openSession";
import { subscribeWidgetEvents } from "../composables/widgetEvents";
import { formatTokens } from "../utils/format";

/**
 * The workspace-level demo widget: this workspace's conversations, with each one's message count
 * and token use.
 *
 * It exists to prove the framework end to end rather than to be useful on its own, and the three
 * things it demonstrates are the three that are easy to get wrong:
 *
 * - **It reads the database**, through the object's own `/stats` endpoint rather than by counting
 *   what this client happens to have loaded. A workspace's conversations are not all in memory —
 *   `sessions` holds the current workspace's list, but nothing here has ever loaded their
 *   messages, so a client-side count could only ever be a guess.
 * - **It follows events**, because after a turn ends the numbers have moved and nothing in this
 *   component caused it. It refetches rather than computing, so the figure it shows is the one the
 *   database holds.
 * - **It is written against the store, with no props**, like every other component in the shell.
 *   `activeWorkspace` is the workspace it is showing, which also removes "which object am I for"
 *   from the component's own state.
 */
const { t } = useI18n();
const store = useAppStore();
const router = useRouter();

/**
 * `null` means "nothing has arrived yet", which the template reads as an unspecified state rather
 * than as zero — a widget that showed `0` while its first request was in flight would be stating
 * a figure it does not have. There is deliberately no `loading` flag on top of it: a refetch
 * happens on every turn, and a spinner that flashed after each one would be noise.
 */
const stats = ref<WorkspaceStats | null>(null);
const failed = ref(false);

async function load(): Promise<void> {
  const workspaceId = store.activeWorkspaceId;
  if (!workspaceId) {
    stats.value = null;
    return;
  }
  try {
    stats.value = await api.getWorkspaceStats(workspaceId);
    failed.value = false;
  } catch {
    // Reported inside the panel, never as a toast: a widget that cannot load its numbers is not
    // a failure of the conversation the user is having — the same split `fileTreeError` makes.
    failed.value = true;
  }
}

watch(() => store.activeWorkspaceId, load, { immediate: true });

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  // Everything that moves these numbers. `turn.finished` is the one that matters in practice —
  // it is emitted from the single point every turn ends at — and the session events cover the
  // list changing shape underneath the totals.
  unsubscribe = subscribeWidgetEvents((event) => {
    switch (event.type) {
      case "turn.finished":
      case "session.created":
      case "session.renamed":
      case "session.deleted":
        void load();
        break;
      default:
        break;
    }
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
  // Not scoped to the component the way a `watch` is, so this is the only thing that stops it
  // being called after the tab is closed.
  unsubscribe = null;
});
</script>

<template>
  <div class="widget-stat" data-testid="widget-workspace-stats">
    <div v-if="failed" class="widget-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="load">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <div class="widget-totals" :class="{ pending: !stats }">
        <div>
          <div class="widget-total-value" data-testid="widget-total-messages">
            {{ stats ? stats.messageCount : "—" }}
          </div>
          <div class="widget-total-label">{{ t("widgets.messages") }}</div>
        </div>
        <div>
          <div class="widget-total-value" data-testid="widget-total-tokens">
            {{ stats ? formatTokens(stats.totalTokens) : "—" }}
          </div>
          <div class="widget-total-label">{{ t("widgets.tokens") }}</div>
        </div>
      </div>

      <div v-if="stats && stats.sessions.length === 0" class="widget-empty">
        {{ t("widgets.workspaceStats.empty") }}
      </div>

      <ul v-else class="widget-session-list">
        <li v-for="row in stats?.sessions ?? []" :key="row.sessionId">
          <!--
            A row is a button that opens the conversation. A list that cannot be acted on is a
            demonstration of a list, and switching conversation is the obvious thing to want from
            a list of them.
          -->
          <button
            class="widget-session-row"
            :class="{ active: row.sessionId === store.activeSessionId }"
            data-testid="widget-session-row"
            :data-session-id="row.sessionId"
            @click="openSession(router, store, row.sessionId)"
          >
            <span class="truncate">{{ row.title }}</span>
            <span class="widget-row-figures">
              <span data-testid="widget-row-messages">{{ row.messageCount }}</span>
              <span data-testid="widget-row-tokens">{{ formatTokens(row.totalTokens) }}</span>
            </span>
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>
