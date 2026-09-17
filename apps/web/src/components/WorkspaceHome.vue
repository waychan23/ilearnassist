<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import { isCompact } from "../composables/breakpoints";
import { openDrawer, openWorkspaceSettings, uiState } from "../composables/ui";
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
const router = useRouter();

const showCreateWorkspace = ref(false);

/* --------------------------------- opening ---------------------------------- */

/**
 * Enter a workspace.
 *
 * A URL to push, and no more: loading the workspace is the route's own guard, which is what
 * makes this card and a pasted link the same journey. The three failures this used to handle
 * by hand are handled there for the same reason — a workspace that will not load puts the
 * reader back on this page, which is where the retry is, and a dead session is left to the 401
 * handler rather than fought over by two callers.
 */
function openWorkspace(workspace: Workspace): void {
  void router.push({ name: "workspace", params: { workspaceId: workspace.id } });
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
    <aside id="home-rail" class="home-rail" :class="{ open: uiState.drawerOpen }">
      <div class="rail-head">
        <span class="rail-brand">{{ t("app.title") }}</span>
      </div>
      <AppMenu class="rail-menu" />
    </aside>

    <!--
      Covered by the drawer on a compact viewport, so it is taken out of the tab order and the
      accessibility tree for as long as the drawer is over it — the same `inert` the chat pane
      gets, and the whole of the focus story on this page too. It is bound *here* rather than
      passed down from `App.vue` because the element it belongs on is this one: the rail is the
      drawer and must stay reachable, and an attribute falling through to the page root would
      make the drawer itself inert.
    -->
    <div class="home-main" :inert="isCompact && uiState.drawerOpen">
      <!--
        The header keeps the two controls that are properties of *this browser* rather than of
        the account — the language and the theme — and nothing else: everything that reaches a
        page or a dialog is a row of the rail beside it. The one thing that is not a property of
        the browser is now the way *into* the rail, which on a compact viewport is a drawer and
        has to be opened from something.
      -->
      <header class="home-head">
        <!--
          The same control the chat topbar draws, at the same edge and with the same id, because
          it does the same thing: on a compact viewport the rail is off-canvas and this is how
          it comes back. Not rendered above the breakpoint, where the rail is a column and there
          is nothing to open — which also means no desktop spec can reach it by accident.
        -->
        <button
          v-if="isCompact"
          class="icon-btn nav-toggle"
          data-testid="nav-toggle"
          :title="t('sidebar.openNav')"
          :aria-label="t('sidebar.openNav')"
          :aria-expanded="uiState.drawerOpen"
          aria-controls="home-rail"
          @click="openDrawer"
        >
          <Icon name="menu" />
        </button>
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
              The account's own note about the workspace, and the card's only line below the
              name. A workspace's directory used to sit here instead and was the wrong thing to
              spend the row on: it is machine output, a path is a decision nobody reading the
              list made, and the one moment it matters — deleting — names it in the prompt that
              asks. The description is what a person wrote about this workspace, so it is what
              the row is for; with none written, the card is the name and its figures.

              Two lines rather than one, because a description is a sentence somebody chose and
              the whole of it is usually the useful part — a clipped first line reads as a
              caption. `title` carries whatever runs past the second.
            -->
            <p
              v-if="w.description"
              class="ws-card-desc clamp-2"
              data-testid="workspace-description-text"
              :title="w.description"
            >
              {{ w.description }}
            </p>

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
 * Narrow: the rail leaves the grid and becomes a **drawer**, which is the treatment the
 * conversation's sidebar gets on the same viewport.
 *
 * It used to become a strip across the top — the admin console's rule for a handful of rows that
 * are the page's only navigation — and the reason that changed is what the two pages have in
 * common rather than what differs: both rails draw the *same* menu from the same component, so a
 * phone was giving one set of rows two presentations depending on which page you happened to be
 * standing on. The drawer is the one that survives the comparison, because the account's rows are
 * navigation and a strip is a band of the screen permanently spent on it.
 *
 * The values are the sidebar's own, and deliberately: 272px is the column this rail is at a wide
 * width and the drawer both rails slide in from, and the transition, the visibility delay and the
 * stacking are the same three decisions. `style.css` holds that block for the sidebar and says why
 * each part is there.
 */
@media (max-width: 900px) {
  /*
   * One column and one explicit row, which is `.app`'s rule for the same moment: the rail is out
   * of the grid entirely, so the pane is the only in-flow child, and an explicit row is what keeps
   * it filling the height rather than being sized to its content.
   */
  .workspace-home {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
  }
  .home-rail {
    position: fixed;
    inset-block: 0;
    inset-inline-start: 0;
    width: 272px;
    z-index: var(--z-drawer);
    transform: translateX(-100%);
    /*
     * `visibility` for the reason the sidebar gives: without it the closed panel's brand and every
     * menu row stay in the tab order — focusable, off-screen, and announced. The delay keeps it
     * visible until the slide finishes; `.open` cancels both.
     */
    visibility: hidden;
    transition:
      transform var(--dur-slow) var(--ease-drawer),
      visibility 0s linear var(--dur-slow);
  }
  .home-rail.open {
    transform: none;
    visibility: visible;
    transition-delay: 0s, 0s;
  }
}
</style>
