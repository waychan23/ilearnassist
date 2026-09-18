<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type { WorkResource } from "../api/types";
import { useAppStore } from "../stores/app";
import { resourceCategory, resourceIsImage } from "../utils/resourceView";
import Icon from "./Icon.vue";
import type { IconName } from "../utils/icons";
import type { ActiveMention } from "../utils/mention";
import {
  REFERENCE_TABS,
  SOURCE_PILLS,
  buildOptions,
  flatten,
  stepActive,
  type ReferenceChoice,
  type ReferenceOption,
  type ReferenceTab,
  type SourcePill,
} from "../utils/referencePicker";

/**
 * The `@` picker: what this conversation can reference, narrowed by what has been typed.
 *
 * Two kinds of thing live in one list, and the tabs and pills are how a list that holds both
 * stays readable:
 *
 * - A **workspace** opens it — every file and conversation inside it becomes reference material
 *   for this conversation. Its row raises a chip and writes a session setting rather than
 *   travelling with the turn, because a grant persists: pointing at something once makes it
 *   readable on every later turn.
 * - A **reference** names one piece of material — a file or a kept page — and is staged for this
 *   turn.
 *
 * It asks the **server** for the reference rows on every keystroke, debounced, rather than filtering
 * a list it already has — the composer opens on every page, and the account's whole library is not
 * something to hold in memory for a control most turns never touch. Workspaces are the exception
 * and for a reason: the account has a handful, the store already holds them, and a round-trip to
 * filter three names would be a request per letter to answer a question already answered.
 *
 * The tabs and the pills are **component-local**. They describe what the user is looking at right
 * now, not anything the conversation owns, and putting them in the store would make two composers
 * share a filter.
 *
 * The parent owns the query and the caret; this owns the keyboard, because the keys it needs —
 * ArrowUp/Down/Enter/Escape — are the ones the composer would otherwise act on. `handleKey` is
 * how the composer asks "do you want this one", and it answers by consuming it.
 */

const props = defineProps<{
  /** The mention being typed, or `null` when there is none. */
  mention: ActiveMention | null;
}>();

const emit = defineEmits<{ pick: [choice: ReferenceChoice] }>();

const { t } = useI18n();
const store = useAppStore();

const sources = ref<WorkResource[]>([]);
const active = ref(0);
const open = ref(false);
const tab = ref<ReferenceTab>("all");
const pill = ref<SourcePill | null>(null);
/** The request in flight is ignored if a newer query has been typed since. */
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long typing must pause before the options are fetched.
 *
 * Two reasons, and the second is not a preference. A fetch per keystroke is one request per
 * letter for a menu that will be replaced a moment later; and the replacement *detaches the
 * rows*, so a click aimed at one lands on a node that no longer exists — which is how this was
 * found, by a browser spec timing out while waiting for a moving option to hold still.
 */
const DEBOUNCE_MS = 150;

async function load(query: string): Promise<void> {
  const mine = ++seq;
  try {
    const found = await api.listResources({ name: query });
    if (mine !== seq) return;
    // Not capped here. The cap belongs to the list's shape, per group — `buildOptions` — and the
    // pill filter runs over what came back, so truncating first would filter *after* the cut and
    // show fewer matches than exist.
    sources.value = found;
  } catch {
    // A picker that cannot load its options simply does not render them: the `@` the user typed
    // stays in the message, and the failure has no better home than here.
    sources.value = [];
  }
}

/**
 * The workspaces worth offering: the account's, minus the one this conversation is in.
 *
 * `@`-ing the workspace you are already in grants nothing — it is readable regardless — so a row
 * for it would be a reference that changes no behaviour.
 */
const offeredWorkspaces = computed(() =>
  store.workspaces.filter((w) => w.id !== store.activeWorkspaceId)
);

const groups = computed(() =>
  buildOptions({
    query: props.mention?.query ?? "",
    tab: tab.value,
    pill: pill.value,
    workspaces: offeredWorkspaces.value,
    sources: sources.value,
    grantedIds: store.scopedWorkspaceIds,
    isAllGranted: store.scopeIsAll,
    allLabel: t("composer.allWorkspaces"),
  })
);

/** One flat list for the keyboard, so an arrow key crosses a divider without knowing it exists. */
const rows = computed(() => flatten(groups.value));

watch(
  () => props.mention?.query ?? null,
  (query) => {
    if (timer !== null) clearTimeout(timer);

    // Closing is immediate: the picker is gone the moment the mention is, and waiting to hide
    // it would leave a menu over a sentence the user has already moved on from.
    if (query === null || props.mention === null) {
      open.value = false;
      sources.value = [];
      return;
    }

    // Opening is immediate too, so `@` alone shows the picker straight away and the fetch
    // fills it in. Only the fetch waits.
    open.value = true;
    active.value = 0;
    timer = setTimeout(() => void load(query), DEBOUNCE_MS);
  },
  { immediate: true }
);

