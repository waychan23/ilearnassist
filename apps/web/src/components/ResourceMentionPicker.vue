<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type { Note, WorkResource } from "../api/types";
import { useAppStore } from "../stores/app";
import { resourceCategory, resourceIsImage } from "../utils/resourceView";
import { figureRows, type FigureRow } from "../utils/figures";
import Icon from "./Icon.vue";
import type { IconName } from "../utils/icons";
import type { ActiveMention } from "../utils/mention";
import {
  LIST_PAGE,
  REFERENCE_TABS,
  RESOURCE_PILLS,
  buildReferenceOptions,
  flatten,
  stepActive,
  type ReferenceChoice,
  type ReferenceGroupKind,
  type ReferenceOption,
  type ReferenceTab,
  type ResourcePill,
} from "../utils/resourcePicker";

/**
 * The `@` picker: what this conversation can reference, narrowed by what has been typed.
 *
 * Three kinds of thing live in one list, and the tabs, the pills and the workspace filter are how
 * a list that holds all of them stays readable:
 *
 * - A **workspace** opens it — every file and conversation inside it becomes reference material
 *   for this conversation. Its row raises a chip and writes a session setting rather than
 *   travelling with the turn, because a grant persists: pointing at something once makes it
 *   readable on every later turn.
 * - A **reference** names one piece of material — a file or a kept page — and is staged for this
 *   turn.
 * - A **图, a 表 or a 笔记** is one of the objects this conversation itself made, staged as the same
 *   `TurnReference` 追问 sends. 资料 therefore means "material" rather than "files", which is why
 *   the three are drawn under their own headings: a 图 and a 表 can share a name, and a flat list
 *   would show two identical rows.
 *
 * It asks the **server** for the reference rows on every keystroke, debounced, rather than filtering
 * a list it already has — the composer opens on every page, and the account's whole library is not
 * something to hold in memory for a control most turns never touch. The other two lists are the
 * exception, each for its own reason: the account's workspaces are a handful the store already
 * holds, and the conversation's own objects are **query-independent** — the same diagrams at every
 * letter — so fetching them per keystroke would pay repeatedly for one answer.
 *
 * The tabs, the pills and the workspace filter are **component-local**. They describe what the user
 * is looking at right now, not anything the conversation owns, and putting them in the store would
 * make two composers share a filter.
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
const figures = ref<FigureRow[]>([]);
const notes = ref<Note[]>([]);
const active = ref(0);
const open = ref(false);
const tab = ref<ReferenceTab>("all");
const pill = ref<ResourcePill | null>(null);
/**
 * Which workspace the 资料 list is narrowed to, or `""` for all of them.
 *
 * The empty string rather than `undefined` or `null`, and the reason is the `<select>` it is bound
 * to: a select bound to an absent value paints blank instead of its placeholder option, so the
 * value in the template has to be the value in the arithmetic. One conversion at the request.
 */
const sourceWorkspaceId = ref("");
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
    const found = await api.listResources({
      name: query,
      // The endpoint's `workspaceId` already means "this workspace's own material *and* its
      // conversations'", which is the right reading of "filed under this workspace".
      ...(sourceWorkspaceId.value ? { workspaceId: sourceWorkspaceId.value } : {}),
    });
    if (mine !== seq) return;
    // Not capped here. The cap belongs to the list's shape, per group — `buildReferenceOptions` — and the
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
 * The conversation's own objects, read once per open.
 *
 * All three calls at once, and none of them waited on by the picker's own frame: the menu is up
 * the moment `@` is typed and these rows appear under it when they arrive. A failure leaves its
 * group empty rather than reporting — the same answer `load` gives, and for the same reason.
 */
async function loadObjects(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    figures.value = [];
    notes.value = [];
    return;
  }
  const [diagrams, tables, found] = await Promise.all([
    api.listSessionDiagrams(sessionId).catch(() => null),
    api.listSessionTables(sessionId).catch(() => null),
    api.listNotes(sessionId).catch(() => null),
  ]);
  // A reply for a conversation the reader has since left is dropped, the rule the notes panel
  // makes: two conversations' objects are two lists.
  if (store.activeSessionId !== sessionId) return;
  figures.value = figureRows(diagrams?.diagrams ?? [], tables?.tables ?? []);
  notes.value = found?.notes ?? [];
}

