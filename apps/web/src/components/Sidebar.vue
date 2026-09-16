<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import { isCompact } from "../composables/breakpoints";
import type { Session } from "../api/types";
import {
  closeDrawer,
  openCopilots,
  openSessionSettings,
  openWorkspaceSettings,
  showAccount,
  showAdmin,
  showWorkspaceHome,
  sidebarRail,
  toggleSidebar,
  uiState,
} from "../composables/ui";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";
import AppMenu from "./AppMenu.vue";
import FileTree from "./FileTree.vue";
import Icon from "./Icon.vue";

const { t } = useI18n();
const store = useAppStore();

const showNewSession = ref(false);

/**
 * The header toggle, which is a different button on each viewport.
 *
 * On a wide one it narrows the sidebar to its rail; on a compact one there is no rail to
 * narrow to, so it does what the topbar's `nav-toggle` does and closes the drawer.
 * `toggleSidebar()` is not consulted at all in that case, which is deliberate: a compact
 * viewport must not remember a collapsed flag it could not show, or the sidebar would come
 * back as a rail on the next resize.
 */
function onSidebarToggle() {
  if (isCompact.value) closeDrawer();
  else toggleSidebar();
}

/** This workspace's settings. Shared by the header's name button and the footer's own row. */
function openWorkspaceSettingsPanel(): void {
  const id = store.activeWorkspaceId;
  if (id) openWorkspaceSettings(id);
}

/* ---------------------------------- panels ---------------------------------- */

/**
 * Which panel the sidebar is showing. Component-local on purpose: nothing outside this
 * component reads it, and `composables/ui.ts` is for the flags more than one place needs
 * (`ui.ts` says so itself). The tree's freshness rule does not consult it — a loaded tree
 * is refreshed after a turn whether or not it is on screen, which keeps that rule out of a
 * component's state.
 */
const tab = ref<"sessions" | "files">("sessions");

/**
 * Make sure the open panel has something in it.
 *
 * Watched rather than called from the click: the same thing has to happen when the
 * *workspace* changes underneath a sidebar sitting on the files tab, and the tab switch is
 * only the easy half of that. No drawer handling here — switching tabs is not navigation,
 * and the drawer the user opened to reach this control should stay open.
 */
function ensurePanel() {
  if (tab.value !== "files" || store.fileListings[""]) return;
  void store.loadDirectory("");
}
watch([() => store.activeWorkspaceId, tab], ensurePanel, { immediate: true });

function onRefresh() {
  void store.refreshFileTree();
}

/*
 * Every navigation closes the drawer, and none of them is a watcher.
 *
 * `watch(() => store.activeSessionId, closeDrawer)` looks tempting and is wrong twice over:
 * it also fires on first load, when `init()` sets the active session and no drawer is open,
 * and it cannot cover the workspace switch, which changes every session underneath.
 *
 * These are on the actions rather than on the dialogs' results, so the drawer is already
 * gone by the time a modal covers the screen — and it is never left open behind one.
 */
function backToWorkspaces() {
  closeDrawer();
  showWorkspaceHome();
  void store.refreshWorkspaces().catch(() => undefined);
}

function openNewSession() {
  showNewSession.value = true;
  closeDrawer();
}

function selectSession(id: string) {
  void store.selectSession(id);
  closeDrawer();
}

/* --------------------------------- rename ---------------------------------- */
const renamingId = ref<string | null>(null);
const renameText = ref("");
const renameInput = ref<HTMLInputElement | null>(null);

function startRename(session: Session) {
  renamingId.value = session.id;
  renameText.value = session.title || "";
  nextTick(() => {
    renameInput.value?.focus();
    renameInput.value?.select();
  });
}

async function commitRename() {
  const id = renamingId.value;
  if (!id) return;
  const title = renameText.value;
  renamingId.value = null;
  if (title.trim() && title.trim() !== store.sessions.find((s) => s.id === id)?.title) {
    await store.renameSession(id, title).catch(() => undefined);
  }
}

function cancelRename() {
  renamingId.value = null;
}

/* ------------------------------ row parameters ------------------------------ */

/**
 * Open the conversation's parameters from its row.
 *
 * Selecting first is the whole of it, and it is not a shortcut around a missing feature. The
 * dialog reads `store.activeSession`, `store.sessionSettings` and `store.sessionWidgets` — the
 * conversation on screen — so pointing it at an arbitrary row would mean fetching all three for
 * an id the user is not looking at, which is the refactor `WorkspaceSettingsDialog` needed for
 * its widget rows and could not avoid. Here it can be avoided: a row already selects on click,
 * so this is that click with a dialog on the end.
 *
 * Awaited, and the dialog opens **only** if the switch finished. `selectSession` assigns the
 * active id before its two requests, so a failure part-way leaves the conversation changed but
 * its messages and widgets not — and parameters shown over that are parameters for a
 * conversation that is half the one on screen.
 */
