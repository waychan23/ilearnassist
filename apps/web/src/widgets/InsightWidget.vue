<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  INSIGHT_TYPES,
  isInsightType,
  type Insight,
  type InsightType,
} from "@ilearnassist/shared";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import Icon from "../components/Icon.vue";

/**
 * The insight panel: typed observations about the learner, from one reflection over the
 * conversation's own record.
 *
 * **The data lives in this component**, not in the store, like the diagram and thread widgets.
 * The store holds state more than one place needs, and this list is read by one panel; the
 * moment a second surface reads it — a count badge on the tab, a plan node citing an insight —
 * is the moment to move it, and that refactor is a plain move rather than a rewrite.
 *
 * **No widget event is subscribed to**, and that is deliberate rather than an omission. Every
 * change to this list is a decision made *here* — the user pressed generate, adopted or deleted
 * — so a subscription would be a second way to learn something the component already holds, and
 * two ways to learn one fact drift. A second tab does not live-refresh this list; neither does
 * anything else in this app.
 *
 * **The pass is expensive**, so nothing triggers it but a click. Installing the widget does not
 * start one, opening the tab does not start one, and the button is disabled while one runs.
 */

const { t } = useI18n();
const store = useAppStore();

/** `null` before the first load, which is a different thing from an empty list — see the template. */
const items = ref<Insight[] | null>(null);
/** A *load* failure: the list is unknown, which is the widget-contract "offer a retry" case. */
const loadFailed = ref(false);
const generating = ref(false);
/** A *generate* failure: the list is whatever it was, and the reason is said above it. */
const generateFailed = ref(false);

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    items.value = null;
    loadFailed.value = false;
    return;
  }
  try {
    const res = await api.listInsights(sessionId);
    // A switch mid-request must not list one conversation's observations under another's.
    if (sessionId !== store.activeSessionId) return;
    items.value = res.items;
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
    generateFailed.value = false;
    void load();
  },
  { immediate: true }
);

async function generate(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId || generating.value) return;
  generating.value = true;
  generateFailed.value = false;
  try {
    const res = await api.generateInsights(sessionId);
    if (sessionId !== store.activeSessionId) return;
    // A 200 with `status: "failed"`: the pass ran and produced nothing usable, and the rows are
    // exactly what they were. Reported as its own thing rather than as an empty list, because
    // "it found nothing" is a claim about the conversation and this is a claim about the call.
    if (res.status === "failed") generateFailed.value = true;
    else items.value = res.items;
  } catch {
    if (sessionId !== store.activeSessionId) return;
    generateFailed.value = true;
  } finally {
    generating.value = false;
  }
}

