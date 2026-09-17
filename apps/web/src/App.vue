<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "./stores/app";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";
import WorkspaceHome from "./components/WorkspaceHome.vue";
import AccountView from "./components/AccountView.vue";
import AdminConsole from "./components/AdminConsole.vue";
import LoginView from "./components/LoginView.vue";
import ChangePasswordView from "./components/ChangePasswordView.vue";
import WidgetPanel from "./components/WidgetPanel.vue";
import ConfirmDialog from "./components/dialogs/ConfirmDialog.vue";
import CopilotsDialog from "./components/dialogs/CopilotsDialog.vue";
import SourceBrowser from "./components/dialogs/SourceBrowser.vue";
import FilePreviewDialog from "./components/dialogs/FilePreviewDialog.vue";
import WorkspaceSettingsDialog from "./components/dialogs/WorkspaceSettingsDialog.vue";
import SessionSettingsDialog from "./components/dialogs/SessionSettingsDialog.vue";
import {
  closeCopilots,
  closeDrawer,
  closeSessionSettings,
  closeSources,
  closeWidgetDrawer,
  sidebarRail,
  uiState,
} from "./composables/ui";
import { isCompact } from "./composables/breakpoints";
import { widgetPanel } from "./composables/widgetPanel";
import { confirmState } from "./composables/confirm";
import Icon from "./components/Icon.vue";

const store = useAppStore();
const { t } = useI18n();

/**
 * Whether the widget panel exists at all.
 *
 * Two conditions, and neither is about the viewport: the panel shows on a conversation page and
 * only when something is installed. Behind 900px it is rendered as a drawer rather than not at
 * all — the *same* element, laid out by a media query, which is why this does not test `isCompact`
 * while the grid track below does.
 */
const showWidgetPanel = computed(
  () => uiState.view === "chat" && store.enabledWidgetIds.length > 0
);

/**
 * Whether the panel is a third grid track.
 *
 * Only where it is in flow. On a compact viewport it is a fixed overlay, and `.app.with-widgets`
 * would add a track the drawer does not occupy — a sliver of empty column beside a panel that is
 * already covering the pane.
 */
const widgetPanelInFlow = computed(() => showWidgetPanel.value && !isCompact.value);

onMounted(() => {
  store.init().catch((e) => store.setError(e instanceof Error ? e.message : String(e)));
});

/* ---------------------------------- drawer ---------------------------------- */

/**
 * Escape closes the drawer — but only the drawer.
 *
 * `ConfirmDialog` listens on `window` for the same key, so with a confirm prompt raised over
 * an open drawer a single press would close both: the prompt vanishes and the thing that
 * asked for it slides away underneath. The same applies to the Copilot list, which the sidebar's
 * own footer opens, and to the file preview, which the sidebar opens too. Returning early while
 * any of them is up leaves the topmost layer to handle it.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  // The widget drawer is the same case as the left one, and the two can be open at once — so
  // each is handled by the same handler and neither falls through to the other.
  if (!uiState.drawerOpen && !uiState.widgetDrawerOpen) return;
  if (confirmState.open || uiState.copilotsOpen || store.filePreviewPath) return;
  closeDrawer();
  closeWidgetDrawer();
}

watch(
  () => uiState.drawerOpen || uiState.widgetDrawerOpen,
  (anyOpen) => {
    if (anyOpen) window.addEventListener("keydown", onKeydown);
    else window.removeEventListener("keydown", onKeydown);
  }
);

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

/**
 * Focus follows the drawer: into a control when it opens, back to the button that opened it
 * when it closes.
 *
 * The open target used to be the workspace `<select>`, which was the drawer's first control
 * and moved you sideways between workspaces. That select is gone — the workspace home does
 * its job — and the row that replaced it is a *back* button, which is not what someone
 * opening the drawer is after. Focus goes to "new conversation" instead: a real control in
 * the same region, and a constructive one, so a stray Enter does not undo the navigation
 * the user just asked for.
 *
 * Queried rather than threaded up through an event: the two ends live in `Sidebar` and
 * `ChatView`, and an emit chain to hand `App` an element reference would be more moving
 * parts than a selector for something that is on screen exactly once.
 *
 * The open target is *whichever panel action is on screen*, and the comma selector is what
 * makes that one expression: the sidebar's strip swaps `new-session` for the files refresh,
 * so naming only the first would leave the drawer opening with focus nowhere when the files
 * panel is the one showing.
 *
 * **Three pages draw that drawer now**, and the selector is one expression for all of them
 * because `querySelector` returns the first match in *document order*: on a conversation the
 * panel actions come first and win, on the workspace home the menu rows do, and on the console
 * the section links do. The individual entries are therefore alternatives rather than a
 * sequence — order within the list does not matter, only where each lands in the DOM.
 *
 * The prefix selector is the console's, and a prefix is deliberate there: the section ids are
 * `SECTIONS`' own and a list of four would be a fifth thing to keep in step with it. It matches
 * nothing outside `AdminConsole.vue`, which is what keeps it narrow enough to be safe.
 *
 * The menu rows are listed individually because they *are* individually conditional — the
 * console for the accounts that have it, the workspace settings on a page inside a workspace —
 * so naming only the first would leave the drawer opening with focus nowhere on the pages where
 * it is not drawn.
 *
 * Together with the backdrop, the `inert` on the pane behind it and the Escape handler this
 * is the whole focus story — a hand-rolled trap would be a state machine doing what `inert`
 * already does.
 */
