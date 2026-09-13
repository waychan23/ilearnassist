<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import {
  openSettings,
  openSources,
  openWorkspaceSettings,
  showAccount,
  showAdmin,
  showChat,
} from "../composables/ui";
import { formatRelativeTime } from "../utils/format";
import { SUPERADMIN_ROLE, type Workspace } from "../api/types";
import CreateWorkspaceDialog from "./dialogs/CreateWorkspaceDialog.vue";
import TopbarControls from "./TopbarControls.vue";
import Icon from "./Icon.vue";

/**
 * The workspace home — the app's front door, and the only way into a conversation.
 *
 * A page rather than a dropdown in the sidebar, which is what it replaced. The dropdown
 * could name the workspaces but not describe them, so choosing one was a guess; a card has
 * room for what is inside (how many conversations, when it was last touched) and for the
 * two things you might want to do *to* a workspace rather than *in* it. Global Settings
 * lives here too, so the front door is not a dead end for someone who has not picked a
 * workspace yet — and cannot be, since there is nowhere else to go from here.
 */
const { t } = useI18n();
const store = useAppStore();

const showCreateWorkspace = ref(false);

/* --------------------------------- opening ---------------------------------- */

/**
 * Enter a workspace.
 *
 * The pane is shown before the session list is awaited, so the click paints immediately
 * rather than after a round trip; the sidebar renders its empty state and fills in. On a
 * failure the user is put back on this page, which is where the retry is — leaving them in
 * a chat pane belonging to a workspace that never loaded is the one outcome with no way out.
 */
