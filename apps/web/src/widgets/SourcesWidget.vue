<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import { subscribeWidgetEvents } from "../composables/widgetEvents";
import { isOpenableUrl, openExternal } from "../utils/externalLink";
import type { Source, SourceCategory } from "../api/types";
import Icon from "../components/Icon.vue";

/**
 * What this conversation is working from.
 *
 * A **viewer** that brings no tools. The model already reaches this material through
 * `read_document` and `ila_query`, which exist whether or not a panel is installed — binding
 * anything here would mean the model could find only what somebody happened to be looking at,
 * which is the wrong way round.
 *
 * ### The list is the conversation's, not the model's
 *
 * `GET /api/sources?sessionId=…`, whose predicate is "held by this conversation **or** linked
 * into it" — its own files, plus every upload, page and `@`-reference the conversation has
 * taken in. Deliberately *not* `/api/sessions/:id/sources`, which is the union with the
 * workspace and answers a different question: that one is what a turn may **read** (the
 * whitelist `read_document` is bound to), and it would list a workspace's whole corpus beside
 * the three files this conversation is actually about.
 *
 * ### Compact, and deliberately not a manager
 *
 * One filter strip and rows, nothing else. **No folders, no rename, no move, no delete**: a
 * conversation's material is written by the agent and by what the user references, and the
 * place it gets organised is the library dialog, which the chat header opens. A tree here
 * would be a second, weaker file manager for a directory the user did not lay out.
 *
 * The category filter is **client-side**, unlike the browser's. Two reasons, and both are about
 * this being one conversation rather than an account: the option list is derived from the rows
 * already fetched rather than needing the browser's second scope-only query (the server cannot
 * answer "which categories exist" in the same request), and a filter click costs no request at
 * all — which also keeps the server's bounded filesystem reconcile, which runs at the top of
 * every `GET /api/sources`, off a control the user may press repeatedly.
 */

const { t } = useI18n();
const store = useAppStore();

const rows = ref<Source[]>([]);
const failed = ref(false);
/** The chosen category, or `""` for all of them. An empty `<select>` value is not `undefined`. */
const category = ref("");

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    rows.value = [];
    failed.value = false;
    return;
  }
  try {
    const res = await api.listSources({ sessionId });
    // A switch mid-request must not list one conversation's material under another's.
    if (sessionId !== store.activeSessionId) return;
    rows.value = res;
    failed.value = false;
  } catch {
    if (sessionId !== store.activeSessionId) return;
    failed.value = true;
  }
}

