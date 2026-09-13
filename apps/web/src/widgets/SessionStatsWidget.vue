<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type { SessionStats } from "../api/types";
import { useAppStore } from "../stores/app";
import { subscribeWidgetEvents } from "../composables/widgetEvents";
import { formatTokens } from "../utils/format";

/**
 * The session-level demo widget: this conversation's message count and token use.
 *
 * The workspace widget's twin, and deliberately a separate component rather than a mode of it:
 * the two payloads differ (`WorkspaceStats` holds rows, this holds fields), so a merged component
 * would be a union-typed thing with two templates — more code, not less. What they share is
 * `formatTokens` and the fetch/error/refresh skeleton, which is fine to repeat once and would be
 * the moment to extract a `useWidgetData()` at the third.
 *
 * What differs is what it listens to, and that is the point: it refetches on `turn.finished` **for
 * this conversation only**, because the event carries the session id. A session widget that
 * reloaded on every other conversation's turn would be making requests nobody asked for.
 */
const { t } = useI18n();
const store = useAppStore();

/** `null` until the first reply, which the template shows as unspecified rather than as zero. */
const stats = ref<SessionStats | null>(null);
const failed = ref(false);

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    stats.value = null;
    return;
  }
  try {
    stats.value = await api.getSessionStats(sessionId);
    failed.value = false;
  } catch {
    // Inside the panel, not as a toast — see the workspace widget's note.
    failed.value = true;
  }
}

watch(() => store.activeSessionId, load, { immediate: true });

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    // Every branch checks the id. A `session.renamed` for another conversation changes nothing
    // here, and refetching for it would be a request with no purpose.
    switch (event.type) {
      case "turn.finished":
      case "session.renamed":
        if (event.sessionId === store.activeSessionId) void load();
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
</script>

<template>
  <div class="widget-stat" data-testid="widget-session-stats">
    <div v-if="!store.activeSession" class="widget-empty">
      {{ t("widgets.sessionStats.noSession") }}
    </div>

    <div v-else-if="failed" class="widget-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="load">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <div class="widget-totals" :class="{ pending: !stats }">
        <div>
          <div class="widget-total-value" data-testid="widget-session-messages">
            {{ stats ? stats.messageCount : "—" }}
          </div>
          <div class="widget-total-label">{{ t("widgets.messages") }}</div>
        </div>
        <div>
          <div class="widget-total-value" data-testid="widget-session-tokens">
            {{ stats ? formatTokens(stats.totalTokens) : "—" }}
          </div>
          <div class="widget-total-label">{{ t("widgets.tokens") }}</div>
        </div>
      </div>

      <!-- The three halves of the usage figure, named as the token popover names them. -->
      <dl class="widget-figures">
        <div>
          <dt>{{ t("message.usage.input") }}</dt>
          <dd data-testid="widget-session-input">
            {{ stats ? formatTokens(stats.inputTokens) : "—" }}
          </dd>
        </div>
        <div>
          <dt>{{ t("message.usage.output") }}</dt>
          <dd data-testid="widget-session-output">
            {{ stats ? formatTokens(stats.outputTokens) : "—" }}
          </dd>
        </div>
        <div>
          <dt>{{ t("widgets.sessionStats.context") }}</dt>
          <dd data-testid="widget-session-context">
            {{ stats ? formatTokens(stats.contextTokens) : "—" }}
          </dd>
        </div>
      </dl>
    </template>
  </div>
</template>
