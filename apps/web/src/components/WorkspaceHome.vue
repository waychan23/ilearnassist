<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import { openWorkspaceSettings, showChat, showWorkspaceHome } from "../composables/ui";
import { isUnauthenticatedError } from "../utils/apiError";
import { relativeTime } from "../composables/relativeTime";
import type { Workspace } from "../api/types";
import CreateWorkspaceDialog from "./dialogs/CreateWorkspaceDialog.vue";
import AppMenu from "./AppMenu.vue";
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
 * The one failure that must *not* navigate is a dead session: the global 401 handler has
 * already cleared the account and switched to the login screen, and showing the chat pane
 * again here would just switch it back.
 */
async function openWorkspace(workspace: Workspace): Promise<void> {
  showChat();
  try {
    await store.selectWorkspace(workspace.id);
  } catch (e) {
    if (isUnauthenticatedError(e)) return;
    showWorkspaceHome();
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
 * The card's activity line.
 *
 * The buckets are `relativeTime`'s, from the shared `time.*` keys — the file lists show the
 * same sentence, so it lives in one place. Only `never` is this card's own: "no activity yet"
 * is a statement about a workspace rather than a bucket of time, and a file always has a
 * modification date.
 */
function activityLabel(workspace: Workspace): string {
  if (!workspace.lastActivityAt) return t("workspace.home.activity.never");
  return relativeTime(workspace.lastActivityAt);
}
</script>

<template>
  <div class="workspace-home" data-testid="workspace-home">
    <!--
      The rail: the account's menu, on the page that has no sidebar of its own.

      The same rows a conversation's sidebar draws, from the same component — an account that has
      not entered a workspace yet has exactly the same things to manage, and having them only
      behind a workspace's front door meant the front door was the one page that could not reach
      them. The rows that used to be icon buttons in the header are gone with it: two entries to
      one dialog, in two idioms, chosen by which page you happened to be standing on.

      The menu's two groups are the rail's two ends here rather than one block at the foot: what
      the account can reach sits under the brand, and who is signed in sits at the bottom, which is
      what fills a column that has nothing else in it. The divider is the *second* group's, since
      the brand's own border already separates the first.
    -->
    <aside class="home-rail">
      <div class="rail-head">
        <span class="rail-brand">{{ t("app.title") }}</span>
      </div>
      <AppMenu class="rail-menu" sources-row />
    </aside>

    <div class="home-main">
      <!--
        The header keeps the two controls that are properties of *this browser* rather than of
        the account — the language and the theme — and nothing else: everything that reaches a
        page or a dialog is a row of the rail beside it.
      -->
      <header class="home-head">
        <span class="home-spacer"></span>
        <TopbarControls />
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

            <!--
              The description, when there is one, above the path. The path is the card's least
              interesting line and the only one that is always there, so the description earns
              the row above it rather than another line below.
            -->
            <p
              v-if="w.description"
              class="ws-card-desc truncate"
              data-testid="workspace-description-text"
              :title="w.description"
            >
              {{ w.description }}
            </p>

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

        <!-- Only reachable after deleting the last one: `loadApp` seeds a workspace on a first
             sign-in, so this is a state the user made rather than one they arrived in. -->
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
  </div>
</template>

<style scoped>
/*
 * The page is two columns: the rail, then everything else.
 *
 * 272px is the sheet's sidebar width — a literal there for the same reason it is one here, and
 * the two are the same *thing* drawn on two pages, so they are the same number. See the note on
 * the grid tracks in `style.css`.
 */
.workspace-home {
  display: grid;
  grid-template-columns: 272px 1fr;
  height: 100%;
  min-height: 0;
}
.home-rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--sidebar);
  border-right: 1px solid var(--border);
}
.rail-head {
  display: flex;
  align-items: center;
  padding: var(--space-6) var(--space-5);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.rail-brand {
  font-size: var(--fs-4);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * The menu takes the height the brand leaves, so its two groups land at the two ends of the rail
 * — the class lands on `AppMenu`'s root element, which is what a scoped rule on a child component
 * can style without `:deep`.
 */
.rail-menu {
  flex: 1;
  min-height: 0;
}
/* The account group's own edge, since it hangs under nothing but empty space. */
.home-rail :deep(.menu-group + .menu-group) {
  margin-top: auto;
  border-top: 1px solid var(--border);
}
.home-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
/* The header is one control wide now, pushed to the right edge. */
.home-spacer {
  flex: 1;
}

/*
 * Narrow: the rail becomes a strip across the top, which is the admin console's rule for the
 * same shape of menu — "there are a handful of rows and they are the page's only navigation" —
 * rather than hiding it, which would put the account's own menu out of reach on a phone.
 */
@media (max-width: 900px) {
  .workspace-home {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }
  .home-rail {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .rail-head {
    padding: var(--space-4) var(--space-5);
  }
  /*
   * The strip: a row of rows, scrolling sideways when more of them than fit — which is the admin
   * console's own treatment of its menu at a narrow width, so the two read the same. Both groups
   * go on it, in order, and the divider between them goes: there is no "between" in a row, and the
   * brand above already draws the line this strip sits under.
   *
   * The rows have to be told to stop filling it: `.menu-item` is `width: 100%`, which is exactly
   * right in a column and makes a one-item strip per screen in a row.
   */
  .rail-menu {
    flex: none;
    overflow-x: auto;
  }
  .workspace-home .home-rail :deep(.app-menu),
  .workspace-home .home-rail :deep(.menu-group) {
    flex-direction: row;
  }
  .workspace-home .home-rail :deep(.menu-group + .menu-group) {
    margin-top: 0;
    border-top: none;
  }
  .workspace-home .home-rail :deep(.side-menu-row) {
    width: auto;
  }
}
</style>