async function openWorkspace(workspace: Workspace): Promise<void> {
  showChat();
  try {
    await store.selectWorkspace(workspace.id);
  } catch (e) {
    showChat();
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/* ------------------------------ create/delete ------------------------------- */

function openNewWorkspace(): void {
  showCreateWorkspace.value = true;
}

async function onDelete(workspace: Workspace): Promise<void> {
  const ok = await confirm({
    title: t("workspace.delete.title"),
    message: t("workspace.delete.message", { name: workspace.name }),
    detail: t("workspace.delete.detail", { path: workspace.dirPath }),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteWorkspace(workspace.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/* --------------------------------- rename ----------------------------------- */

const renamingId = ref<string | null>(null);
const renameText = ref("");
const renameInput = ref<HTMLInputElement | null>(null);

function startRename(workspace: Workspace): void {
  renamingId.value = workspace.id;
  renameText.value = workspace.name;
  nextTick(() => {
    renameInput.value?.focus();
    renameInput.value?.select();
  });
}

async function commitRename(): Promise<void> {
  const id = renamingId.value;
  if (!id) return;
  const name = renameText.value;
  renamingId.value = null;
  // Unchanged or emptied: nothing to write, and no error worth showing for either.
  if (!name.trim() || name.trim() === store.workspaces.find((w) => w.id === id)?.name) return;
  try {
    await store.renameWorkspace(id, name);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

function cancelRename(): void {
  renamingId.value = null;
}

/* ---------------------------------- copy ------------------------------------ */

function sessionLabel(workspace: Workspace): string {
  return t("workspace.home.sessions", { count: workspace.sessionCount }, workspace.sessionCount);
}

/**
 * The card's activity line. The relative buckets come from `formatRelativeTime` as a
 * description and are worded here, because the wording has to come from the catalogs — and
 * because `en` plurals branch on the count where `zh-CN` does not.
 */
function activityLabel(workspace: Workspace): string {
  if (!workspace.lastActivityAt) return t("workspace.home.activity.never");
  const rel = formatRelativeTime(workspace.lastActivityAt);
  switch (rel.kind) {
    case "now":
      return t("workspace.home.activity.now");
    case "minutes":
      return t("workspace.home.activity.minutes", { count: rel.count }, rel.count);
    case "hours":
      return t("workspace.home.activity.hours", { count: rel.count }, rel.count);
    case "days":
      return t("workspace.home.activity.days", { count: rel.count }, rel.count);
    /* Past a week it is a bare date, and there is nothing to say about it beyond the value
       — which is why this branch has no catalog entry. */
    case "date":
      return rel.value;
  }
}
</script>

<template>
  <div class="workspace-home" data-testid="workspace-home">
    <header class="home-head">
      <span class="home-brand">{{ t("app.title") }}</span>
      <!-- Reachable before a workspace has been chosen: the theme and the language are
           properties of the app, not of a conversation. -->
      <TopbarControls />
      <!--
        Next to Settings rather than in the sidebar, because a source belongs to the account:
        the same file is reachable from every workspace, and an entry inside one of them would
        say otherwise.
      -->
      <button
        class="icon-btn"
        data-testid="open-sources"
        :title="t('sources.open')"
        :aria-label="t('sources.open')"
        @click="openSources"
      >
        <Icon name="folder" />
      </button>
      <button
        class="icon-btn"
        data-testid="open-settings"
        :title="t('common.settings')"
        :aria-label="t('common.settings')"
        @click="openSettings"
      >
        <Icon name="gear" />
      </button>
      <!--
        The platform console, for the accounts the server would let in. Drawn from the role the
        server reported rather than from anything the page decided — and a hidden button is not
        a permission, so the routes answer 403 for everybody else regardless.
      -->
      <button
        v-if="store.account?.roles.includes(SUPERADMIN_ROLE)"
        class="icon-btn"
        data-testid="open-admin"
        :title="t('admin.title')"
        :aria-label="t('admin.title')"
        @click="showAdmin()"
      >
        <Icon name="shield" />
      </button>
      <button
        class="icon-btn"
        data-testid="open-account"
        :title="t('account.title')"
        :aria-label="t('account.title')"
        @click="showAccount()"
      >
        <Icon name="user" />
      </button>
      <button
        class="icon-btn"
        data-testid="sign-out"
        :title="t('common.signOut')"
        :aria-label="t('common.signOut')"
        @click="store.signOut()"
      >
        <Icon name="logout" />
      </button>
    </header>

    <div class="home-scroll">
      <div class="home-intro">
        <h2 class="home-title">{{ t("workspace.home.title") }}</h2>
        <p class="home-sub">{{ t("workspace.home.subtitle") }}</p>
      </div>

      <div v-if="store.workspaces.length" class="ws-grid">
        <article
          v-for="w in store.workspaces"
          :key="w.id"
          class="ws-card"
          data-testid="workspace-card"
          :data-workspace-id="w.id"
        >
          <input
            v-if="renamingId === w.id"
            :ref="(el) => (renameInput = el as HTMLInputElement | null)"
            v-model="renameText"
            class="input ws-card-rename"
            data-testid="workspace-rename-input"
            :aria-label="t('common.rename')"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <!--
            The card's one control. It is the accessible name of the whole card and stretches
            over it via `::after`, so a click anywhere opens the workspace — see the note on
            `.ws-card-open` in `style.css` for why the actions are siblings rather than
            children of it.
          -->
          <button
            v-else
            class="ws-card-open"
            data-testid="workspace-open"
            :aria-label="t('workspace.home.open', { name: w.name })"
            @click="openWorkspace(w)"
          >
            {{ w.name }}
          </button>

          <p class="ws-card-path truncate" :title="w.dirPath">{{ w.dirPath }}</p>

          <div class="ws-card-foot">
            <span class="ws-card-activity" data-testid="workspace-activity">
              {{ sessionLabel(w) }} · {{ activityLabel(w) }}
            </span>
            <span v-if="renamingId !== w.id" class="ws-card-actions">
              <!--
                The settings entry point that does not require entering the workspace first, so
                the widgets can be chosen before there is anything to look at. The other one is
                the workspace name in the sidebar.
              -->
              <button
                class="icon-btn"
                data-testid="workspace-settings-open"
                :title="t('widgets.workspaceSettings.title')"
                :aria-label="t('widgets.workspaceSettings.title')"
                @click="openWorkspaceSettings(w.id)"
              >
                <Icon name="gear" />
              </button>
              <button
                class="icon-btn"
                data-testid="workspace-rename"
                :title="t('common.rename')"
                :aria-label="t('common.rename')"
                @click="startRename(w)"
              >
                <Icon name="edit" />
              </button>
              <button
                class="icon-btn danger"
                data-testid="workspace-delete"
                :title="t('common.delete')"
                :aria-label="t('common.delete')"
                @click="onDelete(w)"
              >
                <Icon name="trash" />
              </button>
            </span>
          </div>
        </article>

        <button class="ws-card-new" data-testid="workspace-new" @click="openNewWorkspace">
          <Icon name="plus" /> {{ t("workspace.home.newCard") }}
        </button>
      </div>

      <!-- Only reachable after deleting the last one: `init()` seeds "Default" on a first
           run, so this is a state the user made rather than one they arrived in. -->
      <div v-else class="home-empty" data-testid="workspace-empty">
        <h2>{{ t("workspace.home.empty") }}</h2>
        <p>{{ t("workspace.home.emptyHint") }}</p>
      </div>
    </div>

    <CreateWorkspaceDialog
      v-if="showCreateWorkspace"
      @close="showCreateWorkspace = false"
      @created="showCreateWorkspace = false"
    />
  </div>
</template>
