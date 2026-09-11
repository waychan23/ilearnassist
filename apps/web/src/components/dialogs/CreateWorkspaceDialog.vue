<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import Icon from "../Icon.vue";

const { t } = useI18n();
const store = useAppStore();
const emit = defineEmits<{ close: []; created: [] }>();

const name = ref("");
const saving = ref(false);

async function submit() {
  const n = name.value.trim();
  if (!n || saving.value) return;
  saving.value = true;
  try {
    await store.createWorkspace(n);
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