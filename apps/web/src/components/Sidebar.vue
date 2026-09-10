<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "../stores/app";
import type { Copilot } from "../api/types";
import type { CopilotDraft } from "../stores/app";
import CreateWorkspaceDialog from "./dialogs/CreateWorkspaceDialog.vue";
import CopilotDialog from "./dialogs/CopilotDialog.vue";

const store = useAppStore();

const showCreateWorkspace = ref(false);
const showCopilotDialog = ref(false);
const editingCopilot = ref<Copilot | null>(null);

function openNewCopilot() {
  editingCopilot.value = null;
  showCopilotDialog.value = true;
}

function openEditCopilot(c: Copilot) {
  editingCopilot.value = c;
  showCopilotDialog.value = true;
}

async function onSaveCopilot(draft: CopilotDraft) {
  await store.saveCopilot(draft);
  showCopilotDialog.value = false;
}

async function onDeleteCopilot(c: Copilot) {
  if (!window.confirm(`删除 Copilot「${c.name}」？`)) return;
  await store.deleteCopilot(c.id);
}
</script>

<template>
  <aside class="sidebar">
    <div class="workspace-select">
      <select
        class="select"
        :value="store.activeWorkspaceId ?? ''"
        @change="store.selectWorkspace(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="w in store.workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
      </select>
      <button class="btn" title="新建工作区" @click="showCreateWorkspace = true">＋</button>
    </div>

    <div class="side-section">
      <span>会话</span>
      <button class="icon-btn" title="新建会话" @click="store.createSession()">＋</button>
    </div>
    <div class="side-scroll">
      <div
        v-for="s in store.sessions"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === store.activeSessionId }"
        @click="store.selectSession(s.id)"
      >
        <span class="label">{{ s.title || "新会话" }}</span>
        <button class="icon-btn danger" title="删除" @click.stop="store.deleteSession(s.id)">
          🗑
        </button>
      </div>
      <div v-if="store.sessions.length === 0" class="muted">暂无会话</div>
    </div>

    <div class="side-section">
      <span>Copilot</span>
      <button class="icon-btn" title="新建 Copilot" @click="openNewCopilot">＋</button>
    </div>
    <div class="side-scroll">
      <div
        v-for="c in store.copilots"
        :key="c.id"
        class="copilot-item"
        :class="{ active: c.id === store.activeCopilotId }"
        @click="store.setCopilot(c.id)"
      >
        <span class="dot"></span>
        <span class="label">{{ c.name }}</span>
        <button class="icon-btn" title="编辑" @click.stop="openEditCopilot(c)">⚙</button>
        <button class="icon-btn danger" title="删除" @click.stop="onDeleteCopilot(c)">🗑</button>
      </div>
      <div v-if="store.copilots.length === 0" class="muted">暂无 Copilot</div>
    </div>

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
    <CopilotDialog
      v-if="showCopilotDialog"
      :copilot="editingCopilot"
      @close="showCopilotDialog = false"
      @save="onSaveCopilot"
    />
  </aside>
</template>

<style scoped>
.copilot-item.active {
  background: var(--panel-2);
  color: var(--text);
}
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
</style>