watch(
  () => store.activeSessionId,
  () => {
    rows.value = [];
    failed.value = false;
    category.value = "";
    void load();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    /*
     * `turn.finished`, because a turn is what links a `@`-reference and what a tool writes a file
     * through — and there is no narrower event to ride: nothing announces "a source was added",
     * because the client is what asked for every addition and the store already knows. A library
     * upload lands in a *workspace*, which this list does not show.
     *
     * `library.changed` is the exception, and the note export is why it is one: that run is the
     * *server* writing sources, with no turn anywhere near it, so nothing local knows the list
     * moved. Emitted only when the run actually changed something.
     */
    if (
      (event.type === "turn.finished" || event.type === "library.changed") &&
      event.sessionId === store.activeSessionId
    ) {
      void load();
    }
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

/**
 * The order the options appear in — this panel's, not the rows'.
 *
 * Ordered by what a learner recognises first rather than by the shared union's own order, and
 * typed as that union so a member added there is a `vue-tsc` error here rather than a category
 * that silently never appears in the filter. The *labels* need no work at all: `sources.category.*`
 * is a catalog key per value already, and `catalog.test.ts` allows the prefix.
 */
const CATEGORY_ORDER: readonly SourceCategory[] = [
  "page",
  "document",
  "image",
  "diagram",
  "text",
  "markdown",
  "code",
  "other",
];

/** The categories actually present, in that order. */
const presentCategories = computed(() => {
  const seen = new Set(rows.value.map((r) => r.category));
  return CATEGORY_ORDER.filter((c) => seen.has(c));
});

const visible = computed(() =>
  category.value ? rows.value.filter((r) => r.category === category.value) : rows.value
);

/** The icon rule the browser uses for its rows, so one file reads the same in both places. */
function iconFor(source: Source): "image" | "diagram" | "file" {
  if (source.kind === "image") return "image";
  return source.category === "diagram" ? "diagram" : "file";
}

/**
 * Follow a page to where it came from — the same control the library dialog's rows carry, and
 * deliberately the same helper: the confirmation, the scheme check and the `noopener` are
 * `utils/externalLink.ts`'s, so the two surfaces cannot drift into asking different questions
 * before leaving for the same kind of destination.
 */
function openBrowser(source: Source): void {
  if (!source.url) return;
  void openExternal(source.url);
}
</script>

<template>
  <div class="sources-widget" data-testid="widget-sources">
    <div v-if="!store.activeSession" class="widget-empty">
      {{ t("widgets.sources.noSession") }}
    </div>

    <div v-else-if="failed" class="widget-error">
      <span>{{ t("widgets.sources.failed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="load">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <!--
        The strip appears only once there is something to narrow. A filter over an empty list is
        a control that does nothing, and the empty state below is the sentence that helps.
      -->
      <div v-if="rows.length > 0" class="sources-filter">
        <select
          v-model="category"
          class="input sources-category"
          data-testid="sources-filter"
          :aria-label="t('sources.filterCategory')"
        >
          <option value="">{{ t("sources.allCategories") }}</option>
          <option v-for="c in presentCategories" :key="c" :value="c">
            {{ t(`sources.category.${c}`) }}
          </option>
        </select>
        <span class="badge muted" data-testid="sources-count">{{ visible.length }}</span>
      </div>

      <div v-if="rows.length === 0" class="widget-empty" data-testid="sources-empty">
        {{ t("widgets.sources.empty") }}
      </div>
      <!-- A filter that matches nothing is a different sentence from a list that is empty. -->
      <div v-else-if="visible.length === 0" class="widget-empty" data-testid="sources-no-match">
        {{ t("widgets.sources.noMatch") }}
      </div>

      <ul v-else class="sources-list" data-testid="sources-list">
        <li v-for="row in visible" :key="row.id" class="sources-row">
          <button
            class="sources-open"
            type="button"
            data-testid="source-row"
            :title="t('sources.preview', { name: row.name })"
            @click="store.openSourceFile(row)"
          >
            <span class="sources-icon" :class="{ 'is-image': row.kind === 'image' }">
              <Icon :name="iconFor(row)" />
            </span>
            <span class="sources-name truncate">{{ row.name }}</span>
            <span v-if="row.missing" class="badge danger">{{ t("widgets.sources.missing") }}</span>
            <span v-else class="badge muted">{{ t(`sources.category.${row.category}`) }}</span>
          </button>
          <!-- A sibling of the row's own control, never a child of it: a button inside a button
               is invalid. Only a page has somewhere to go. -->
          <button
            v-if="isOpenableUrl(row.url)"
            class="icon-btn"
            type="button"
            :title="t('sources.openInBrowser')"
            :aria-label="t('sources.openInBrowser')"
            data-testid="source-open-browser"
            @click="openBrowser(row)"
          >
            <Icon name="link" />
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.sources-widget {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: var(--space-3);
}
/*
 * One strip, a full-width control and a count — the browser's toolbar reduced to what one
 * conversation needs. The count is what makes the filter honest: it says how many of the
 * conversation's sources the current selection is hiding.
 */
.sources-filter {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
}
.sources-category {
  flex: 1;
  min-width: 0;
}
.sources-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/*
 * The row is a flex line rather than the open control alone, because a second control sits beside
 * it — and the open control takes the room that is left rather than a fixed `100%`, which would
 * push its sibling out of the row.
 */
.sources-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sources-open {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  font-size: var(--fs-3);
  text-align: left;
  cursor: pointer;
}
.sources-open:hover {
  background: var(--panel-2);
}
.sources-icon {
  display: flex;
  flex: none;
  color: var(--text-3);
}
.sources-icon.is-image {
  color: var(--accent);
}
.sources-name {
  flex: 1;
  min-width: 0;
  color: var(--text);
}
</style>
