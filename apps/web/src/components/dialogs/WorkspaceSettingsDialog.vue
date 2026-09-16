<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../api/client";
import type { FileLocation, WidgetId, WidgetState, WorkspaceSettings } from "../../api/types";
import { useAppStore } from "../../stores/app";
import { closeWorkspaceSettings, uiState } from "../../composables/ui";
import Icon from "../Icon.vue";
import WriteLocationField from "../WriteLocationField.vue";
import WidgetToggleList from "./WidgetToggleList.vue";

/**
 * A workspace's own settings: what its conversations inherit, and the widgets installed in it.
 *
 * A dialog of its own rather than a tab in the installation-wide Settings, and the distinction is
 * the one that keeps the source browser separate too: Settings is how the *app* is configured, and
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

/**
 * The workspace's own settings, fetched rather than read from the store.
 *
 * Same reason the widget rows are: the gear sits on a card, which need not be the workspace
 * anyone is in. `undefined` means "not loaded yet" — a distinct state from `null`, which is
 * "this workspace has no opinion", so the control does not render a choice nobody made.
 */
const settings = ref<WorkspaceSettings | undefined>(undefined);

/**
 * The workspace's name and description, fetched with the settings above and for the same reason.
 *
 * Committed as each loses focus rather than behind a Save button, because this dialog has no
 * Save button: its write location applies on change and its widgets apply on click, so a text
 * field that waited for a button would be the only control here that did. The session-parameters
 * dialog does the opposite and is right to — it *does* have a Save — which is the whole of why
 * the two differ.
 */
const name = ref("");
const description = ref("");

/**
 * The newest commit's sequence number — see `commitIdentity` for what goes wrong without it.
 *
 * The codebase's usual shape for "two of these can be in flight at once" (`filePreviewSeq` in
 * the store, `loadRows`/`loadScope` in the source browser). It is not defensive here; the two
 * writes overlap on an ordinary path.
 */
let identitySeq = 0;

