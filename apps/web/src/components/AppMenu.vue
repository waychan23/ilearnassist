<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import {
  closeDrawer,
  openCopilots,
  openSources,
  openWorkspaceSettings,
  showAccount,
  showAdmin,
} from "../composables/ui";
import Icon from "./Icon.vue";

/**
 * The account's own menu: the rows every page that has a rail shows.
 *
 * It is one component because the same four or five rows have to appear twice — at the foot of a
 * conversation's sidebar and, since the workspace home gained a rail, at the foot of that one.
 * Two copies would be two places to remember when a row is added, and they had already begun to
 * differ in *wording* rather than in content: the home page called the same dialog by a
 * different label. The rows are identical here; only the surface they are drawn on differs.
 *
 * The one row that is not always there is **workspace settings**, which belongs to a workspace
 * rather than to an account — a rail on a page that is *about the list of workspaces* has no
 * workspace to configure, so the row is behind a prop rather than drawn and disabled.
 *
 * The test ids are shared with the surfaces, and that is safe for a reason worth stating: the
 * two rails are never mounted at once. `uiState.view` picks `WorkspaceHome` *or* the
 * `Sidebar + ChatView` pair, so a spec that asks for `open-copilots` finds exactly one.
 */

defineProps<{
  /** Draw the workspace-settings row. Only a page inside a workspace has one to name. */
  workspaceRow?: boolean;
  /**
   * Draw the account's library row.
   *
   * The chat rail does not: its header already has the button that opens the same browser, and
   * two entries to one dialog in two idioms is what this change is removing rather than adding.
   * The home page has no such header — its topbar is the language and the theme — so this is
   * where the library is reachable from the front door.
   */
  sourcesRow?: boolean;
}>();

const { t } = useI18n();
const store = useAppStore();

/*
 * Both dialogs close the drawer on the way out, because this menu is drawn *inside* it on a
 * compact viewport: leaving it open would carry the flag into the page behind, which greets the
 * user with a drawer they did not ask for. The two view switches (`showAccount`, `showAdmin`)
 * already do this themselves, which is why only these two need it here.
 */
function onOpenCopilots(): void {
  closeDrawer();
  openCopilots();
}

function onOpenWorkspaceSettings(): void {
  const id = store.activeWorkspaceId;
  if (!id) return;
  closeDrawer();
  openWorkspaceSettings(id);
}
</script>

<template>
  <div class="app-menu">
    <!--
      The upper group: the material the account holds, the assistants it made, and the console for
      the accounts that have it — everything that is about *what can be reached*. On the workspace
      home this group is the top of the rail; on a conversation's sidebar it is the first half of
      the footer, because there the sidebar's own content is already at the top.
    -->
    <div class="menu-group" data-testid="menu-group-app">
      <!--
        The workspace's own settings. It is the *labelled* of the two entries to that dialog (the
        other is the workspace's name in the sidebar header), for someone who does not already know
        that the name opens it. First in the group because it is the only row that names *where you
        are* rather than what you can reach.
      -->
      <button
        v-if="workspaceRow"
        class="menu-item side-menu-row"
        :title="t('widgets.workspaceSettings.title')"
        data-testid="open-workspace-settings"
        @click="onOpenWorkspaceSettings"
      >
        <span class="gear"><Icon name="gear" /></span>
        <span class="label">{{ t("widgets.workspaceSettings.title") }}</span>
        <span class="sub truncate">{{ store.activeWorkspace?.name ?? "" }}</span>
      </button>

    <!--
      The account's library: every source it holds, filterable. See the prop's note for why only
      one of the two rails draws it.
    -->
    <button
      v-if="sourcesRow"
      class="menu-item side-menu-row"
      :title="t('sources.title')"
      data-testid="open-sources"
      @click="openSources()"
    >
      <span class="gear"><Icon name="folder" /></span>
      <span class="label">{{ t("sources.title") }}</span>
    </button>

    <!--
      The account's own assistants. One row here and one on each rail, so an account that has not
      entered a workspace yet can still manage the ones it made.
    -->
    <button
      class="menu-item side-menu-row"
      :title="t('copilots.title')"
      data-testid="open-copilots"
      @click="onOpenCopilots"
    >
      <span class="gear"><Icon name="robot" /></span>
      <span class="label">{{ t("copilots.title") }}</span>
    </button>

      <!--
        The platform console, for the accounts the server would let in. Drawn from the role the
        server reported rather than from anything this component decided — and a hidden button is
        not a permission, since the routes refuse everybody else regardless.
      -->
      <button
        v-if="store.canAdmin"
        class="menu-item side-menu-row"
        :title="t('admin.title')"
        data-testid="open-admin"
        @click="showAdmin()"
      >
        <span class="gear"><Icon name="shield" /></span>
        <span class="label">{{ t("admin.title") }}</span>
      </button>
    </div>

    <!--
      The lower group: the account's own page and the way out. These two are about *who is signed
      in* rather than about what they can reach, which is why they are a group of their own — and on
      the workspace home the split is also the layout, with this one at the foot of the rail and the
      group above it at the top.
    -->
    <div class="menu-group" data-testid="menu-group-account">
      <button
        class="menu-item side-menu-row"
        :title="t('account.title')"
        data-testid="open-account"
        @click="showAccount()"
      >
        <span class="gear"><Icon name="user" /></span>
        <span class="label">{{ t("account.title") }}</span>
        <span class="sub truncate">{{ store.account?.username ?? "" }}</span>
      </button>

      <!-- Sign out sits last: one action, one click, and no confirmation — signing back in is the
           only thing a misclick costs. -->
      <button
        class="menu-item side-menu-row side-signout"
        :title="t('common.signOut')"
        data-testid="sign-out"
        @click="store.signOut()"
      >
        <span class="gear"><Icon name="logout" /></span>
        <span class="label">{{ t("common.signOut") }}</span>
        <span class="sub truncate">{{ store.account?.username ?? "" }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * `.menu-item` in the stylesheet gives a row its reset, spacing and hover. These rules are what
 * a *rail's row* adds on top of that, and they are here rather than on either rail because this
 * component is the one that draws the rows: a rule left in `Sidebar.vue`'s scoped block would
 * stop applying the moment the same row is drawn from the home page, silently and with no test to
 * catch it — Vue's scoping attaches the *parent's* id to a child component's root element only,
 * never to the elements inside it.
 *
 * The groups stack here and are *placed* by the caller: the two rails put them in different
 * places (top-and-bottom on the home page, both at the foot of a conversation's sidebar), and a
 * divider belongs to whichever surface has something above the menu to separate it from.
 */
.app-menu {
  display: flex;
  flex-direction: column;
}
.menu-group {
  display: flex;
  flex-direction: column;
}
.side-menu-row {
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6);
  border-radius: 0;
  flex-shrink: 0;
}
.side-menu-row .gear {
  font-size: var(--fs-4);
  flex-shrink: 0;
}
.side-menu-row .label {
  flex-shrink: 0;
}
.side-menu-row .sub {
  flex: 1;
  text-align: right;
  color: var(--text-3);
  font-size: var(--fs-1);
}
</style>
