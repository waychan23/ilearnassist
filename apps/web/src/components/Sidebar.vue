<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import type { Session } from "../api/types";
import { closeDrawer, openSettings, uiState } from "../composables/ui";
import CreateWorkspaceDialog from "./dialogs/CreateWorkspaceDialog.vue";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";
import Icon from "./Icon.vue";

const { t } = useI18n();
const store = useAppStore();

const showCreateWorkspace = ref(false);
const showNewSession = ref(false);

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
function onWorkspaceChange(event: Event) {
  void store.selectWorkspace((event.target as HTMLSelectElement).value);
  closeDrawer();
}

function openNewWorkspace() {
  showCreateWorkspace.value = true;
  closeDrawer();
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

async function onDeleteWorkspace() {
  const ws = store.activeWorkspace;
  if (!ws) return;
  const ok = await confirm({
    title: t("workspace.delete.title"),
    message: t("workspace.delete.message", { name: ws.name }),
    detail: t("workspace.delete.detail", { path: ws.dirPath }),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (ok) await store.deleteWorkspace(ws.id);
}
</script>

<template>
  <aside
    id="app-sidebar"
    class="sidebar"
    data-testid="sidebar"
    :class="{ open: uiState.drawerOpen }"
  >
    <div class="workspace-select">
      <select
        class="select"
        data-testid="workspace-select"
        :value="store.activeWorkspaceId ?? ''"
        @change="onWorkspaceChange"
      >
        <option v-for="w in store.workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
      </select>
      <button class="icon-btn" :title="t('sidebar.newWorkspace')"
        :aria-label="t('sidebar.newWorkspace')" @click="openNewWorkspace"><Icon name="plus" /></button>
      <button
        class="icon-btn danger"
        :title="t('sidebar.deleteWorkspace')"
        :aria-label="t('sidebar.deleteWorkspace')"
        :disabled="!store.activeWorkspace"
        @click="onDeleteWorkspace"
      >
        <Icon name="trash" />
      </button>
    </div>

    <div class="side-section">
      <span>{{ t("sidebar.sessions") }}</span>
      <button class="icon-btn" data-testid="new-session" :title="t('sidebar.newSession')"
        :aria-label="t('sidebar.newSession')" @click="openNewSession">
        <Icon name="plus" />
      </button>
    </div>

    <div class="side-scroll" data-testid="session-list">
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
          <button class="icon-btn" :title="t('sidebar.rename')"
            :aria-label="t('sidebar.rename')" @click.stop="startRename(s)"><Icon name="edit" /></button>
          <button class="icon-btn danger" :title="t('sidebar.delete')"
            :aria-label="t('sidebar.delete')" @click.stop="onDeleteSession(s)"><Icon name="trash" /></button>
        </template>
      </div>
      <div v-if="store.sessions.length === 0" class="muted">{{ t("sidebar.noSessions") }}</div>
    </div>

    <!-- Global settings live at the foot of the sidebar, as in chatbox. -->
    <button
      class="menu-item side-settings"
      :title="t('sidebar.settings')"
      data-testid="open-settings"
      @click="openSidebarSettings"
    >
      <span class="gear"><Icon name="gear" /></span>
      <span class="label">{{ t("sidebar.settings") }}</span>
      <span class="sub truncate">{{ store.activeWorkspace?.name ?? "" }}</span>
    </button>

    <div class="side-footer">
      <span class="dir truncate" :title="store.config?.workspacesRootDir ?? ''">
        {{ store.config?.workspacesRootDir }}
      </span>
    </div>

    <CreateWorkspaceDialog
      v-if="showCreateWorkspace"
      @close="showCreateWorkspace = false"
      @created="showCreateWorkspace = false"
    />
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
.side-settings {
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6);
  border-top: 1px solid var(--border);
  border-radius: 0;
  flex-shrink: 0;
}
.side-settings .gear {
  font-size: var(--fs-4);
  flex-shrink: 0;
}
.side-settings .label {
  flex-shrink: 0;
}
.side-settings .sub {
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
</style>