async function commitIdentity(): Promise<void> {
  const id = uiState.workspaceSettingsId;
  if (!id) return;
  const stored = store.workspaces.find((w) => w.id === id);
  const nextName = name.value.trim();
  const patch: { name?: string; description?: string } = {};
  // A blank name is put back rather than sent: the route refuses it with `NAME_REQUIRED`, and a
  // workspace with no name is not a state this dialog should be able to leave behind.
  if (nextName && nextName !== stored?.name) patch.name = nextName;
  if (description.value !== stored?.description) patch.description = description.value;
  if (!("name" in patch) && !("description" in patch)) {
    name.value = stored?.name ?? name.value;
    return;
  }

  /*
   * Two fields, one write each, and they overlap by construction: pressing Enter commits the
   * name, and clicking into the description blurs the name field and commits it *again*. Each
   * reply replaces the store's whole row, so without this the older reply can land last and put
   * the values it knew about back — a description that reads as saved and is not.
   *
   * Only the newest reply is applied. That is the right one to keep rather than merely the last
   * to arrive: it was computed from the newest state of the two fields, and the server has by
   * then applied every write before it.
   */
  // What the fields held when this write went out, so the reply can be told apart from an edit
  // made while it was in flight — see the write-back below.
  const sentName = patch.name ?? null;
  const sentDescription = "description" in patch ? description.value : null;

  const seq = ++identitySeq;
  try {
    const updated = await api.updateWorkspace(id, patch);
    if (seq !== identitySeq) return;
    const at = store.workspaces.findIndex((w) => w.id === id);
    if (at !== -1) store.workspaces[at] = updated;
    /*
     * Written back only where the field still holds what was sent.
     *
     * The reply describes the row as the server saw it at the moment of *this* write, and
     * `commitIdentity` is called on every blur — so a name committed on one blur and a
     * description typed before the reply arrives is exactly the ordinary path. Assigning
     * `updated.description` unconditionally is what wipes the typed text: the reply was
     * computed before it existed. The same mistake as seeding these fields from a late
     * fetch, one layer down, and it is why both are guarded rather than assigned.
     */
    if (sentName !== null && name.value.trim() === sentName) name.value = updated.name;
    if (sentDescription !== null && description.value === sentDescription) {
      description.value = updated.description;
    }
    error.value = null;
  } catch (e) {
    if (seq !== identitySeq) return;
    // Put the editor back on the stored values, on the same narrowing: leaving a rejected name
    // on screen reads as one that was saved, but only the field that was actually sent is this
    // dialog's to put back.
    if (sentName !== null && name.value.trim() === sentName) name.value = stored?.name ?? "";
    if (sentDescription !== null && description.value === sentDescription) {
      description.value = stored?.description ?? "";
    }
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function load(): Promise<void> {
  const id = uiState.workspaceSettingsId;
  if (!id) return;
  try {
    rows.value = await api.listWorkspaceWidgets(id);
    settings.value = (await api.listWorkspaces()).find((w) => w.id === id)?.settings ?? {};
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Seed the two text fields **synchronously**, before `load()`'s first round trip.
 *
 * From `store.workspaces` rather than from the fetch `load()` makes, and the ordering is the
 * point rather than a shortcut: a field written when an off-screen reply lands overwrites
 * whatever was typed in the meantime, so a dialog whose edit box refills itself with the old
 * name is exactly what fetching these would produce. The store's rows are the same ones that
 * fetch returns — they are what the card behind this dialog renders — so the fetch has nothing
 * to add and a race to lose.
 */
onMounted(() => {
  const found = store.workspaces.find((w) => w.id === uiState.workspaceSettingsId);
  name.value = found?.name ?? "";
  description.value = found?.description ?? "";
});

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

/**
 * Save the write location.
 *
 * Immediately, on change, rather than behind a Save button — the rule this dialog already
 * follows for widgets, and it is the one that fits: these are toggles on a real object, so each
 * click takes effect. A form with a Save would make the widget toggles above it inconsistent
 * with the select below.
 */
async function setWriteLocation(value: FileLocation | null): Promise<void> {
  const id = uiState.workspaceSettingsId;
  if (!id) return;
  try {
    const updated = await api.updateWorkspaceSettings(id, { writeLocation: value });
    settings.value = updated.settings ?? {};
    // The store's copy is what a conversation created from a card reads, so it has to agree.
    const at = store.workspaces.findIndex((w) => w.id === id);
    if (at !== -1) store.workspaces[at] = { ...store.workspaces[at]!, settings: updated.settings };
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function toggleGroup(groupId: string, enabled: boolean): Promise<void> {
  const workspaceId = uiState.workspaceSettingsId;
  if (!workspaceId) return;
  try {
    await store.setWidgetGroupEnabled("workspace", workspaceId, groupId, enabled);
    // Several writes landed; refetch rather than stitching every reply into the local list.
    rows.value = await api.listWorkspaceWidgets(workspaceId);
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

          <!--
            What the workspace is called and what it is about, above the settings it hands down.
            The name is the same one the card on the home page renames inline — two doors to one
            value, which is right here: the card is the shortcut for someone looking at the list,
            and this is where someone who opened the settings expects to find it.
          -->
          <div class="field">
            <label>{{ t("widgets.workspaceSettings.name") }}</label>
            <input
              v-model="name"
              class="input"
              data-testid="workspace-name"
              :placeholder="t('widgets.workspaceSettings.namePlaceholder')"
              @keydown.enter.prevent="commitIdentity"
              @blur="commitIdentity"
            />
          </div>

          <div class="field">
            <label>{{ t("widgets.workspaceSettings.description") }}</label>
            <textarea
              v-model="description"
              class="textarea"
              data-testid="workspace-description"
              :placeholder="t('widgets.workspaceSettings.descriptionPlaceholder')"
              @blur="commitIdentity"
            ></textarea>
            <div class="hint">{{ t("widgets.workspaceSettings.descriptionHint") }}</div>
          </div>

          <!--
            The workspace's own default, above the widgets: it is what a conversation created
            here inherits, so it belongs with the settings a conversation is *made* with rather
            than with the panels it installs.
          -->
          <WriteLocationField
            v-if="settings !== undefined"
            class="workspace-default"
            :model-value="settings.writeLocation ?? null"
            :inherit-label="t('settings.writeLocation.inheritBuiltIn')"
            testid="workspace-write-location"
            @update:model-value="setWriteLocation"
          />


          <WidgetToggleList
            v-if="uiState.workspaceSettingsId"
            scope="workspace"
            :rows="rows"
            testid-prefix="workspace-widget"
            @toggle="toggle"
            @toggle-group="toggleGroup"
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

<style scoped>
/*
 * The write location sits above the widget list, separated from it — they answer different
 * questions, and a select pressed against a list of toggles reads as one more toggle.
 */
.workspace-default {
  display: block;
  margin-bottom: var(--space-6);
}
</style>
