<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, fileToBase64, type SourceFilterQuery } from "../../api/client";
import type { Session, Source, SourceCategory, SourceOrigin } from "../../api/types";
import { useAppStore } from "../../stores/app";
import { uiState } from "../../composables/ui";
import { confirm } from "../../composables/confirm";
import { translateParseError } from "../../utils/apiError";
import { isOpenableUrl, openExternal } from "../../utils/externalLink";
import { formatBytes } from "../../utils/format";
import { allGroupKeys, flattenSourceTree, groupSources } from "../../utils/sourceTree";
import AddSourceDialog from "./AddSourceDialog.vue";
import Icon from "../Icon.vue";

/**
 * The source browser: everything this account holds, filterable.
 *
 * It replaces a dialog that listed uploaded files, and the difference is the point — a source
 * is now an upload, a fetched page, a file the agent wrote into a workspace and a file it wrote
 * into a conversation. "What material do I have, and where did each piece come from" is the
 * question this answers, and neither half of it was answerable before: the old dialog could
 * not see a workspace file at all, and the file tree could not see an upload.
 *
 * ### One component, several front doors
 *
 * It opens from the workspace home (unfiltered — the boundary is the account) and from a
 * conversation (pre-filtered to that workspace). The caller says what it wants with two props:
 * `initial` is the filter set to open with, and `hidden` is the option groups that front door
 * has no business offering. That is deliberately *data* rather than a mode flag: a `mode`
 * would have to enumerate the combinations, and the third front door would be a third mode.
 *
 * ### Filtering is the server's
 *
 * Every control maps to a server-side filter, including the scope ones, because a workspace
 * with a `node_modules` in it has tens of thousands of rows and the browser's own list would
 * otherwise be that list. The one thing the server cannot answer is *which options exist* —
 * the MIME types present, the categories in use — so a second, scope-only query fills the
 * option lists. It is issued on open and when the scope changes, and never on a filter change:
 * narrowing the list must not delete the option you narrowed by.
 */