watch(
  () => uiState.drawerOpen,
  async (open) => {
    if (!isCompact.value) return;
    await nextTick();
    const selector = open
      ? [
          "[data-testid='new-session']",
          "[data-testid='files-refresh']",
          "[data-testid='open-sources']",
          "[data-testid='open-workspace-settings']",
          "[data-testid='open-copilots']",
          "[data-testid='open-admin']",
          "[data-testid^='admin-nav-']",
        ].join(", ")
      : '[data-testid="nav-toggle"]';
    document.querySelector<HTMLElement>(selector)?.focus();
  }
);
</script>

<template>
  <!--
    Three views, and the flag that picks between them lives in `composables/ui.ts`. There is
    still no router: a route table for one flag would be a dependency and a URL nobody types.

    Nothing renders until `authReady`, and that gate is not tidiness. The session cookie is
    HttpOnly, so the page cannot know whether anyone is signed in until `/api/auth/me`
    answers — and treating the login screen as the initial guess would flash it at a
    signed-in user on every single refresh. Rendering neither view for those few hundred
    milliseconds is the only honest option.

    The overlays below sit outside the branch because the signed-in views all reach them —
    the Copilot list from the sidebar footer *and* from the workspace home.
  -->
  <div
    class="app"
    :class="{
      /* The three single-column pages, and the sign-in pair among them. `auth` is what the
         password-change screen shares with the sign-in screen: both are one centred card with
         no sidebar, which is a layout rather than a session state. The `home` class is the
         same rule for the pages that do have a header — see `style.css`. */
      home: uiState.view === 'home' || uiState.view === 'account' || uiState.view === 'admin',
      auth: uiState.view === 'login' || uiState.view === 'password',
      /* The rail is a grid *track*, not a width on the sidebar. See `sidebarRail` for the
         two conditions inside it, and `style.css` for why the track is the element that
         has to move. */
      'sidebar-collapsed': sidebarRail,
      /* And the widget panel is a third track, for the same reason: it is a column beside the
         conversation, not a floating thing over it. */
      'with-widgets': widgetPanelInFlow,
    }"
    :style="{ '--widget-w': widgetPanel.widthCss.value }"
  >
    <LoginView v-if="uiState.authReady && uiState.view === 'login'" />

    <!-- Signed in, and held here until a password is chosen. Its own branch rather than a
         dialog over the app: the server refuses every other route in this state, so there is
         no app behind it to draw. -->
    <ChangePasswordView v-else-if="uiState.authReady && uiState.view === 'password'" />

    <template v-else-if="uiState.authReady">
      <WorkspaceHome v-if="uiState.view === 'home'" />

      <AccountView v-else-if="uiState.view === 'account'" />
      <!-- Superadmin-only, and the server is what enforces it — this branch is the shape of
           the feature. Reached from the account page and the workspace home. -->
      <AdminConsole v-else-if="uiState.view === 'admin'" />

      <template v-else>
        <Sidebar :inert="!uiState.drawerOpen && isCompact" />

        <!--
          Only on a compact viewport, and only while one of the drawers is open. `inert` takes the
          pane behind it out of the tab order and the accessibility tree, which is the same job a
          focus trap does with a fraction of the state. `ChatView` is single-root, so the attribute
          falls through to `<main>` — and it tests *both* drawers, since either one covers it.
        -->
        <ChatView :inert="(uiState.drawerOpen || uiState.widgetDrawerOpen) && isCompact" />

        <WidgetPanel v-if="showWidgetPanel" />

        <!-- A backdrop of its own rather than a shared one, so a click can only dismiss the
             drawer it was pointing at. -->
        <div
          v-if="isCompact && uiState.widgetDrawerOpen"
          class="drawer-backdrop"
          data-testid="widget-drawer-backdrop"
          aria-hidden="true"
          @click="closeWidgetDrawer"
        />
      </template>

      <!--
        The left drawer's backdrop, outside the branch above because **two pages have that
        drawer**: the conversation's sidebar and the workspace home's rail, which is the same
        column holding the same menu. One element, one flag — the two never render together, so
        there is nothing for a second backdrop to disambiguate.
      -->
      <div
        v-if="isCompact && uiState.drawerOpen"
        class="drawer-backdrop"
        data-testid="drawer-backdrop"
        aria-hidden="true"
        @click="closeDrawer"
      />
    </template>

    <!-- Hosted once so every `confirm()` call from anywhere lands in the same prompt. -->
    <ConfirmDialog />
    <!-- Reachable from the sidebar footer and from the workspace home's header — the front
         door has no sidebar, and managing your own Copilots is not something entering a
         workspace should be a precondition for. -->
    <CopilotsDialog v-if="uiState.copilotsOpen" @close="closeCopilots" />
    <!-- Per workspace rather than per installation, so it is not a tab of the dialog above.
         Keyed on the id: opening it for a different workspace has to rebuild the list. -->
    <WorkspaceSettingsDialog
      v-if="uiState.workspaceSettingsId"
      :key="uiState.workspaceSettingsId"
    />
    <!--
      The conversation's parameters, hosted here rather than in the composer that used to own
      them: three controls open it now — the composer's button, the topbar's, and the settings
      button on a row of the conversation list — and the last two are siblings with no common
      ancestor to pass an event through.
    -->
    <SessionSettingsDialog v-if="uiState.sessionSettingsOpen" @close="closeSessionSettings" />
    <!--
      The source browser, from either front door. `uiState.sourcesScope` is what the caller
      decided: the home page opens it over the whole account, and a conversation opens it *on*
      its workspace — a default the browser's own workspace picker moves in one click, which is
      why the picker is drawn from both doors.
    -->
    <SourceBrowser
      :initial="{ workspaceId: uiState.sourcesScope?.workspaceId }"
      @close="closeSources"
    />
    <!-- Mounted for its lifetime rather than behind a `v-if` on the file: it renders nothing
         until one is opened, and the Sidebar — which would be the natural host — unmounts on
         the way back to the workspace home. -->
    <FilePreviewDialog />
    <Transition name="fade">
      <div v-if="store.error" class="toast" data-testid="toast">
        <span>{{ store.error }}</span>
        <button
          class="icon-btn"
          :title="$t('common.close')"
          :aria-label="$t('common.close')"
          @click="store.setError(null)"
        ><Icon name="close" /></button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel);
  border: 1px solid var(--danger-border);
  color: var(--danger-text);
  padding: var(--space-5) var(--space-7);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  gap: var(--space-6);
  max-width: 80vw;
  z-index: var(--z-toast);
  box-shadow: var(--shadow-toast);
  font-size: var(--fs-3);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur-fast);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
