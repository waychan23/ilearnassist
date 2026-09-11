<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "./stores/app";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";
import WorkspaceHome from "./components/WorkspaceHome.vue";
import ConfirmDialog from "./components/dialogs/ConfirmDialog.vue";
import SettingsDialog from "./components/dialogs/SettingsDialog.vue";
import { closeDrawer, closeSettings, uiState } from "./composables/ui";
import { isCompact } from "./composables/breakpoints";
import { confirmState } from "./composables/confirm";
import Icon from "./components/Icon.vue";

const store = useAppStore();
const { t } = useI18n();

onMounted(() => {
  store.init().catch((e) => store.setError(e instanceof Error ? e.message : String(e)));
});

/* ---------------------------------- drawer ---------------------------------- */

/**
 * Escape closes the drawer — but only the drawer.
 *
 * `ConfirmDialog` listens on `window` for the same key, so with a confirm prompt raised over
 * an open drawer a single press would close both: the prompt vanishes and the thing that
 * asked for it slides away underneath. The same applies to Settings, which the sidebar's own
 * footer opens. Returning early while either is up leaves the topmost layer to handle it.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !uiState.drawerOpen) return;
  if (confirmState.open || uiState.settingsOpen) return;
  closeDrawer();
}

watch(
  () => uiState.drawerOpen,
  (open) => {
    if (open) window.addEventListener("keydown", onKeydown);
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
 * Together with the backdrop, the `inert` on the pane behind it and the Escape handler this
 * is the whole focus story — a hand-rolled trap would be a state machine doing what `inert`
 * already does.
 */
watch(
  () => uiState.drawerOpen,
  async (open) => {
    if (!isCompact.value) return;
    await nextTick();
    const selector = open ? "[data-testid='new-session']" : '[data-testid="nav-toggle"]';
    document.querySelector<HTMLElement>(selector)?.focus();
  }
);
</script>

<template>
  <!--
    Two views, and the flag that picks between them lives in `composables/ui.ts`. There is no
    router: a route table for one boolean would be a dependency and a URL nobody types.

    The overlays below sit outside the branch because both views reach them — Settings from
    the sidebar footer, from the composer's model picker *and* from the workspace home.
  -->
  <div class="app" :class="{ home: uiState.workspaceHome }">
    <WorkspaceHome v-if="uiState.workspaceHome" />

    <template v-else>
      <Sidebar :inert="!uiState.drawerOpen && isCompact" />

      <!--
        Only on a compact viewport, and only while the drawer is open. `inert` takes the pane
        behind the drawer out of the tab order and the accessibility tree, which is the same
        job a focus trap does with a fraction of the state. `ChatView` is single-root, so the
        attribute falls through to `<main>`.
      -->
      <ChatView :inert="uiState.drawerOpen && isCompact" />

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
    <!-- Reachable from the sidebar footer, the composer's model picker and the home page. -->
    <SettingsDialog v-if="uiState.settingsOpen" @close="closeSettings" />
    <Transition name="fade">
      <div v-if="store.error" class="toast">
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