async function toggleAdopted(item: Insight): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) return;
  try {
    const { item: updated } = await api.setInsightAdopted(sessionId, item.id, {
      adopted: !item.adopted,
    });
    const list = items.value;
    if (!list) return;
    const index = list.findIndex((i) => i.id === item.id);
    // Adopted items sort first, but this local patch keeps the row where the reader's eye is
    // rather than making it jump the list — the next load restores the server's order.
    if (index !== -1) list[index] = updated;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function remove(item: Insight): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) return;
  try {
    await api.deleteInsight(sessionId, item.id);
    if (items.value) items.value = items.value.filter((i) => i.id !== item.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The list grouped by type, in `INSIGHT_TYPES` order.
 *
 * Grouping is display only: nothing is stored per type, and the headings are translated at
 * render — the same rule the 计划/其他 thread headings follow. An empty group is dropped rather
 * than shown as a heading over nothing.
 */
const groups = computed(() => {
  const list = items.value ?? [];
  return INSIGHT_TYPES.map((type) => ({
    type,
    items: list.filter((i) => i.type === type),
  })).filter((g) => g.items.length > 0);
});

/** `widgets.insight.types.<id>` — a dynamic key, allowlisted narrowly in `catalog.test.ts`. */
function typeLabel(type: InsightType): string {
  // Through `isInsightType` rather than trusting the field: the type arrives from a model's
  // answer via the server's sanitiser, and a value outside the union would be a blank heading.
  return t(`widgets.insight.types.${isInsightType(type) ? type : "advice"}`);
}
</script>

<template>
  <div class="insight-widget" data-testid="widget-insight">
    <div v-if="!store.activeSessionId" class="widget-empty">
      {{ t("widgets.insight.noSession") }}
    </div>

    <div v-else-if="loadFailed" class="widget-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="load">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <div class="insight-toolbar">
        <button
          class="btn small"
          data-testid="insight-generate"
          :disabled="generating"
          @click="generate"
        >
          <Icon name="bulb" />
          {{ generating ? t("widgets.insight.generating") : t("widgets.insight.generate") }}
        </button>
        <span v-if="generating" class="insight-working" data-testid="insight-generating">
          {{ t("widgets.insight.generatingHint") }}
        </span>
      </div>

      <!-- The list is left exactly as it was, so the reason stands above it rather than
           replacing it: a failed pass costs nothing but the wait. -->
      <p v-if="generateFailed" class="insight-failed" data-testid="insight-failed">
        {{ t("widgets.insight.generateFailed") }}
      </p>

      <div v-if="items === null" class="widget-empty"></div>

      <div v-else-if="items.length === 0" class="widget-empty" data-testid="insight-empty">
        {{ t("widgets.insight.empty") }}
      </div>

      <div v-else class="insight-list" data-testid="insight-list">
        <template v-for="group in groups" :key="group.type">
          <div class="insight-group">{{ typeLabel(group.type) }}</div>
          <div
            v-for="item in group.items"
            :key="item.id"
            class="list-row insight-row"
            :data-insight-type="item.type"
            data-testid="insight-row"
          >
            <div class="insight-body">
              <div class="insight-title">
                <span v-if="item.adopted" class="badge">{{ t("widgets.insight.adoptedBadge") }}</span>
                {{ item.title }}
              </div>
              <div v-if="item.body" class="insight-text">{{ item.body }}</div>
            </div>
            <div class="row-actions">
              <!-- A toggle rather than a one-way door: a mis-click otherwise has no undo that
                   is not "delete", and deleting is a different statement. -->
              <!-- Keyed on `aria-pressed` in the styles, not a class: the segment controls
                   already establish that the thing *announced* as selected is the thing
                   *painted* as selected, and a class would be a second copy of one fact. -->
              <button
                class="icon-btn insight-adopt"
                data-testid="insight-adopt"
                :aria-pressed="item.adopted"
                :title="item.adopted ? t('widgets.insight.release') : t('widgets.insight.adopt')"
                :aria-label="item.adopted ? t('widgets.insight.release') : t('widgets.insight.adopt')"
                @click="toggleAdopted(item)"
              >
                <Icon name="check" />
              </button>
              <button
                class="icon-btn danger"
                data-testid="insight-delete"
                :title="t('common.delete')"
                :aria-label="t('common.delete')"
                @click="remove(item)"
              >
                <Icon name="trash" />
              </button>
            </div>
          </div>
        </template>
      </div>

      <p class="insight-note">{{ t("widgets.insight.keepNote") }}</p>
    </template>
  </div>
</template>

<style scoped>
.insight-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}
.insight-working {
  color: var(--text-3);
  font-size: var(--fs-2);
}
.insight-failed {
  margin: 0 0 var(--space-5);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius);
  background: var(--warning-bg);
  color: var(--text-2);
  font-size: var(--fs-2);
}
.insight-group {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin: var(--space-5) 0 var(--space-2);
}
.insight-row {
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
}
.insight-body {
  flex: 1;
  min-width: 0;
}
.insight-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-weight: 500;
}
.insight-text {
  color: var(--text-2);
  font-size: var(--fs-3);
  margin-top: var(--space-1);
  white-space: pre-wrap;
  word-break: break-word;
}
.insight-note {
  margin: var(--space-6) 0 0;
  color: var(--text-3);
  font-size: var(--fs-2);
}
/* The one state the button carries: adopted. Keyed on the attribute, so the control announced
   as pressed is the one drawn as pressed — see `.segment[aria-pressed="true"]` in the sheet. */
.insight-adopt[aria-pressed="true"] {
  color: var(--accent);
}
</style>
