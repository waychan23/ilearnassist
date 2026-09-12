<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import type { Session } from "../api/types";
import { closeDrawer, openSettings, showWorkspaceHome, uiState } from "../composables/ui";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";
import FileTree from "./FileTree.vue";
import Icon from "./Icon.vue";

const { t } = useI18n();
const store = useAppStore();

const showNewSession = ref(false);

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

function openSidebarSettings() {
  closeDrawer();
  openSettings();
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
    :class="{ open: uiState.drawerOpen }"
  >
    <!--
      The workspace switcher, now a breadcrumb rather than a dropdown. The dropdown listed
      every workspace and moved you sideways between them; the home page does that job now,
      with room to say what is in each one, so this row does the only thing left: go back.
      The current workspace stays named here because the topbar names the *conversation*,
      and on the welcome screen it falls back to the workspace — a name worth confirming.

      Creating one is on the home page too, and deliberately not repeated here. This row is
      the way out of a workspace, and a `+` beside it made the two most different actions on
      the sidebar — go back, and make something new — sit a few pixels apart under one
      cursor. The workspace list is one click away and has a card for it.
    -->
    <div class="workspace-head">
      <button
        class="menu-item workspace-back"
        data-testid="all-workspaces"
        :title="t('sidebar.allWorkspaces')"
        @click="backToWorkspaces"
      >
        <span class="arrow"><Icon name="arrow-left" /></span>
        <span class="label">{{ t("sidebar.allWorkspaces") }}</span>
        <span class="sub truncate">{{ store.activeWorkspace?.name ?? "" }}</span>
      </button>
    </div>

    <!--
      The two panels, and the action that belongs to whichever is open.

      The action is contextual — new conversation, or refresh the tree — because the strip and
      its button share one row and the sidebar's vertical budget on a phone is real. The plain
      `.tab` buttons mirror the settings dialog's strip rather than inventing a second kind;
      see `docs/design-system.md` on why a shared class is not re-declared locally.
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

    <!-- Global settings live at the foot of the sidebar, as in chatbox. -->
    <button
      class="menu-item side-settings"
      :title="t('common.settings')"
      data-testid="open-settings"
      @click="openSidebarSettings"
    >
      <span class="gear"><Icon name="gear" /></span>
      <span class="label">{{ t("common.settings") }}</span>
      <span class="sub truncate">{{ store.activeWorkspace?.name ?? "" }}</span>
    </button>

    <!-- Sign out sits beside Settings rather than on a menu of its own: with no password to
         forget, it is one action and one click costs nothing. No confirmation either — the
         only thing a misclick loses is typing your name again. -->
    <button
      class="menu-item side-signout"
      :title="t('common.signOut')"
      data-testid="sign-out"
      @click="store.signOut()"
    >
      <span class="gear"><Icon name="logout" /></span>
      <span class="label">{{ t("common.signOut") }}</span>
      <span class="sub truncate">{{ store.account?.username ?? "" }}</span>
    </button>

    <div class="side-footer">
      <span class="dir truncate" :title="store.config?.workspacesRootDir ?? ''">
        {{ store.config?.workspacesRootDir }}
      </span>
    </div>

    <NewSessionDialog v-if="showNewSession" @close="showNewSession = false" />
  </aside>
</template>

<style scoped>
.muted {
  padding: var(--space-4) var(--space-6);
  color: var(--text-3);
  font-size: var(--fs-3);
}
/* `.menu-item` gives the row its reset, spacing and hover. It is full-bleed at the foot of
   the sidebar, so it takes a top border instead of the radius a floating row would have. */
/* Settings and Sign out are two rows of one footer group, so they share everything except the
 * divider — which belongs above the pair, not between them. */
.side-settings,
.side-signout {
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6);
  border-radius: 0;
  flex-shrink: 0;
}
.side-settings {
  border-top: 1px solid var(--border);
}
.side-settings .gear,
.side-signout .gear {
  font-size: var(--fs-4);
  flex-shrink: 0;
}
.side-settings .label,
.side-signout .label {
  flex-shrink: 0;
}
.side-settings .sub,
.side-signout .sub {
  flex: 1;
  text-align: right;
  color: var(--text-3);
  font-size: var(--fs-1);
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
