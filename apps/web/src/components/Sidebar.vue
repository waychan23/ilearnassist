<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import type { Session } from "../api/types";
import { openSettings } from "../composables/ui";
import CreateWorkspaceDialog from "./dialogs/CreateWorkspaceDialog.vue";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";

const { t } = useI18n();
const store = useAppStore();

const showCreateWorkspace = ref(false);
const showNewSession = ref(false);

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
  <aside class="sidebar">
    <div class="workspace-select">
      <select
        class="select"
        data-testid="workspace-select"
        :value="store.activeWorkspaceId ?? ''"
        @change="store.selectWorkspace(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="w in store.workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
      </select>
      <button class="icon-btn" :title="t('sidebar.newWorkspace')" @click="showCreateWorkspace = true">＋</button>
      <button
        class="icon-btn danger"
        :title="t('sidebar.deleteWorkspace')"
        :disabled="!store.activeWorkspace"
        @click="onDeleteWorkspace"
      >
        🗑
      </button>
    </div>

    <div class="side-section">
      <span>{{ t("sidebar.sessions") }}</span>
      <button class="icon-btn" data-testid="new-session" :title="t('sidebar.newSession')" @click="showNewSession = true">
        ＋
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
        @click="renamingId === s.id ? undefined : store.selectSession(s.id)"
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
          <button class="icon-btn" :title="t('sidebar.rename')" @click.stop="startRename(s)">✎</button>
          <button class="icon-btn danger" :title="t('sidebar.delete')" @click.stop="onDeleteSession(s)">🗑</button>
        </template>
      </div>
      <div v-if="store.sessions.length === 0" class="muted">{{ t("sidebar.noSessions") }}</div>
    </div>

    <!-- Global settings live at the foot of the sidebar, as in chatbox. -->
    <button class="side-settings" :title="t('sidebar.settings')" data-testid="open-settings" @click="openSettings()">
      <span class="gear">⚙</span>
      <span class="label">{{ t("sidebar.settings") }}</span>
      <span class="sub">{{ store.activeWorkspace?.name ?? "" }}</span>
    </button>

    <div class="side-footer">
      <span class="dir" :title="store.config?.workspacesRootDir ?? ''">
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
  padding: 8px 14px;
  color: var(--text-3);
  font-size: 13px;
}
.dir {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-settings {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  flex-shrink: 0;
}
.side-settings:hover {
  background: var(--panel);
  color: var(--text);
}
.side-settings .gear {
  font-size: 14px;
  flex-shrink: 0;
}
.side-settings .label {
  flex-shrink: 0;
}
.side-settings .sub {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--text-3);
  font-size: 11px;
}
.rename-input {
  padding: 3px 6px;
  font-size: 13px;
  height: 26px;
}
</style>