/**
 * The workspaces worth offering as a *grant*: the account's, minus the one this conversation is in.
 *
 * `@`-ing the workspace you are already in grants nothing — it is readable regardless — so a row
 * for it would be a reference that changes no behaviour.
 */
const offeredWorkspaces = computed(() =>
  store.workspaces.filter((w) => w.id !== store.activeWorkspaceId)
);

/**
 * The workspaces the 资料 list can be narrowed to, and this one **includes the current one**.
 *
 * Deliberately not `offeredWorkspaces`: that answers "which workspace could I open", while this
 * answers "where is this material filed". A reader looking for a file they uploaded into this very
 * workspace would find it missing from the filter that exists to find it.
 */
const filterWorkspaces = computed(() => store.workspaces);

/**
 * How many rows the list is currently showing.
 *
 * Grows by `LIST_PAGE` per press of the pager until nothing is left. It is **display state and
 * nothing else** — the rows are all already in hand, because the account's match set arrives in
 * one reply and the picker has always filtered it client-side. So "load more" costs no request,
 * which is what makes a 100-row page a reasonable default rather than a heavy one.
 */
const shown = ref(LIST_PAGE);

const options = computed(() =>
  buildReferenceOptions({
    query: props.mention?.query ?? "",
    tab: tab.value,
    pill: pill.value,
    workspaces: offeredWorkspaces.value,
    sources: sources.value,
    figures: figures.value,
    notes: notes.value,
    grantedIds: store.scopedWorkspaceIds,
    isAllGranted: store.scopeIsAll,
    allLabel: t("composer.allWorkspaces"),
    limit: shown.value,
  })
);

/** One flat list for the keyboard, so an arrow key crosses a divider without knowing it exists. */
const rows = computed(() => flatten(options.value.groups));

/** Ask for the next page. Nothing is fetched — see `shown`. */
function loadMore(): void {
  shown.value += LIST_PAGE;
}

watch(
  () => props.mention?.query ?? null,
  (query) => {
    if (timer !== null) clearTimeout(timer);

    // Closing is immediate: the picker is gone the moment the mention is, and waiting to hide
    // it would leave a menu over a sentence the user has already moved on from.
    if (query === null || props.mention === null) {
      open.value = false;
      sources.value = [];
      figures.value = [];
      notes.value = [];
      return;
    }

    // Opening is immediate too, so `@` alone shows the picker straight away and the fetch
    // fills it in. Only the fetch waits.
    const opening = !open.value;
    open.value = true;
    active.value = 0;
    /*
     * The objects load on **opening**, not on every keystroke — and that is not an optimisation,
     * it is the rule the debounce above exists for. This watcher fires per character, so a load
     * per keystroke would replace the rows under the pointer three times a letter and a click
     * aimed at one would land on a detached node. They are query-independent anyway: the same
     * diagrams at every letter.
     */
    if (opening) void loadObjects();
    timer = setTimeout(() => void load(query), DEBOUNCE_MS);
  },
  { immediate: true }
);

/*
 * The list is rebuilt from four inputs, and the highlight belongs to the list rather than to the
 * query — a filter that leaves it where it was points at whatever now happens to be there.
 *
 * The window goes back to one page with them, and it has to: a different list is a different set
 * of rows, so a window opened to 300 for a search that returned 400 would silently be 300 deep on
 * a list of four. `loadMore` sits outside this watcher on purpose — it grows the window *without*
 * changing the list, which is the whole distinction between paging and filtering.
 */
watch([tab, pill, sourceWorkspaceId, () => props.mention?.query ?? ""], () => {
  active.value = 0;
  shown.value = LIST_PAGE;
});

// Only the filter the *server* answers has to be asked again; the other three inputs are answered
// from what is already in hand.
watch(sourceWorkspaceId, () => void load(props.mention?.query ?? ""));

/**
 * The label of a tab. A `switch` with a literal `t()` per case, not a table keyed by id:
 * `catalog.test.ts` finds keys by scanning for `t("…")` literals, so a key reached through an
 * object property is invisible to it and its dead-key scan then fails the build. The same shape
 * `widgets/registry.ts` uses, and for the same reason.
 */
function tabLabel(id: ReferenceTab): string {
  switch (id) {
    case "all":
      return t("composer.tabAll");
    case "workspace":
      return t("composer.tabWorkspace");
    case "resource":
      return t("composer.tabSource");
  }
}