async function openRowSettings(session: Session): Promise<void> {
  try {
    await store.selectSession(session.id);
  } catch {
    return;
  }
  closeDrawer();
  openSessionSettings();
}

/* --------------------------------- deletes ---------------------------------- */
async function onDeleteSession(session: Session) {
  const ok = await confirm({
    title: t("session.delete.title"),
    message: t("session.delete.message", { name: session.title || t("session.fallbackTitle") }),
    detail: t("session.delete.detail"),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (ok) await store.deleteSession(session.id);
}

/* Deleting a workspace moved to its card on the workspace home. It was a glyph beside the
   dropdown it used to share a row with, which put a destructive action one mis-click from
   the control the user was actually reaching for. */
</script>

<template>
  <aside
    id="app-sidebar"
    class="sidebar"
    data-testid="sidebar"
    :class="{ open: uiState.drawerOpen, collapsed: sidebarRail }"
  >
    <!--
      The sidebar's header: out on the left, where you are in the middle, the rail's toggle
      on the right.

      The back control is a glyph now, and the workspace's name is no longer inside it. It
      used to be one full-width button reading "all workspaces › this one", which spent the
      width of the sidebar on the one label that matters least — the way *out* — and set the
      name that matters most at `--fs-1` in `--text-3`, as if it were a subtitle to it. The
      name is the only thing on screen saying which workspace you are in once the topbar has
      moved on to naming the conversation, and on the welcome screen it is the only name
      there is, so it holds the middle in primary text and the two controls flank it.

      The two flankers being icon buttons of the same size is what makes that middle
      genuinely centred, rather than a label that looks centred until one side is wider.

      Creating a workspace is on the home page and deliberately not repeated here — the `+`
      that used to sit in this row put the two most different actions on the sidebar, go back
      and make something new, a few pixels apart under one cursor.
    -->
    <div class="workspace-head">
      <button
        class="icon-btn workspace-back"
        data-testid="all-workspaces"
        :title="t('sidebar.allWorkspaces')"
        :aria-label="t('sidebar.allWorkspaces')"
        @click="backToWorkspaces"
      >
        <Icon name="arrow-left" />
      </button>

      <!--
        The name is a button, opening this workspace's settings — the second of its two entry
        points, the other being the gear on the card it was opened from.

        A button rather than a third flanking icon because the row's symmetry is what centres the
        name: two icon buttons either side of a flexible middle. Adding a gear would make it three
        against one, and the name would sit off-centre for no reason a reader could see. The name
        keeps `flex: 1` and the span inside keeps `workspace-name`, so every existing selector and
        spec still finds it.
      -->
      <button
        class="workspace-name truncate workspace-name-btn"
        data-testid="workspace-settings-open"
        :title="t('widgets.workspaceSettings.title')"
        @click="openWorkspaceSettingsPanel"
      >
        <span
          class="truncate"
          data-testid="workspace-name"
          :title="store.activeWorkspace?.name ?? ''"
        >
          {{ store.activeWorkspace?.name ?? "" }}
        </span>
      </button>

      <!--
        One control, two jobs, and which one is decided by the viewport rather than by the
        flag: on a wide screen it narrows the sidebar to its rail, and on a compact one —
        where the sidebar *is* the drawer — it closes it. The label carries the difference,
        which is why it is `aria-label` and `title` and not `aria-expanded` over a region
        that is the button's own ancestor.
      -->
      <button
        class="icon-btn sidebar-toggle"
        data-testid="sidebar-toggle"
        :title="sidebarRail ? t('sidebar.expand') : t('sidebar.collapse')"
        :aria-label="sidebarRail ? t('sidebar.expand') : t('sidebar.collapse')"
        @click="onSidebarToggle"
      >
        <Icon name="panel-left" />
      </button>
    </div>

    <!--
      The two panels, and the action that belongs to whichever is open.

      The action is contextual — new conversation, or refresh the tree — because the strip and
      its button share one row and the sidebar's vertical budget on a phone is real. The plain
      `.tab` buttons are the shared class the card strips also use rather than a second kind of
      tab; see `docs/design-system.md` on why a shared class is not re-declared locally.
    -->
    <div class="tabs side-tabs">
      <button
        class="tab"
        data-testid="sidebar-tab-sessions"
        :class="{ active: tab === 'sessions' }"
        @click="tab = 'sessions'"
      >
        {{ t("sidebar.sessions") }}
      </button>
      <button
        class="tab"
        data-testid="sidebar-tab-files"
        :class="{ active: tab === 'files' }"
        @click="tab = 'files'"
      >
        {{ t("files.tab") }}
      </button>

      <button
        v-if="tab === 'sessions'"
        class="icon-btn tab-action"
        data-testid="new-session"
        :title="t('sidebar.newSession')"
        :aria-label="t('sidebar.newSession')"
        @click="openNewSession"
      >
        <Icon name="plus" />
      </button>
      <button
        v-else
        class="icon-btn tab-action"
        data-testid="files-refresh"
        :disabled="store.fileLoadingPath !== null"
        :title="t('files.refresh')"
        :aria-label="t('files.refresh')"
        @click="onRefresh"
      >
        <Icon name="retry" />
      </button>
    </div>

    <div v-if="tab === 'sessions'" class="side-scroll" data-testid="session-list">
      <div
        v-for="s in store.sessions"
        :key="s.id"
        class="session-item"
        data-testid="session-item"
        :data-session-id="s.id"
        :class="{ active: s.id === store.activeSessionId }"
        @click="renamingId === s.id ? undefined : selectSession(s.id)"
      >
        <input
          v-if="renamingId === s.id"
          :ref="(el) => (renameInput = el as HTMLInputElement | null)"
          v-model="renameText"
          class="input rename-input"
          @click.stop
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <template v-else>
          <span class="label" :title="t('sidebar.renameHint')" @dblclick.stop="startRename(s)">
            {{ s.title || t("session.fallbackTitle") }}
          </span>
          <button class="icon-btn" :title="t('common.rename')"
            :aria-label="t('common.rename')" @click.stop="startRename(s)"><Icon name="edit" /></button>
          <!--
            The parameters, between the two edits to the row itself. It selects the conversation
            first, because the dialog is about the conversation on screen (`store.activeSession`)
            and there is no second object to point it at — clicking a row already selects it, so
            this is the same navigation with a dialog on the end.
          -->
          <button
            class="icon-btn"
            data-testid="session-row-settings"
            :title="t('sessionSettings.open')"
            :aria-label="t('sessionSettings.open')"
            @click.stop="openRowSettings(s)"
          ><Icon name="sliders" /></button>
          <button class="icon-btn danger" :title="t('common.delete')"
            :aria-label="t('common.delete')" @click.stop="onDeleteSession(s)"><Icon name="trash" /></button>
        </template>
      </div>
      <div v-if="store.sessions.length === 0" class="muted">{{ t("sidebar.noSessions") }}</div>
    </div>

    <!-- The other panel takes the same scroller. One `.side-scroll` in the DOM either way —
         the sidebar's pinned header and footer depend on exactly one. -->
    <div v-else class="side-scroll" data-testid="file-panel">
      <FileTree />
    </div>

    <!--
      The account's menu, at the foot of the sidebar — the same component the workspace home's
      rail draws, so the two surfaces cannot drift in what they offer or in how they say it.
      They had already drifted in wording, which is the kind of difference nobody files a bug
      about and everybody notices.

      Its two groups stay together here, where the home page puts them at the rail's two ends: the
      sidebar's own content is already at the top, so there is no second end to spread to.

      `workspace-row` is the one row only a page *inside* a workspace can name: this workspace's
      own settings. The other entry to that dialog is the workspace's name in the header above —
      deliberate rather than a duplicate, since the name is the shortcut for someone who already
      knows, and the row is for someone who does not.
    -->
    <AppMenu class="side-menu" workspace-row />

    <NewSessionDialog v-if="showNewSession" @close="showNewSession = false" />
  </aside>
</template>

<style scoped>
/*
 * The menu's top edge. It is a scoped rule of *this* page rather than one of `AppMenu`'s, because
 * a divider separates the menu from whatever is above it — the file or session list here, the
 * brand on the workspace home — and only the page knows what that is.
 */
.side-menu {
  border-top: 1px solid var(--border);
}
.muted {
  padding: var(--space-4) var(--space-6);
  color: var(--text-3);
  font-size: var(--fs-3);
}
.rename-input {
  padding: 3px var(--space-3);
  font-size: var(--fs-3);
  height: 26px;
}
/* Pushes the panel's action to the far end of the strip it shares with the tabs. */
.tab-action {
  margin-left: auto;
  align-self: center;
}
</style>