// The list is rebuilt from three inputs, and the highlight belongs to the list rather than to the
// query — a tab or a pill that leaves it where it was points at whatever now happens to be there.
watch([tab, pill], () => {
  active.value = 0;
});

/**
 * The label of a tab or a group heading. A `switch` with a literal `t()` per case, not a table
 * keyed by id: `catalog.test.ts` finds keys by scanning for `t("…")` literals, so a key reached
 * through an object property is invisible to it and its dead-key scan then fails the build. The
 * same shape `widgets/registry.ts` uses, and for the same reason.
 */
function tabLabel(id: ReferenceTab): string {
  switch (id) {
    case "all":
      return t("composer.tabAll");
    case "workspace":
      return t("composer.tabWorkspace");
    case "source":
      return t("composer.tabSource");
  }
}

function pillLabel(id: SourcePill): string {
  switch (id) {
    case "image":
      return t("composer.pillImage");
    case "text":
      return t("composer.pillText");
    case "code":
      return t("composer.pillCode");
    case "other":
      return t("composer.pillOther");
  }
}

/** `image` and `diagram` are the two shapes worth telling apart at a glance; the rest are files. */
function iconOf(row: ReferenceOption): IconName {
  if (row.kind === "all-workspaces") return "list-tree";
  if (row.kind === "workspace") return "folder";
  const resource = sources.value.find((s) => `src:${s.id}` === row.key);
  if (resource && resourceIsImage(resource)) return "image";
  if (resource && resourceCategory(resource) === "diagram") return "diagram";
  return "file";
}

function setTab(id: ReferenceTab): void {
  tab.value = id;
  // A pill narrows sources, and the workspaces tab shows none — leaving one armed would make the
  // next tab look broken. Cleared rather than remembered, because the tabs are a filter pair and
  // only one of them can be in force.
  if (id === "workspace") pill.value = null;
}

function togglePill(id: SourcePill): void {
  pill.value = pill.value === id ? null : id;
}

/**
 * Whether this component consumed the key.
 *
 * The picker's **frame is up while it is still fetching**, because the tabs and the pills are the
 * control and an empty list still needs them. That makes a bare `rows.length === 0` a bad guard:
 * it would hand Enter back to the composer during the debounce, and the composer's Enter *sends*
 * — putting a half-typed `@repo` into the conversation.
 *
 * So Enter is consumed whenever the picker is open, rows or not. With nothing highlighted it does
 * nothing, which is what every mention picker does and what the empty state on screen already
 * says; Escape closes the picker and the next Enter sends. **Tab is deliberately the exception**
 * and is only consumed when there is a row to take: it cannot send anything, so trapping focus in
 * the textarea for no reason would be the worse of the two.
 */
function handleKey(event: KeyboardEvent): boolean {
  if (!open.value) return false;
  const list = rows.value;

  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp":
      // Left to the caret when there is nothing to move through — the list is empty, and a
      // consumed arrow key would be one that visibly did nothing.
      if (list.length === 0) return false;
      active.value = stepActive(active.value, event.key === "ArrowDown" ? 1 : -1, list.length);
      break;
    case "Enter":
      if (list.length === 0) break;
      choose(list[active.value]!);
      break;
    case "Tab":
      if (list.length === 0) return false;
      choose(list[active.value]!);
      break;
    case "Escape":
      // Closes the picker and *not* the composer: the `@` stays, and the user carries on
      // typing a name for something the picker could not find.
      open.value = false;
      break;
    default:
      return false;
  }

  event.preventDefault();
  return true;
}

function choose(row: ReferenceOption): void {
  open.value = false;
  if (row.kind === "all-workspaces") {
    emit("pick", { kind: "scope", all: true, name: row.name });
    return;
  }
  if (row.kind === "workspace") {
    emit("pick", {
      kind: "scope",
      all: false,
      workspaceId: row.key.slice("ws:".length),
      name: row.name,
    });
    return;
  }
  const resource = sources.value.find((s) => `src:${s.id}` === row.key);
  if (resource) emit("pick", { kind: "resource", resource });
}

defineExpose({ handleKey });
</script>

