<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, fileToBase64, type ResourceFilterQuery } from "../../api/client";
import type { Session, StoredFile, WorkResource, WorkResourceType } from "../../api/types";
import {
  resourceCategory,
  resourceIsImage,
  resourceMime,
  resourceName,
  resourceSandboxPath,
  resourceSize,
  resourceUrl,
} from "../../utils/resourceView";
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
 * The library: everything this account holds a reference to, filterable.
 *
 * It replaces a dialog that listed uploaded files, and the difference is the point — a reference
 * is now an upload, a kept page, a file the agent wrote into a workspace and a file it wrote
 * into a conversation. "What material do I have, and where did each piece come from" is the
 * question this answers, and neither half of it was answerable before: the old dialog could
 * not see a workspace file at all, and the file tree could not see an upload.
 *
 * ### One component, and a front door differs only in what it opens *on*
 *
 * It opens from the workspace home (on the whole account) and from a conversation (on that
 * workspace). The caller says which with one prop: `initial` is the filter set to open with,
 * and everything below it is reachable from either door.
 *
 * It used to take a second prop — `hidden`, the option groups a front door had taken away — and
 * the workspace picker was the only group anybody ever removed, on the argument that a dialog
 * opened from inside a workspace, for that workspace, had no business offering a scope it would
 * not honour. The argument is wrong, and the cost was the reader's: the conversation's door is a
 * *shortcut* to its own workspace, not a statement that the rest do not exist. Material this
 * account holds and no workspace does — every upload — is one click away from here, and the
 * picker that reaches another workspace's files was the control the same click needed. The
 * picker is therefore always drawn, the door is what the list opens *on*, and the prop went with
 * the mistake (as did `hasScope`, the derived "is there a scope control at all", which the
 * template had already stopped asking).
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
  /**
   * The filter to open with. `workspaceId` is what opens the conversation's front door on its
   * workspace — a default, not a lock: the picker below is drawn either way.
   */
  initial?: ResourceFilterQuery;
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
 * lists what the browser can filter by, and `Record<keyof ResourceFilterQuery, string>` makes a
 * new filter a compile error here rather than a control that stays blank.
 */
function asFilters(input: ResourceFilterQuery = {}): Record<keyof ResourceFilterQuery, string> {
  return {
    name: input.name ?? "",
    workspaceId: input.workspaceId ?? "",
    sessionId: input.sessionId ?? "",
    category: input.category ?? "",
    resourceType: input.resourceType ?? "",
    ownerType: input.ownerType ?? "",
    mime: input.mime ?? "",
  };
}

/** What the controls currently say. Every key is a server filter; an empty one is absent. */
const filters = ref<ResourceFilterQuery>(asFilters(props.initial));

