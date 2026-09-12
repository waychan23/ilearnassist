<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import Icon from "../Icon.vue";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

const title = ref("");
const copilotId = ref<string | null>(store.activeCopilotId);
const saving = ref(false);

/**
 * Public first, then the account's own: someone opening this dialog is usually picking from
 * what the instance offers, and their own drafts are the shorter list to scroll past. Empty
 * groups are dropped rather than shown as an empty heading.
 *
 * The group is carried as a flag rather than as a translation key, and the label is chosen in
 * the template — a key held in data is invisible to `i18n/catalog.test.ts`'s dead-key scan,
 * which would then have to be widened to cover it.
 */
const groups = computed(() =>
  [
    { key: "public", items: store.publicCopilots },
    { key: "mine", items: store.myCopilots },
  ].filter((g) => g.items.length > 0)
);

async function create() {
  if (saving.value) return;
  saving.value = true;
  try {
    const session = await store.createSession(copilotId.value);
    if (session && title.value.trim()) {
      await store.renameSession(session.id, title.value);
    }
    emit("close");
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
      <div class="modal sm">
        <div class="modal-head">
          <h3>{{ t("session.new.title") }}</h3>
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
            <label>{{ t("session.new.titleLabel") }}</label>
            <input
              v-model="title"
              class="input"
              data-testid="session-title-input"
              :placeholder="t('session.new.titlePlaceholder', { fallback: t('session.fallbackTitle') })"
            />
          </div>

          <div class="field">
            <label>Copilot</label>
            <div class="copilot-list">
              <label class="copilot-option" :class="{ active: copilotId === null }">
                <input v-model="copilotId" type="radio" :value="null" />
                <div>
                  <div class="name">{{ t("session.new.noCopilot") }}</div>
                  <div class="desc">{{ t("session.new.noCopilotDesc") }}</div>
                </div>
              </label>

              <template v-for="group in groups" :key="group.key">
                <div class="group-label">
                  {{ group.key === "public" ? t("session.new.groupPublic") : t("session.new.groupMine") }}
                </div>
                <label
                  v-for="c in group.items"
                  :key="c.id"
                  class="copilot-option"
                  data-testid="copilot-option"
                  :class="{ active: copilotId === c.id }"
                >
                  <input v-model="copilotId" type="radio" :value="c.id" />
                  <div>
                    <div class="name">
                      {{ c.name }}
                      <!-- Whose it is matters here: a published Copilot is someone else's
                           wording, and this is the moment it gets chosen. -->
                      <span v-if="c.ownerName && group.key === 'public'" class="by">
                        {{ t("session.new.byAuthor", { name: c.ownerName }) }}
                      </span>
                    </div>
                    <div v-if="c.description" class="desc">{{ c.description }}</div>
                    <div v-else-if="c.systemPrompt" class="desc preview">
                      {{ c.systemPrompt.slice(0, 80) }}{{ c.systemPrompt.length > 80 ? "…" : "" }}
                    </div>
                  </div>
                </label>
              </template>
            </div>
            <div v-if="store.copilots.length === 0" class="hint">
              {{ t("session.new.noCopilots") }}
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button class="btn primary" data-testid="create-session" :disabled="saving" @click="create">
            {{ t("common.create") }}
          </button>
        </div>
      </div>
    </div>

  </Teleport>
</template>

<style scoped>
.copilot-list {
  display: grid;
  gap: var(--space-4);
}
.copilot-list .group-label {
  font-size: var(--fs-2);
  color: var(--text-3);
  margin-top: var(--space-2);
}
.copilot-option .name .by {
  font-size: var(--fs-2);
  color: var(--text-3);
  font-weight: 400;
  margin-left: var(--space-2);
}
.copilot-option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-5) var(--space-6);
  cursor: pointer;
  background: var(--panel-2);
}
.copilot-option.active {
  border-color: var(--accent);
}
.copilot-option input {
  margin-top: 3px;
}
.copilot-option .name {
  font-size: var(--fs-3);
  font-weight: 500;
}
.copilot-option .desc {
  font-size: var(--fs-2);
  color: var(--text-3);
  margin-top: var(--space-1);
}
.copilot-option .desc.preview {
  font-style: italic;
}
</style>