<template>
  <div v-if="open" class="mention-picker" data-testid="mention-picker">
    <div class="mention-filters">
      <div class="segmented mention-tabs">
        <button
          v-for="id in REFERENCE_TABS"
          :key="id"
          class="segment"
          type="button"
          :aria-pressed="tab === id"
          :data-testid="`mention-tab-${id}`"
          @mousedown.prevent="setTab(id)"
        >
          {{ tabLabel(id) }}
        </button>
      </div>

      <!--
        The type filter, and it is absent on the workspaces tab rather than disabled there: a
        workspace has no source type, so a control that provably cannot change the list is a
        control that lies about what it does.
      -->
      <div v-if="tab !== 'workspace'" class="mention-pills">
        <button
          v-for="id in SOURCE_PILLS"
          :key="id"
          class="mention-pill"
          type="button"
          :aria-pressed="pill === id"
          :data-testid="`mention-pill-${id}`"
          @mousedown.prevent="togglePill(id)"
        >
          {{ pillLabel(id) }}
        </button>
      </div>
    </div>

    <div v-for="group in groups" :key="group.kind" class="mention-group">
      <div class="mention-heading" data-testid="mention-heading">
        {{ tabLabel(group.kind === "workspace" ? "workspace" : "source") }}
      </div>
      <button
        v-for="row in group.options"
        :key="row.key"
        class="mention-option"
        :class="{ active: rows.indexOf(row) === active, granted: row.granted }"
        data-testid="mention-option"
        :data-kind="row.kind"
        :aria-selected="rows.indexOf(row) === active"
        @mousedown.prevent="choose(row)"
      >
        <Icon :name="iconOf(row)" />
        <span class="label truncate">{{ row.name }}</span>
        <span class="where truncate">{{ row.where }}</span>
      </button>
      <div v-if="group.hidden > 0" class="mention-more">
        {{ t("composer.moreHidden", { count: group.hidden }) }}
      </div>
    </div>

    <!--
      Nothing found, said out loud. Silence would read as "still looking" for a query the server
      has already answered — and the user's next move differs: keep typing, or open the browser.
    -->
    <div v-if="rows.length === 0" class="mention-empty" data-testid="mention-empty">
      <template v-if="tab === 'workspace'">{{ t("composer.noWorkspaceMatch") }}</template>
      <template v-else-if="props.mention?.query">{{ t("composer.noSourceMatch") }}</template>
      <template v-else>{{ t("composer.noSources") }}</template>
    </div>
  </div>
</template>

<style scoped>
/*
 * Above the composer rather than below it: the composer sits at the bottom of the window, and a
 * menu below the textarea would be off-screen. Absolute inside the surface, which is where the
 * caret is.
 */
.mention-picker {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: var(--space-4);
  right: var(--space-4);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  max-height: 40vh;
  overflow: auto;
  padding: var(--space-2);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-popover);
}
/* The two filters sit together at the top and stay there while the rows scroll under them. */
.mention-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}
.mention-tabs {
  font-size: var(--fs-2);
}
/*
 * A pill is a toggle, not a segment: the type filter is multi-meaning in the sense that each pill
 * is its own on/off, while a segmented control is one choice among a few. It is drawn lighter and
 * rounder than `.segment` so the two controls sitting side by side are not mistaken for one.
 */
.mention-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.mention-pill {
  padding: var(--space-1) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: none;
  color: var(--text-3);
  font-family: inherit;
  font-size: var(--fs-1);
  cursor: pointer;
}
.mention-pill:hover {
  color: var(--text-2);
}
/* Keyed on the attribute, so the pill that is *announced* as on is the one *painted* as on. */
.mention-pill[aria-pressed="true"] {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--text);
}
.mention-group {
  display: flex;
  flex-direction: column;
}
/* The divider between kinds, and the heading that says which kind follows it. */
.mention-heading {
  padding: var(--space-3) var(--space-4) var(--space-1);
  color: var(--text-3);
  font-size: var(--fs-1);
}
.mention-group + .mention-group .mention-heading {
  border-top: 1px solid var(--border);
  margin-top: var(--space-2);
}
.mention-option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-3);
  text-align: left;
  cursor: pointer;
}
.mention-option.active,
.mention-option:hover {
  background: var(--panel-2);
  color: var(--text);
}
/* Already readable under this conversation's grant — a row that looked unpicked would be a bug
   report waiting to happen. */
.mention-option.granted {
  color: var(--text);
  opacity: 0.65;
}
.mention-option .label {
  min-width: 0;
  flex: 1;
}
.mention-option .where {
  color: var(--text-3);
  font-size: var(--fs-2);
  max-width: 12ch;
}
.mention-more {
  padding: 0 var(--space-4) var(--space-2);
  color: var(--text-3);
  font-size: var(--fs-1);
}
.mention-empty {
  padding: var(--space-4);
  color: var(--text-3);
  font-size: var(--fs-2);
}
</style>
