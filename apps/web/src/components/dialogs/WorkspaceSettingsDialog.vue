<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../api/client";
import type { WidgetId, WidgetState } from "../../api/types";
import { useAppStore } from "../../stores/app";
import { closeWorkspaceSettings, uiState } from "../../composables/ui";
import Icon from "../Icon.vue";
import WidgetToggleList from "./WidgetToggleList.vue";

/**
 * A workspace's own settings, which today means the widgets installed in it.
 *
 * A dialog of its own rather than a tab in the installation-wide Settings, and the distinction is
 * the one that keeps `SourcesDialog` separate too: Settings is how the *app* is configured, and
 * this is how one workspace is.
 *
 * ### Its own rows, not the store's
 *
 * The gear sits on a workspace **card**, which need not be the workspace anyone is in — so making
 * it the active one to borrow `store.workspaceWidgets` would tear down whatever conversation is
 * on screen, from a button that was only meant to configure something. This fetches the rows for
 * the id it was opened with and keeps them locally; the *write* still goes through the store, so
 * the lifecycle hook runs from the one place that owns it.
 */
const { t } = useI18n();
const store = useAppStore();

const rows = ref<WidgetState[]>([]);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  const id = uiState.workspaceSettingsId;
  if (!id) return;
  try {
    rows.value = await api.listWorkspaceWidgets(id);
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);

async function toggle(id: WidgetId, enabled: boolean): Promise<void> {
  const workspaceId = uiState.workspaceSettingsId;
  if (!workspaceId) return;
  try {
    // Through the store rather than the client, so the hook and the shared list stay in one
    // place; the reply is what this dialog's own list is patched from, for the same reason.
    const state = await store.setWidgetEnabled("workspace", workspaceId, id, enabled);
    const at = rows.value.findIndex((w) => w.id === state.id);
    if (at === -1) rows.value = [...rows.value, state];
    else rows.value[at] = state;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** Whether the widget installed here reaches the conversation on screen right now. */
function isActiveWorkspace(): boolean {
  return store.activeWorkspaceId === uiState.workspaceSettingsId;
}
</script>

<template>
  <!--
    Teleported to `body`, and this is load-bearing rather than tidiness. On a compact
    viewport the sidebar is `position: fixed` inside a `transform`, and a fixed-position
    element whose ancestor is transformed is positioned against *that ancestor* — so a
    `.modal-overlay` left in place here would be laid out inside the off-canvas drawer and
    render off-screen. The palette still applies: the theme lives on `<html>` and custom
    properties cascade from there.
  -->
  <Teleport to="body">
    <div class="modal-overlay" @click.self="closeWorkspaceSettings">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ t("widgets.workspaceSettings.title") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            data-testid="workspace-settings-close"
            @click="closeWorkspaceSettings"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div class="config-tip">{{ t("widgets.workspaceLead") }}</div>

          <div v-if="error" class="widget-error">
            <span>{{ error }}</span>
          </div>

          <WidgetToggleList
            v-if="uiState.workspaceSettingsId"
            scope="workspace"
            :rows="rows"
            testid-prefix="workspace-widget"
            @toggle="toggle"
          />

          <!--
            Installing here changes a panel the user may not be able to see. Said out loud only
            when it is true, rather than always: a sentence nobody needs is one they learn to skip.
          -->
          <div v-if="isActiveWorkspace()" class="hint">
            {{ t("widgets.workspaceSettings.liveHint") }}
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-testid="workspace-settings-done" @click="closeWorkspaceSettings">
            {{ t("common.close") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