/** References for the open scope, ignoring the filters — where the option lists come from. */
const scopeRows = ref<WorkResource[]>([]);
const rows = ref<WorkResource[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const view = ref<"flat" | "tree">("flat");
const expanded = ref<string[]>([]);
/** Whether the add dialog is open. */
const addOpen = ref(false);

const sessions = ref<Session[]>([]);

/* --------------------------------- loading --------------------------------- */

/** The scope-only filter: what the option lists are drawn from. */
function scopeFilter(): ResourceFilterQuery {
  return { workspaceId: filters.value.workspaceId, sessionId: filters.value.sessionId };
}

/*
 * Sequence numbers, because two loads of the same list overlap routinely.
 *
 * Opening the dialog starts one; changing a filter starts another a moment later. Responses do
 * not arrive in the order they were sent, and the loser used to *overwrite* the winner — so the
 * list could settle on the unfiltered answer while the controls said otherwise. Found by a
 * browser spec that opened the dialog, filtered by kind, and then saw every row again.
 *
 * The same shape `runPreview`'s `filePreviewSeq` uses: the reply that is not the latest is
 * dropped rather than rendered.
 */
let rowsSeq = 0;
let scopeSeq = 0;

async function loadScope(): Promise<void> {
  const seq = ++scopeSeq;
  try {
    const next = await api.listResources(scopeFilter());
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
    const next = await api.listResources(filters.value);
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

/**
 * The option values present in the open scope, so a filter offers only what exists.
 *
 * The three readers each ask the row a different question — a category is the file's, a MIME type
 * is the file's, a resource type is the reference's — which is why this is three derivations
 * behind one shape rather than a property lookup: on a *page* two of the three have no answer.
 */
function present(key: "category" | "resourceType" | "mimeType"): string[] {
  const values = new Set<string>();
  for (const row of scopeRows.value) {
    const value =
      key === "mimeType" ? resourceMime(row) : key === "category" ? resourceCategory(row) : row.resourceType;
    if (value) values.add(value);
  }
  // The current selection is always offered, even if the scope has moved out from under it —
  // a `<select>` whose value is not among its options renders as blank.
  const chosen = filters.value[key === "mimeType" ? "mime" : key];
  if (chosen) values.add(chosen);
  return [...values].sort();
}

const categoryOptions = computed(() => present("category"));
const kindOptions = computed(() => present("resourceType"));
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

const parseLabel = (row: WorkResource): string => {
  if (row.parseStatus === "ready") {
    return row.parsedChars ? t("sources.parsedChars", { count: row.parsedChars }) : t("sources.parsed");
  }
  if (row.parseStatus === "pending" || row.parseStatus === "parsing") return t("sources.parsing");
  if (row.parseStatus === "failed") {
    return translateParseError(row.parseErrorCode, undefined, row.parseError) ?? t("sources.parseFailed");
  }
  return "";
};

/**
 * What a reference *is*, in words: the sentence the flat view has instead of a tree.
 *
 * A `switch` over the closed union with a literal `t()` per case, not `` t(`sources.resourceType.${…}`) ``:
 * `catalog.test.ts` finds a key by scanning for `t("…")` literals, so a built key is invisible to
 * it and its dead-key scan then reports the message as unused. The same shape the console's nav
 * and `widgets/registry.ts` use.
 */
function kindLabel(kind: WorkResourceType): string {
  switch (kind) {
    case "file":
      return t("sources.resourceType.file");
    case "web_page":
      return t("sources.resourceType.web_page");
  }
}

/** Where a row came from, in words: what it is, and whose it is. */
function originLabel(row: WorkResource): string {
  const owner = row.ownerName ? ` · ${row.ownerName}` : "";
  /*
   * **Where it came from**, which is the question this column has always answered — a person
   * checking whether a file is theirs or the assistant's reads it here, and a label that only
   * said 文件/网页 would answer a question the row's own icon already answers.
   *
   * v4 answers it with the entity's `sourceType` for a file and with the resource type for a
   * page, which has no source type of its own beyond the URL it came from.
   */
  const what =
    row.resourceType === "web_page"
      ? t("sources.resourceType.web_page")
      : fileSourceLabel((row.resource as StoredFile).sourceType);
  return `${what}${owner}`;
}

/**
 * A file's source type, spelled per case.
 *
 * A `switch` with a literal key per arm rather than `t(\`sources.fileSource.${type}\`)`, for the
 * reason `widgetLabel` gives: a key reached through a template literal is invisible to
 * `catalog.test.ts`, so it would have to go on the dynamic-prefix allowlist — and a prefix that
 * broad is where a typo hides. The `never` arm makes a fifth source type a compile error.
 */
function fileSourceLabel(sourceType: StoredFile["sourceType"]): string {
  switch (sourceType) {
    case "attachment":
      return t("sources.fileSource.attachment");
    case "upload":
      return t("sources.fileSource.upload");
    case "agent_create":
      return t("sources.fileSource.agent_create");
    case "discovered":
      return t("sources.fileSource.discovered");
    default: {
      const unhandled: never = sourceType;
      return unhandled;
    }
  }
}

/**
 * A row's detail line: how big, and what became of it.
 *
 * Deliberately *not* the category — the row's icon is the kind, and this is the same line the
 * uploads dialog has always shown. `none` renders as nothing at all rather than as a sentence
 * about parsing, which would read as "still working on it" for a text file that never needed
 * extracting.
 */
function detailOf(row: WorkResource): string {
  return [formatBytes(resourceSize(row)), parseLabel(row)].filter(Boolean).join(" · ");
}

/**
 * Whether this row can be deleted from here, and how.
 *
 * A file **inside a workspace's own tree** is deleted through the **file manager's** route, which
 * moves its bytes to the trash and takes the row with them. Deleting it through the reference
 * route instead would drop this account's reference while the bytes stayed in the tree — and the
 * next listing reconciles the file straight back, which is a delete that visibly does nothing.
 *
 * A conversation's own file offers no delete at all: it belongs to that conversation, and the
 * place to remove it is the conversation (whose dialog is the one that shows it in context). It
 * is told apart from a *session-owned upload* by having a sandbox path: an upload's bytes are
 * under `sources/raw/`, so it is nobody's file and the reference route is exactly right for it.
 */
function canDelete(row: WorkResource): boolean {
  return row.ownerType !== "session" || resourceSandboxPath(row) === undefined;
}

/**
 * The workspace-relative path this row is a *file* at, when the file manager is what should
 * delete it: a file in a workspace's `workdir/`, and nothing else.
 */
function fileManagerPath(row: WorkResource): string | undefined {
  if (row.ownerType !== "workspace") return undefined;
  return resourceSandboxPath(row);
}

/**
 * Whether this row can be followed to the page it was fetched from.
 *
 * Only a page has a URL, and only the two schemes a page can have been fetched over count — see
 * `utils/externalLink.ts` for why that is checked at the point of use rather than trusted from
 * the column. Gating on presence alone is what the row renders on, so the only other way to offer
 * this control would be to offer it on a row with nowhere to go.
 */
function canOpenInBrowser(row: WorkResource): boolean {
  return isOpenableUrl(resourceUrl(row));
}

/**
 * Confirm, then leave for the third-party page.
 *
 * The confirmation, the scheme check and the `noopener` all live in `openExternal` — the row only
 * decides whether to offer the control and where the URL comes from. The `void` is the same
 * deliberate silence the function documents: a popup the browser blocked is the user's own setting
 * answering, and nothing the app can add to that is worth a sentence.
 */
function openInBrowser(row: WorkResource): void {
  const url = resourceUrl(row);
  if (!url) return;
  void openExternal(url);
}

async function remove(row: WorkResource): Promise<void> {
  const ok = await confirm({
    // The same four strings the uploads dialog has always used, and the wording is right for
    // every kind of reference: this account's hold on it goes, for good.
    title: t("sources.delete.title"),
    message: t("sources.delete.message", { name: resourceName(row) }),
    detail: t("sources.delete.detail"),
    confirmText: t("sources.delete.action"),
    danger: true,
  });
  if (!ok) return;

  try {
    const path = fileManagerPath(row);
    if (row.workspaceId && path !== undefined) {
      await api.deleteWorkspaceEntry(row.workspaceId, path);
      // The tree is showing this workspace's files, and one of them has just gone.
      if (store.activeWorkspaceId === row.workspaceId) await store.refreshFileTree({ silent: true });
    } else {
      await store.deleteResource(row.id);
    }
    rows.value = rows.value.filter((r) => r.id !== row.id);
    scopeRows.value = scopeRows.value.filter((r) => r.id !== row.id);
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
    // Only the workspace's own files: an upload has no directory to suggest and a
    // conversation's files are not somewhere the add dialog can put anything.
    if (row.ownerType !== "workspace") continue;
    const rel = resourceSandboxPath(row);
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
  return JSON.stringify([
    f.name,
    f.workspaceId,
    f.sessionId,
    f.category,
    f.resourceType,
    f.ownerType,
    f.mime,
  ]);
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
          <div class="head-actions">
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

            Every control is always drawn. A front door sets what the list opens *on*; it does
            not take the control away, which is what it used to do with the workspace picker —
            see the note at the top for why that was the wrong trade.
          -->
          <div class="browser-toolbar" data-testid="sources-toolbar">
            <input
              v-model="filters.name"
              class="input search"
              :aria-label="t('sources.search')"
              :placeholder="t('sources.searchHint')"
              data-testid="sources-filter-search"
            />

            <select
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
              v-if="filters.workspaceId"
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

            <!--
              Who is working from it, which is the narrowing v3's `origin` filter was reaching
              for: "the files I uploaded" and "the files this workspace holds" are the two lists
              a person actually wants, and neither is reachable by name alone.

              A fixed pair rather than the values present in the scope, unlike the category and
              MIME pickers: there are exactly two levels, and a picker that listed one of them
              when a scope held only that one would be a control that cannot narrow anything.
            -->
            <select
              v-model="filters.ownerType"
              class="input"
              :aria-label="t('sources.filterOwnerType')"
              data-testid="sources-filter-owner-type"
            >
              <option value="">{{ t("sources.allOwnerTypes") }}</option>
              <option value="session">{{ t("sources.ownerType.session") }}</option>
              <option value="workspace">{{ t("sources.ownerType.workspace") }}</option>
            </select>

            <select
              v-model="filters.category"
              class="input"
              :aria-label="t('sources.filterCategory')"
              data-testid="sources-filter-category"
            >
              <option value="">{{ t("sources.allCategories") }}</option>
              <option v-for="c in categoryOptions" :key="c" :value="c">
                {{ t(`sources.category.${c}`) }}
              </option>
            </select>

            <!--
              What the material *is*, which in v4 is a `resourceType` rather than a category: a
              page is a page because of the entity it came from, not because somebody hand-set a
              category on it. The label is spelled per case in `kindLabel` so the catalog guard
              can see it.
            -->
            <select
              v-model="filters.resourceType"
              class="input"
              :aria-label="t('sources.filterResourceType')"
              data-testid="sources-filter-resource-type"
            >
              <option value="">{{ t("sources.allResourceTypes") }}</option>
              <option v-for="k in kindOptions" :key="k" :value="k">
                {{ kindLabel(k as WorkResourceType) }}
              </option>
            </select>

            <select
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
                  :title="t('sources.preview', { name: resourceName(source) })"
                  data-testid="source-open"
                  @click="store.openResourceFile(source)"
                >
                  <Icon
                    :name="
                      resourceIsImage(source)
                        ? 'image'
                        : resourceCategory(source) === 'diagram'
                          ? 'diagram'
                          : 'file'
                    "
                  />
                  <span class="label truncate">{{ resourceName(source) }}</span>
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
                    :title="t('sources.preview', { name: resourceName(line.source!) })"
                    data-testid="source-open"
                    @click="store.openResourceFile(line.source!)"
                  >
                    <Icon :name="resourceIsImage(line.source!) ? 'image' : 'file'" />
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
          <!--
            One door for both kinds. The dialog that opens asks *what* is being added — a file
            or a link — which is the question a knowledge base asks, and then collects
            everything before anything is sent. See `AddSourceDialog`.
          -->
          <button class="btn" data-testid="sources-add" @click="addOpen = true">
            <Icon name="plus" />
            {{ t("sources.add") }}
          </button>
          <button class="btn primary" data-testid="sources-done" @click="emit('close')">
            {{ t("common.close") }}
          </button>
        </div>
      </div>
    </div>

    <!--
      Adding, as one dialog with a tab per kind. What it is told is the workspace the list is
      *showing* — `filters.workspaceId` rather than the `initial` the browser opened on, and the
      difference is the whole point of the picker above: material is added where the reader is
      looking, so widening the list to the whole account (or moving it to another workspace) has
      to move the destination with it. Left as the prop it used to read, an upload aimed at the
      workspace you had just navigated away from would land where the *dialog* was opened, which
      is the silent kind of wrong.
    -->
    <AddSourceDialog
      v-if="addOpen"
      :locked-workspace-id="filters.workspaceId"
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