const props = defineProps<{
  /** The filter to open with. `workspaceId` is what pre-filters the conversation's front door. */
  initial?: SourceFilterQuery;
  /**
   * Option groups this caller does not offer. Anything not listed is shown.
   *
   * `workspace`/`session` matter most: a dialog opened from inside one workspace, for that
   * workspace, has no business offering a scope it will not honour.
   */
  hidden?: readonly (
    | "search"
    | "workspace"
    | "session"
    | "category"
    | "origin"
    | "mime"
    | "view"
    | "add"
  )[];
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const store = useAppStore();

/**
 * A filter object with every key present, as the empty string where there is no filter.
 *
 * **`undefined` is not `""` to a `<select>`.** A bound value with no matching `<option>` leaves
 * the control *blank* — not showing the placeholder option, which is the first thing a reader
 * looks at to learn what the control even filters. `?workspaceId=` absent arrives as `undefined`
 * and every select would render as an empty box, which is exactly how this shipped once.
 *
 * The keys are spelled out rather than spread-and-defaulted because this is the one place that
 * lists what the browser can filter by, and `Record<keyof SourceFilterQuery, string>` makes a
 * new filter a compile error here rather than a control that stays blank.
 */
function asFilters(input: SourceFilterQuery = {}): Record<keyof SourceFilterQuery, string> {
  return {
    name: input.name ?? "",
    workspaceId: input.workspaceId ?? "",
    sessionId: input.sessionId ?? "",
    category: input.category ?? "",
    origin: input.origin ?? "",
    mime: input.mime ?? "",
    storage: input.storage ?? "",
  };
}

/** What the controls currently say. Every key is a server filter; an empty one is absent. */
const filters = ref<SourceFilterQuery>(asFilters(props.initial));

/** Sources for the open scope, ignoring the filters — where the option lists come from. */
const scopeRows = ref<Source[]>([]);
const rows = ref<Source[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const view = ref<"flat" | "tree">("flat");
const expanded = ref<string[]>([]);
/** Whether the add dialog is open. */
const addOpen = ref(false);

const sessions = ref<Session[]>([]);

const shows = (option: string): boolean => !props.hidden?.includes(option as never);

const hasScope = computed(() => shows("workspace") || shows("session"));

/* --------------------------------- loading --------------------------------- */

/** The scope-only filter: what the option lists are drawn from. */
function scopeFilter(): SourceFilterQuery {
  return { workspaceId: filters.value.workspaceId, sessionId: filters.value.sessionId };
}

/*
 * Sequence numbers, because two loads of the same list overlap routinely.
 *
 * Opening the dialog starts one; changing a filter starts another a moment later. Responses do
 * not arrive in the order they were sent, and the loser used to *overwrite* the winner — so the
 * list could settle on the unfiltered answer while the controls said otherwise. Found by a
 * browser spec that opened the dialog, filtered by origin, and then saw every row again.
 *
 * The same shape `runPreview`'s `filePreviewSeq` uses: the reply that is not the latest is
 * dropped rather than rendered.
 */
let rowsSeq = 0;
let scopeSeq = 0;

async function loadScope(): Promise<void> {
  const seq = ++scopeSeq;
  try {
    const next = await api.listSources(scopeFilter());
    if (seq !== scopeSeq) return;
    scopeRows.value = next;
  } catch (e) {
    if (seq === scopeSeq) error.value = message(e);
  }
}

async function loadRows(): Promise<void> {
  const seq = ++rowsSeq;
  loading.value = true;
  try {
    const next = await api.listSources(filters.value);
    if (seq !== rowsSeq) return;
    rows.value = next;
    error.value = null;
  } catch (e) {
    // The previous rows stay: a filter that failed to apply should leave the reader looking at
    // what they had, not at an empty panel that reads as "nothing matched".
    if (seq === rowsSeq) error.value = message(e);
  } finally {
    // Only the latest request owns the flag, or an early reply would clear it while a later
    // one is still in flight — and `settle()` in the browser specs reads exactly this.
    if (seq === rowsSeq) loading.value = false;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The sessions the scope picker offers.
 *
 * Only for a *chosen* workspace: a session belongs to one, and a picker that listed every
 * conversation of every workspace would be a workspace picker wearing a different label.
 */
async function loadSessions(): Promise<void> {
  const workspaceId = filters.value.workspaceId;
  if (!workspaceId) {
    sessions.value = [];
    return;
  }
  try {
    sessions.value = await api.listSessions(workspaceId);
  } catch {
    // A picker with no options is not worth a second error message: the list below already
    // says whether the load worked, and this one is a convenience.
    sessions.value = [];
  }
}

/** The option values present in the open scope, so a filter offers only what exists. */
function present(key: "category" | "origin" | "mimeType"): string[] {
  const values = new Set<string>();
  for (const row of scopeRows.value) {
    const value = key === "mimeType" ? row.mimeType : row[key];
    if (value) values.add(value);
  }
  // The current selection is always offered, even if the scope has moved out from under it —
  // a `<select>` whose value is not among its options renders as blank.
  const chosen = filters.value[key === "mimeType" ? "mime" : key];
  if (chosen) values.add(chosen);
  return [...values].sort();
}

const categoryOptions = computed(() => present("category"));
const originOptions = computed(() => present("origin"));
const mimeOptions = computed(() => present("mimeType"));

/* --------------------------------- the tree -------------------------------- */

const groups = computed(() => groupSources(rows.value));
const lines = computed(() => flattenSourceTree(groups.value, expanded.value));
const allCollapsed = computed(() => expanded.value.length === 0);

function toggleGroup(key: string): void {
  expanded.value = expanded.value.includes(key)
    ? expanded.value.filter((k) => k !== key)
    : [...expanded.value, key];
}

/* --------------------------------- actions --------------------------------- */

const parseLabel = (source: Source): string => {
  if (source.parseStatus === "ready") {
    return source.parsedChars
      ? t("sources.parsedChars", { count: source.parsedChars })
      : t("sources.parsed");
  }
  if (source.parseStatus === "pending" || source.parseStatus === "parsing") return t("sources.parsing");
  if (source.parseStatus === "failed") {
    return translateParseError(source.parseErrorCode, undefined, source.parseError) ?? t("sources.parseFailed");
  }
  return "";
};

/** Where a row came from, in words: the sentence the flat view has instead of a tree. */
function originLabel(source: Source): string {
  const key = `sources.origin.${source.origin}` as const;
  const owner = source.ownerName ? ` · ${source.ownerName}` : "";
  return `${t(key)}${owner}`;
}

/**
 * A row's detail line: how big, and what became of it.
 *
 * Deliberately *not* the category — the row's icon is the kind, and this is the same line the
 * uploads dialog has always shown. `none` renders as nothing at all rather than as a sentence
 * about parsing, which would read as "still working on it" for a text file that never needed
 * extracting.
 */
function detailOf(source: Source): string {
  return [formatBytes(source.size), parseLabel(source)].filter(Boolean).join(" · ");
}

/**
 * Whether this row can be deleted from here, and how.
 *
 * A workspace file is deleted through the **file manager's** route, which moves its bytes to
 * the trash and soft-deletes the row together. Deleting it through the source route instead
 * would hide the row while the file stayed in the tree — and the next listing would reconcile
 * it straight back, which is a delete that visibly does nothing.
 *
 * A conversation's own file offers no delete at all: it belongs to that conversation, and the
 * place to remove it is the conversation (whose dialog is the one that shows it in context).
 */
function canDelete(source: Source): boolean {
  return source.storage !== "session";
}

/**
 * Whether this row can be followed to the page it was fetched from.
 *
 * Only a page has a URL, and only the two schemes a page can have been fetched over count — see
 * `utils/externalLink.ts` for why that is checked at the point of use rather than trusted from
 * the column. Gating on presence alone is what the row renders on, so the only other way to offer
 * this control would be to offer it on a row with nowhere to go.
 */
function canOpenInBrowser(source: Source): boolean {
  return isOpenableUrl(source.url);
}

/**
 * Confirm, then leave for the third-party page.
 *
 * The confirmation, the scheme check and the `noopener` all live in `openExternal` — the row only
 * decides whether to offer the control and where the URL comes from. The `void` is the same
 * deliberate silence the function documents: a popup the browser blocked is the user's own setting
 * answering, and nothing the app can add to that is worth a sentence.
 */
function openInBrowser(source: Source): void {
  if (!source.url) return;
  void openExternal(source.url);
}

async function remove(source: Source): Promise<void> {
  const ok = await confirm({
    // The same four strings the uploads dialog has always used, and the wording is right for
    // every kind of source: the file, its text and every reference go, for good.
    title: t("sources.delete.title"),
    message: t("sources.delete.message", { name: source.name }),
    detail: t("sources.delete.detail"),
    confirmText: t("sources.delete.action"),
    danger: true,
  });
  if (!ok) return;

  try {
    if (source.storage === "workspace" && source.workspaceId && source.relPath) {
      await api.deleteWorkspaceEntry(source.workspaceId, source.relPath);
      // The tree is showing this workspace's files, and one of them has just gone.
      if (store.activeWorkspaceId === source.workspaceId) await store.refreshFileTree({ silent: true });
    } else {
      await store.deleteSource(source.id);
    }
    rows.value = rows.value.filter((r) => r.id !== source.id);
    scopeRows.value = scopeRows.value.filter((r) => r.id !== source.id);
  } catch (e) {
    error.value = message(e);
  }
}

/**
 * The directories this workspace is known to have, for the add dialog's suggestions.
 *
 * Derived from the sources already listed rather than from a directory walk: the walk is one
 * request per level, and a suggestion list is not worth that. Free text is what actually
 * decides, and an unknown path is created by the upload — so a stale or short list costs a
 * suggestion, never a mistake.
 */
const knownDirectories = computed(() => {
  const dirs = new Set<string>();
  for (const row of scopeRows.value) {
    const rel = row.relPath;
    if (!rel) continue;
    const cut = rel.lastIndexOf("/");
    if (cut > 0) dirs.add(rel.slice(0, cut));
  }
  return [...dirs].sort();
});

/** A source was added: re-read both lists, so the new row is there and the facets see it too. */
async function onAdded(): Promise<void> {
  await Promise.all([loadScope(), loadRows()]);
}

/* --------------------------------- lifecycle -------------------------------- */

/**
 * What is on screen, and what it was read for.
 *
 * Both watchers below are gated on the *values* rather than on the event that changed them, and
 * that is not tidiness. Opening the dialog writes `filters` from the props, which is a change to
 * the very fields those watchers watch — so a fresh open read everything **twice**: once because
 * it opened, and once because the scope "changed" to what the props already said. Seven requests
 * where three belong, and each listing makes the server reconcile a filesystem.
 *
 * A flag held up while hydrating would fix that one pair and depend on which flush runs first.
 * A key does not depend on anything: the list on screen belongs to a filter set, and a read is
 * worth making exactly when the set in hand is not the one it holds.
 */
let loadedFilters: string | null = null;
let loadedScope: string | null = null;

/**
 * The filter set as a string, for comparison.
 *
 * JSON rather than a join: the search box is free text, and any separator it could contain would
 * let two different sets compare equal — which here would mean a search that never re-read.
 */
function filterKey(): string {
  const f = filters.value;
  return JSON.stringify([f.name, f.workspaceId, f.sessionId, f.category, f.origin, f.mime, f.storage]);
}

/** The scope half of it — the part whose change invalidates the option lists and the sessions. */
function scopeKey(): string {
  return JSON.stringify([filters.value.workspaceId ?? "", filters.value.sessionId ?? ""]);
}

/** Record that what is on screen is this, and read it whole. */
async function readAll(): Promise<void> {
  loadedFilters = filterKey();
  loadedScope = scopeKey();
  await Promise.all([loadScope(), loadRows(), loadSessions()]);
}

/** Record it and read the rows alone — for a change the facets do not depend on. */
async function readRows(): Promise<void> {
  loadedFilters = filterKey();
  await loadRows();
}

const closeButton = ref<HTMLButtonElement | null>(null);

/**
 * The window-level Escape, and the guard that makes it one press per layer.
 *
 * A preview opened from this dialog is a second overlay on top of it, and both listen for
 * `Escape` on `window` — so without the guard a single press would take the file away *and*
 * close the browser under it. The file preview dialog already has the mirror of this.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (store.filePreviewPath) return;
  emit("close");
}

/**
 * Load on *open*, not on mount.
 *
 * The component is always mounted (the app has no `v-if` on its dialogs), so `onMounted` fires
 * once at start-up and would leave the list as it was at boot — the bug the uploads dialog this
 * replaced already had and fixed. `immediate` is wanted for the *removal* of the listener rather
 * than for a load: at start-up the flag is false, and `readAll` is not reached.
 */
watch(
  () => uiState.sourcesOpen,
  async (open) => {
    if (!open) {
      window.removeEventListener("keydown", onKeydown);
      return;
    }
    window.addEventListener("keydown", onKeydown);
    // The filters are re-read from the props on every open, not only at setup: the two front
    // doors hand over different scopes, and a dialog reopened from the other one must not
    // inherit what the first one was narrowed to.
    filters.value = asFilters(props.initial);
    view.value = "flat";
    await readAll();
    expanded.value = [];
    // Focus the close control, which gives the dialog a focus trap of one: Tab from here walks
    // its own controls, and Escape never has to reach past the composer behind it.
    await nextTick();
    closeButton.value?.focus();
  },
  { immediate: true }
);

/**
 * A filter change re-reads — and *what* it re-reads depends on which half of the key moved.
 *
 * One watcher rather than two, because the two halves overlap: the scope is a pair of the fields
 * this watches, so a second watcher on them would fire for the same change and read the rows a
 * second time. The key is what makes "the dialog just opened and wrote the props it was opened
 * with" not a change at all — see the note above `loadedFilters`.
 */
watch(filterKey, async () => {
  if (!uiState.sourcesOpen) return;
  // A session belongs to the workspace that was just changed away from.
  if (!filters.value.workspaceId) filters.value.sessionId = undefined;
  if (filterKey() === loadedFilters) return;
  if (scopeKey() === loadedScope) {
    await readRows();
    return;
  }
  await readAll();
});

function expandAll(): void {
  expanded.value = allCollapsed.value ? allGroupKeys(groups.value) : [];
}
</script>

<template>
  <!--
    `v-if` on the teleport, not inside it: the component is always mounted, so an overlay that
    rendered itself unconditionally would sit over every screen in the app — including the
    sign-in form, where it would swallow the click on the submit button. The condition is the
    flag the parent opens it with, which is also what the load watcher listens to.
  -->
  <Teleport v-if="uiState.sourcesOpen" to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div
        class="modal source-browser"
        role="dialog"
        aria-modal="true"
        data-testid="sources-dialog"
      >
        <div class="modal-head">
          <h3>{{ t("sources.title") }}</h3>

          <!--
            The view switcher and the tree's expand control, beside the title rather than in the
            filter row — the widths are what decide it, and the filters need all of theirs.
          -->
          <div v-if="shows('view')" class="head-actions">
            <button
              v-if="view === 'tree' && lines.length > 0"
              class="btn small"
              data-testid="sources-expand-all"
              @click="expandAll"
            >
              {{ allCollapsed ? t("sources.expandAll") : t("sources.collapseAll") }}
            </button>
            <div class="segmented" role="group" :aria-label="t('sources.viewLabel')">
              <button
                class="segment"
                data-testid="sources-view-flat"
                :aria-pressed="view === 'flat'"
                @click="view = 'flat'"
              >
                {{ t("sources.viewFlat") }}
              </button>
              <button
                class="segment"
                data-testid="sources-view-tree"
                :aria-pressed="view === 'tree'"
                @click="view = 'tree'"
              >
                {{ t("sources.viewTree") }}
              </button>
            </div>
          </div>

          <button
            ref="closeButton"
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            data-testid="sources-close"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body">
          <!--
            One row of controls, each of them a bordered control that names itself.

            The layout is the point rather than the styling. It used to be a lead sentence, a
            disclosure row and a two-column grid of six labelled fields — taller than half the
            window on a laptop, which left the list it is a toolbar *for* a couple of rows high.
            A control whose label is its own placeholder ("all workspaces") needs no label above
            it, and six of them fit on one line; the `<select>`'s `aria-label` is what keeps that
            from costing the screen-reader name.

            A caller can still take a group away — that is the `hidden` prop, and it is a
            different thing from the user folding the bar: a front door that has already decided
            the scope has no business offering it.
          -->
          <div class="browser-toolbar" data-testid="sources-toolbar">
            <input
              v-if="shows('search')"
              v-model="filters.name"
              class="input search"
              :aria-label="t('sources.search')"
              :placeholder="t('sources.searchHint')"
              data-testid="sources-filter-search"
            />

            <select
              v-if="shows('workspace')"
              v-model="filters.workspaceId"
              class="input"
              :aria-label="t('sources.filterWorkspace')"
              data-testid="sources-filter-workspace"
            >
              <option value="">{{ t("sources.allWorkspaces") }}</option>
              <option v-for="w in store.workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>

            <!--
              Only once a workspace is chosen, rather than present and disabled. A session
              belongs to a workspace, so the control cannot mean anything before one is picked —
              and a *disabled* `<select>` bound to an empty value paints blank in Chromium, which
              is a control that reads as broken rather than as unavailable.
            -->
            <select
              v-if="shows('session') && filters.workspaceId"
              v-model="filters.sessionId"
              class="input"
              :aria-label="t('sources.filterSession')"
              data-testid="sources-filter-session"
            >
              <option value="">{{ t("sources.allSessions") }}</option>
              <option v-for="s in sessions" :key="s.id" :value="s.id">
                {{ s.title || t("session.fallbackTitle") }}
              </option>
            </select>

            <select
              v-if="shows('category')"
              v-model="filters.category"
              class="input"
              :aria-label="t('sources.filterCategory')"
              data-testid="sources-filter-category"
            >
              <option value="">{{ t("sources.allCategories") }}</option>
              <option v-for="c in categoryOptions" :key="c" :value="c">
                {{ t(`sources.category.${c as SourceCategory}`) }}
              </option>
            </select>

            <select
              v-if="shows('origin')"
              v-model="filters.origin"
              class="input"
              :aria-label="t('sources.filterOrigin')"
              data-testid="sources-filter-origin"
            >
              <option value="">{{ t("sources.allOrigins") }}</option>
              <option v-for="o in originOptions" :key="o" :value="o">
                {{ t(`sources.origin.${o as SourceOrigin}`) }}
              </option>
            </select>

            <select
              v-if="shows('mime')"
              v-model="filters.mime"
              class="input"
              :aria-label="t('sources.filterMime')"
              data-testid="sources-filter-mime"
            >
              <option value="">{{ t("sources.allMimes") }}</option>
              <option v-for="m in mimeOptions" :key="m" :value="m">{{ m }}</option>
            </select>

            <!--
              The view switcher is in the *header* rather than here, because this row is the
              filters and they are what needs the width: six controls plus a segmented control
              wrapped, and the wrap put the switcher on a line of its own under a row of
              selects. A view switcher beside a title is the pattern editors use for the same
              reason — it changes what the list *is*, not what it *shows*.
            -->
          </div>

          <div class="browser-scroll">
            <p v-if="error" class="browser-note error" role="alert" data-testid="sources-error">
              {{ error }}
            </p>

            <p v-if="loading" class="browser-note" data-testid="sources-loading">
              {{ t("sources.loading") }}
            </p>
            <p
              v-else-if="rows.length === 0"
              class="browser-note"
              data-testid="sources-empty"
            >
              {{ t("sources.empty") }}
            </p>

            <!-- The flat view: one row per source, newest first, with where it came from. -->
            <ul v-else-if="view === 'flat'" class="sources-list">
              <li v-for="source in rows" :key="source.id" class="source" data-testid="source-row">
                <button
                  class="source-open"
                  :title="t('sources.preview', { name: source.name })"
                  data-testid="source-open"
                  @click="store.openSourceFile(source)"
                >
                  <Icon :name="source.kind === 'image' ? 'image' : source.category === 'diagram' ? 'diagram' : 'file'" />
                  <span class="label truncate">{{ source.name }}</span>
                </button>
                <span class="source-detail truncate" data-testid="source-detail">{{ detailOf(source) }}</span>
                <span class="source-origin truncate" data-testid="source-origin">
                  {{ originLabel(source) }}
                </span>
                <!-- A sibling of the row's own control, never a child of it: a button inside a
                     button is invalid, which is why the delete control is one too. -->
                <button
                  v-if="canOpenInBrowser(source)"
                  class="icon-btn"
                  :title="t('sources.openInBrowser')"
                  :aria-label="t('sources.openInBrowser')"
                  data-testid="source-open-browser"
                  @click="openInBrowser(source)"
                >
                  <Icon name="link" />
                </button>
                <button
                  v-if="canDelete(source)"
                  class="icon-btn danger"
                  :title="t('common.delete')"
                  :aria-label="t('common.delete')"
                  data-testid="source-delete"
                  @click="remove(source)"
                >
                  <Icon name="trash" />
                </button>
              </li>
            </ul>

            <!--
              The tree view: the same rows, arranged by where they came from — workspace, then the
              conversation that holds them, then their path. It answers a different question than
              the flat list does, which is why both exist.
            -->
            <div v-else class="source-tree" role="tree" data-testid="sources-tree">
              <template v-for="line in lines" :key="line.key">
                <button
                  v-if="line.kind === 'group'"
                  class="tree-group"
                  role="treeitem"
                  data-testid="source-group"
                  :style="{ '--depth': line.depth }"
                  :aria-expanded="expanded.includes(line.key)"
                  @click="toggleGroup(line.key)"
                >
                  <Icon :name="expanded.includes(line.key) ? 'caret-down' : 'caret-right'" />
                  <Icon :name="expanded.includes(line.key) ? 'folder-open' : 'folder'" />
                  <span class="label truncate">{{ line.label }}</span>
                </button>
                <div v-else class="source tree-row" data-testid="source-row">
                  <button
                    class="source-open"
                    :style="{ '--depth': line.depth }"
                    :title="t('sources.preview', { name: line.source!.name })"
                    data-testid="source-open"
                    @click="store.openSourceFile(line.source!)"
                  >
                    <Icon :name="line.source!.kind === 'image' ? 'image' : 'file'" />
                    <span class="label truncate">{{ line.label }}</span>
                  </button>
                  <span class="source-detail truncate" data-testid="source-detail">
                    {{ detailOf(line.source!) }}
                  </span>
                  <button
                    v-if="canOpenInBrowser(line.source!)"
                    class="icon-btn"
                    :title="t('sources.openInBrowser')"
                    :aria-label="t('sources.openInBrowser')"
                    data-testid="source-open-browser"
                    @click="openInBrowser(line.source!)"
                  >
                    <Icon name="link" />
                  </button>
                  <button
                    v-if="canDelete(line.source!)"
                    class="icon-btn danger"
                    :title="t('common.delete')"
                    :aria-label="t('common.delete')"
                    data-testid="source-delete"
                    @click="remove(line.source!)"
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </template>
          </div>
          </div>
        </div>

        <div class="modal-foot">
          <template v-if="shows('add')">
            <!--
              One door for both kinds. The dialog that opens asks *what* is being added — a file
              or a link — which is the question a knowledge base asks, and then collects
              everything before anything is sent. See `AddSourceDialog`.
            -->
            <button class="btn" data-testid="sources-add" @click="addOpen = true">
              <Icon name="plus" />
              {{ t("sources.add") }}
            </button>
          </template>
          <button class="btn primary" data-testid="sources-done" @click="emit('close')">
            {{ t("common.close") }}
          </button>
        </div>
      </div>
    </div>

    <!--
      Adding, as one dialog with a tab per kind. It is told the scope when this browser was
      opened already scoped, and shows no picker then.
    -->
    <AddSourceDialog
      v-if="addOpen"
      :locked-workspace-id="props.initial?.workspaceId"
      :directories="knownDirectories"
      @close="addOpen = false"
      @added="onAdded"
    />
  </Teleport>
</template>

<style scoped>
/*
 * A fixed height, so the *list* is what the dialog is sized for.
 *
 * Without it the dialog grows to fit whatever the body says and stops at the viewport cap —
 * which made the toolbar and the footer between them decide how much room the rows got. A
 * library browser is a browser: it should be as tall as it can be, and the controls should be a
 * strip at the top of it.
 */
.source-browser {
  width: min(880px, calc(100vw - 2 * var(--space-6)));
  height: min(660px, calc(100dvh - 120px));
}
/*
 * The body becomes a column that the list fills: the toolbar stays where it is and only the
 * rows scroll. `:deep` because the padding and the scroll belong to the shared `.modal-body`
 * and this is the one dialog that wants them rearranged.
 */
.source-browser :deep(.modal-body) {
  /*
   * Grows into the dialog's height, so the *list* gets the space and the footer sits at the
   * bottom. Without it the three parts stack from the top and the leftover height collects
   * below the footer as a band of nothing.
   */
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-5);
  padding-bottom: var(--space-5);
}
/*
 * One row of controls, wrapping only when the dialog is genuinely too narrow for them — six
 * selects fit on one line at this width, and a `flex-wrap` is what keeps the layout from
 * breaking rather than a second column of labels.
 *
 * `flex-shrink: 0` and a min-width on each control: a `<select>` in a flex row shrinks to a
 * sliver before it wraps, which reads as a broken control rather than as a narrow window.
 */
.browser-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}
.browser-toolbar .input {
  width: auto;
  min-width: 7.5rem;
  /* Shorter than the form controls elsewhere: this is a toolbar, not a form. */
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-2);
}
.browser-toolbar .search {
  flex: 1;
  /* The search box is the one control that should take the slack. */
  min-width: 9rem;
}
/*
 * The header's right-hand group: `margin-left: auto` pushes it and the close button to the
 * edge, and the gap keeps the two from touching.
 */
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-left: auto;
  margin-right: var(--space-4);
}
.browser-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.browser-note {
  margin: 0;
  padding: var(--space-5) 0;
  color: var(--text-3);
  font-size: var(--fs-3);
}
.browser-note.error {
  color: var(--danger-text);
  padding-bottom: var(--space-4);
}
.sources-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.source {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-sm);
}
.source:hover {
  background: var(--panel-2);
}
.source-open {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  color: var(--text);
  font-size: var(--fs-3);
  /* Indentation for the tree, where a row carries its depth. */
  padding-left: calc(var(--depth, 0) * var(--space-6));
  cursor: pointer;
}
.source-detail,
.source-origin {
  color: var(--text-3);
  font-size: var(--fs-2);
  flex-shrink: 0;
  max-width: 22ch;
}
.source-origin {
  max-width: 18ch;
}
.source-tree {
  display: flex;
  flex-direction: column;
}
.tree-group {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-2) var(--space-3)
    calc(var(--space-2) + var(--depth, 0) * var(--space-6));
  background: none;
  border: none;
  color: var(--text-2);
  font-size: var(--fs-3);
  cursor: pointer;
  text-align: left;
}
.tree-group:hover {
  background: var(--panel-2);
}
.add-workspace {
  /* The foot is right-aligned by the modal's own layout; this is the widest thing in it. */
  max-width: 180px;
  margin-right: auto;
}

@media (max-width: 560px) {
  .filter-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  /* The detail columns are the first thing to go: the name is what the row is for. */
  .source-origin {
    display: none;
  }
}
/*
 * The file picker the upload button drives. `display: none` rather than a visually-hidden clip:
 * the button above it is the control, and an input that stayed focusable would be a second,
 * invisible tab stop on a control the user never sees.
 */
.hidden-input {
  display: none;
}
</style>
