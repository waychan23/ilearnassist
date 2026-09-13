<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import Icon from "../Icon.vue";
import GenerationParams from "../GenerationParams.vue";
import WidgetToggleList from "./WidgetToggleList.vue";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

/**
 * The conversation's own persona.
 *
 * Its own control rather than one more generation parameter, because it is a different kind of
 * thing: this is what the conversation *is*, and it is the affordance that replaced switching
 * Copilot mid-thread. Editing it leaves the Copilot it was copied from untouched.
 */
const prompt = ref("");
watch(
  () => store.activeSession?.systemPrompt ?? "",
  (v) => {
    prompt.value = v;
  },
  { immediate: true }
);

/** The seven generation parameters, which are the shared form's business now. */
const params = ref<InstanceType<typeof GenerationParams> | null>(null);

// `sessionSettings` already falls back to the staged draft settings, so this works both for a
// live session and for the welcome screen.
watch(
  () => store.sessionSettings,
  (s) => params.value?.load(s),
  { immediate: true, deep: true, flush: "post" }
);

function save() {
  void store.updateSettings(params.value?.commit() ?? {});
  if (store.activeSession) void store.updateSessionPrompt(prompt.value);
  emit("close");
}

function reset() {
  params.value?.load({});
  // Empty means the built-in assistant prompt, which is the same "inherit" the fields above
  // express — there is nothing above the conversation left to inherit a persona from.
  prompt.value = "";
}

const scopeNote = computed(() =>
  store.activeSession
    ? t("sessionSettings.scopeExisting")
    : t("sessionSettings.scopeNew")
);
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
          <h3>{{ t("sessionSettings.title") }}</h3>
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
          <div class="config-tip">
            {{ scopeNote }}{{ t("sessionSettings.scopeSuffix") }}
          </div>

          <!-- Only for a conversation that exists: there is nothing to hold a prompt before
               one does, and the Copilot picked at creation supplies it until then. -->
          <div v-if="store.activeSession" class="field">
            <label>{{ t("sessionSettings.systemPrompt") }}</label>
            <textarea
              v-model="prompt"
              class="textarea"
              data-testid="session-prompt"
              :placeholder="t('sessionSettings.systemPromptPlaceholder')"
            ></textarea>
            <div class="hint">{{ t("sessionSettings.systemPromptHint") }}</div>
          </div>

          <GenerationParams ref="params" />

          <!--
            The session's widgets, with a toggle per widget rather than the checkbox list the
            Copilot editor uses — and the difference is the whole reason the two controls exist.
            A conversation is a real object, so each switch takes effect immediately and says so;
            a Copilot is a template, where the same box is a note about a future conversation.
          -->
          <div class="field widget-checks">
            <label>{{ t("widgets.heading") }}</label>
            <WidgetToggleList
              v-if="store.activeSession"
              scope="session"
              :rows="store.sessionWidgets"
              testid-prefix="session-widget"
              @toggle="
                (id, enabled) =>
                  store.setWidgetEnabled('session', store.activeSession!.id, id, enabled)
              "
            />
            <div v-else class="hint">{{ t("widgets.noSession") }}</div>
            <div class="hint">{{ t("widgets.sessionLead") }}</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="reset">{{ t("sessionSettings.reset") }}</button>
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button class="btn primary" data-testid="session-settings-save" @click="save">
            {{ t("common.save") }}
          </button>
        </div>
      </div>
    </div>

  </Teleport>
</template>