/**
 * The heading over a group, which **is** the divider between kinds.
 *
 * Five cases rather than three, because the two groups that are not objects are named by the tabs
 * they belong to: a workspace row is a workspace and a material row is 资料, and giving them
 * headings of their own would be two more words for the same two things.
 */
function groupLabel(kind: ReferenceGroupKind): string {
  switch (kind) {
    case "workspace":
      return t("composer.tabWorkspace");
    case "resource":
      return t("composer.tabSource");
    case "diagram":
      return t("composer.pickGroupDiagram");
    case "table":
      return t("composer.pickGroupTable");
    case "note":
      return t("composer.pickGroupNote");
  }
}

function pillLabel(id: ResourcePill): string {
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

/**
 * The mark beside a row.
 *
 * `image` and `diagram` are the two shapes worth telling apart at a glance; the rest are files.
 * The three object kinds are read from the row's own `kind` rather than looked up in `sources`,
 * which is what makes a 图 and a 表 distinguishable at all in a list that can hold both under one
 * name.
 */
function iconOf(row: ReferenceOption): IconName {
  switch (row.kind) {
    case "all-workspaces":
      return "list-tree";
    case "workspace":
      return "folder";
    case "diagram":
      return "diagram";
    case "table":
      return "table";
    case "note":
      return "note";
    case "resource":
      break;
  }
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

function togglePill(id: ResourcePill): void {
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

/**
 * A row was picked.
 *
 * `ref` is tested before the source lookup, and that is the whole of how a 图, a 表 or a 笔记
 * reaches the composer: they are the only rows carrying one, and the key spaces are disjoint
 * (`diagram:`/`table:`/`note:` against `src:`), so the order is a convenience rather than a rule.
 * What makes it safe is that a `src:` row never carries a `ref` at all.
 */
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
  if (row.ref) {
    emit("pick", { kind: "turnRef", ref: row.ref, name: row.name });
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
          v-for="id in RESOURCE_PILLS"
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

      <!--
        Where the material is filed. Only on the sources tab, which is the tab whose list it
        narrows — on the everything tab the pills are already the control for that list, and two
        filters over one group is a question nobody can answer about which of them won.

        `mousedown` is stopped but not prevented, which is the opposite of what the pills do: a
        pill is a button that keeps the textarea focused, while a select needs the focus to open
        at all. What keeps the picker from closing under it is the composer's own blur handler.
      -->
      <select
        v-if="tab === 'resource'"
        v-model="sourceWorkspaceId"
        class="mention-select"
        data-testid="mention-workspace"
        :aria-label="t('composer.sourceWorkspace')"
        @mousedown.stop
      >
        <option value="">{{ t("composer.anyWorkspace") }}</option>
        <option v-for="w in filterWorkspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
      </select>
    </div>

    <div v-for="group in options.groups" :key="group.kind" class="mention-group">
      <div class="mention-heading" data-testid="mention-heading">
        {{ groupLabel(group.kind) }}
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
    </div>

    <!--
      What the window cut, and the way to see it. One control rather than one per group, because
      the window is one: the count is only useful if it is how many more a press will actually
      produce, and a per-group count under a shared window would promise a group's rows that the
      next page spends on an earlier group.

      `mousedown.prevent`, like the rows: this is inside the picker, and a press that blurred the
      textarea would close the very menu it is paging.
    -->
    <button
      v-if="options.hidden > 0"
      type="button"
      class="mention-more"
      data-testid="mention-more"
      @mousedown.prevent="loadMore"
    >
      {{ t("composer.loadMore", { count: options.hidden }) }}
    </button>

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
/*
 * The workspace filter sits at the right end of the filter row, and takes a compact width: it is a
 * narrowing of one group rather than the control the picker opens on, so it should not read as
 * loudly as the tabs beside it.
 */
.mention-select {
  margin-left: auto;
  max-width: 14ch;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-2);
  font-family: inherit;
  font-size: var(--fs-1);
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
/*
 * The pager. A full-width button rather than a line of small print, because it is the only way to
 * reach the rest of the list — and it sits outside `.mention-group` so it reads as belonging to
 * the list rather than to whichever group happens to be last.
 */
.mention-more {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  border-top: 1px solid var(--border);
  background: none;
  color: var(--accent);
  font-family: inherit;
  font-size: var(--fs-2);
  text-align: center;
  cursor: pointer;
}
.mention-more:hover {
  background: var(--panel-2);
}
.mention-empty {
  padding: var(--space-4);
  color: var(--text-3);
  font-size: var(--fs-2);
}
</style>
