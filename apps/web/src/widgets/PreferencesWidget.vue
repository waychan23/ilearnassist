<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PreferenceType, UserPreference } from "@ilearnassist/shared";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import { subscribeWidgetEvents } from "../composables/widgetEvents";
import Icon from "../components/Icon.vue";

/**
 * The preference panel: the standing requirements this conversation has recorded.
 *
 * **The data lives in this component**, like the diagram and insight panels. The store holds
 * state more than one place needs, and this list is read by one panel — the moment a second
 * surface reads it (a badge on the tab, a turn citing one), is the moment to move it.
 *
 * **It does subscribe to a widget event**, unlike the insight panel, and the difference is
 * exactly the rule `widgetEvents.ts` states: every change to the insight list is a decision made
 * *here*, while a preference is also written by the server — the agent's tool mid-turn, and the
 * selection action's extraction outside any turn. The component cannot see either, so
 * `preference.changed` is what tells it to re-read. `turn.finished` is deliberately not used:
 * the specific event already covers both writers, and waking on every turn would pay a fetch
 * for conversations where nothing was recorded.
 *
 * Deleting one goes through `confirm()` first, like every other destructive control the user
 * presses: a preference is a rule the conversation will stop following, and the dialog names
 * what goes away. A failure after the confirmation goes to the toast, the one global channel
 * the app has.
 */

const { t } = useI18n();
const store = useAppStore();

/** `null` before the first load, which is different from an empty list — see the template. */
const items = ref<UserPreference[] | null>(null);
const loadFailed = ref(false);

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    items.value = null;
    loadFailed.value = false;
    return;
  }
  try {
    const res = await api.listPreferences(sessionId);
    // A switch mid-request must not list one conversation's rules under another's.
    if (sessionId !== store.activeSessionId) return;
    items.value = res.preferences;
    loadFailed.value = false;
  } catch {
    if (sessionId !== store.activeSessionId) return;
    loadFailed.value = true;
  }
}

watch(
  () => store.activeSessionId,
  () => {
    items.value = null;
    loadFailed.value = false;
    void load();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    if (event.type !== "preference.changed") return;
    if (event.sessionId !== store.activeSessionId) return;
    void load();
  });
});
onBeforeUnmount(() => unsubscribe?.());

async function remove(item: UserPreference): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) return;
  const ok = await confirm({
    title: t("preferences.remove.title"),
    message: t("preferences.remove.message"),
    detail: t("preferences.remove.detail"),
    confirmText: t("preferences.remove.action"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deletePreference(sessionId, item.id);
    if (items.value) items.value = items.value.filter((p) => p.id !== item.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/** The two labels, spelled as literal keys so the catalog guard can see them. */
function typeLabel(type: PreferenceType): string {
  switch (type) {
    case "positive":
      return t("preferences.type.positive");
    case "negative":
      return t("preferences.type.negative");
  }
}
</script>

<template>
  <div class="preferences-widget" data-testid="widget-preferences">
    <div v-if="!store.activeSessionId" class="widget-empty">
      {{ t("widgets.preferences.noSession") }}
    </div>

    <div v-else-if="loadFailed" class="widget-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="load">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <div v-if="items === null" class="widget-empty"></div>

      <div v-else-if="items.length === 0" class="widget-empty" data-testid="preferences-empty">
        {{ t("widgets.preferences.empty") }}
      </div>

      <div v-else class="preferences-list" data-testid="preferences-list">
        <div
          v-for="item in items"
          :key="item.id"
          class="list-row pref-row"
          :data-preference-type="item.type"
        >
          <span class="pref-type" :data-preference-type="item.type">
            {{ typeLabel(item.type) }}
          </span>
          <span class="pref-content">{{ item.content }}</span>
          <div class="row-actions">
            <button
              class="icon-btn danger"
              data-testid="preference-delete"
              :title="t('common.delete')"
              :aria-label="t('common.delete')"
              @click="remove(item)"
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </div>

      <p class="pref-note">{{ t("widgets.preferences.note") }}</p>
    </template>
  </div>
</template>

<style scoped>
.pref-row {
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
}
.pref-type {
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-3);
  font-size: var(--fs-2);
  color: var(--text-3);
}
/* The two kinds, told apart by colour as well as by word: a positive and a negative rule about
   the same behaviour are opposite instructions, and scanning the list should show that at a
   glance. Both are existing palette tokens — see the design system. */
.pref-type[data-preference-type="positive"] {
  color: var(--success);
  border-color: var(--success);
}
.pref-type[data-preference-type="negative"] {
  color: var(--danger);
  border-color: var(--danger);
}
.pref-content {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  font-size: var(--fs-3);
  white-space: pre-wrap;
  word-break: break-word;
}
.pref-note {
  margin: var(--space-6) 0 0;
  color: var(--text-3);
  font-size: var(--fs-2);
}
</style>
