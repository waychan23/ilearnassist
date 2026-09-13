<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { DEFAULT_WIDGET_IDS, widgetsForScope, type WidgetId } from "../../api/types";
import { useAppStore } from "../../stores/app";
import { widgetLabel } from "../../widgets/registry";
import Icon from "../Icon.vue";

const { t } = useI18n();
const store = useAppStore();
const emit = defineEmits<{ close: []; created: [] }>();

const name = ref("");
const saving = ref(false);

/**
 * The workspace's widgets, as checkboxes, seeded from the platform default.
 *
 * Checkboxes rather than the toggles the settings dialogs use, and the reason is that nothing
 * exists to toggle: the workspace does not exist until this form is submitted, so every box here
 * is a choice made in advance and the whole set lands in one write. That is the same distinction
 * as the Copilot editor's — and why the *editing* dialog, where each click takes effect
 * immediately, is a list of switches instead.
 */
const widgets = ref<WidgetId[]>([...DEFAULT_WIDGET_IDS]);
const available = widgetsForScope("workspace");

function toggleWidget(id: WidgetId) {
  const i = widgets.value.indexOf(id);
  if (i === -1) widgets.value.push(id);
  else widgets.value.splice(i, 1);
}

async function submit() {
  const n = name.value.trim();
  if (!n || saving.value) return;
  saving.value = true;
  try {
    await store.createWorkspace(n, [...widgets.value]);
    emit("created");
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
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
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ t("workspace.new.title") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>{{ t("common.name") }}</label>
            <input
              v-model="name"
              class="input"
              data-testid="workspace-name-input"
              :placeholder="t('workspace.new.namePlaceholder')"
              @keydown.enter="submit"
            />
            <div class="hint">{{ t("workspace.new.hint") }}</div>
          </div>

          <!--
            Visible rather than behind a disclosure, unlike the new-session dialog's advanced
            section: for a fresh installation this is the only place the choice is offered, so
            tucking it away would be how the feature goes unnoticed.
          -->
          <div class="field widget-checks">
            <label>{{ t("widgets.heading") }}</label>
            <div class="form-grid tool-checks">
              <label
                v-for="w in available"
                :key="w.id"
                class="check-row"
                :data-testid="`workspace-widget-check-${w.id}`"
              >
                <input
                  type="checkbox"
                  :checked="widgets.includes(w.id)"
                  @change="toggleWidget(w.id)"
                />
                {{ widgetLabel(w.id, t) }}
              </label>
            </div>
            <div class="hint">{{ t("widgets.workspaceLead") }}</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button
            class="btn primary"
            data-testid="workspace-create-submit"
            :disabled="!name.trim() || saving"
            @click="submit"
          >
            {{ t("common.create") }}
          </button>
        </div>
      </div>
    </div>

  </Teleport>
</template>