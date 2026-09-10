import { reactive } from "vue";

/**
 * Cross-component UI state for the few globals that more than one place needs to open.
 *
 * Settings is reachable from the sidebar footer *and* from the composer's model picker
 * ("管理模型…"). Rather than threading an event up through App and back down, the dialog
 * is mounted once in `App.vue` and anyone can ask for it here.
 */
export const uiState = reactive({
  settingsOpen: false,
});

export function openSettings(): void {
  uiState.settingsOpen = true;
}

export function closeSettings(): void {
  uiState.settingsOpen = false;
}
