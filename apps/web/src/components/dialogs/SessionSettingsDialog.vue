<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import type { FileLocation } from "../../api/types";
import Icon from "../Icon.vue";
import GenerationParams from "../GenerationParams.vue";
import WriteLocationField from "../WriteLocationField.vue";
import WidgetToggleList from "./WidgetToggleList.vue";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

/** A failed save, reported inside the dialog rather than as a toast — see `save()`. */
const error = ref<string | null>(null);

/**
 * The conversation's name and its description — what it is called and what it is about.
 *
 * Two fields rather than one, because they are two different claims and only the first has a
 * consequence: `store.renameSession` is what flips `titleSource` to `"user"`, which is what
 * stops the auto-titler renaming the conversation after a later turn. The description reaches
 * nothing but this form.
 *
 * Both ride the Save button rather than committing on blur, which is the one place this dialog
 * deliberately differs from `WorkspaceSettingsDialog`: that one has no Save, so its text fields
 * commit as they lose focus, and a field that saved differently from the button beside it would
 * be the inconsistency.
 */
const title = ref("");
const description = ref("");
watch(
  () => store.activeSession,
  (s) => {
    title.value = s?.title ?? "";
    description.value = s?.description ?? "";
  },
  { immediate: true }
);

/**
 * Write the name and the description, each only when it actually changed.
 *
 * A blank name is left alone rather than sent: the route refuses it with `TITLE_EMPTY`, and a
 * nameless conversation is not something this form should be able to produce.
 */
async function saveIdentity(): Promise<void> {
  const session = store.activeSession;
  if (!session) return;

  const next = title.value.trim();
  if (next && next !== session.title) {
    await store.renameSession(session.id, next);
    // Read back rather than assuming: the server **numbers** a duplicate rather than refusing
    // it, so what is stored may not be the string that was typed.
    title.value = store.activeSession?.title ?? next;
  }
  if (description.value !== session.description) {
    await store.updateSessionDescription(description.value);
  }
}

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

/**
 * Where this conversation's unqualified writes go, or `null` for "follow the workspace".
 *
 * Its own control rather than a ninth field in `GenerationParams`, because it is not a
 * generation parameter: that form is also the Copilot editor's, where a session-scoped
 * behaviour setting would be a sentence about an object that does not exist yet. It is saved
 * through `updateSettings` like the rest, since the server merges settings rather than
 * replacing them — which is what lets this field and `commit()` be written in one call.
 */
const writeLocation = ref<FileLocation | null>(null);
watch(
  () => store.sessionSettings.writeLocation ?? null,
  (v) => {
    writeLocation.value = v;
  },
  { immediate: true }
);

/** What this level inherits from, in words — the workspace's choice, or the built-in default. */
const inheritLabel = computed(() => {
  const fromWorkspace = store.activeWorkspace?.settings?.writeLocation;
  return fromWorkspace
    ? t("settings.writeLocation.inheritWorkspace")
    : t("settings.writeLocation.inheritBuiltIn");
});

// `sessionSettings` already falls back to the staged draft settings, so this works both for a
// live session and for the welcome screen.
watch(
  () => store.sessionSettings,
  (s) => params.value?.load(s),
  { immediate: true, deep: true, flush: "post" }
);

/**
 * Await every write before closing, and stay open when one fails.
 *
 * The dialog used to fire them and close immediately, which meant a failed save closed on top of
 * its own failure — the user saw the dialog disappear and the old values come back on the next
 * open, with nothing saying why. It now reports where the sibling dialog reports, at the top of
 * the body.
 *
 * The identity writes come last so that a failure in the parameters does not leave a rename
 * half-applied from this button's point of view.
 */
async function save(): Promise<void> {
  try {
    await store.updateSettings({
      ...(params.value?.commit() ?? {}),
      writeLocation: writeLocation.value,
    });
    if (store.activeSession) {
      await store.updateSessionPrompt(prompt.value);
      await saveIdentity();
    }
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function reset() {
  params.value?.load({});
  writeLocation.value = null;
  // Empty means the built-in assistant prompt, which is the same "inherit" the fields above
  // express — there is nothing above the conversation left to inherit a persona from.
  prompt.value = "";
  // The name goes back to the stored one rather than to blank: a nameless conversation is not
  // something `save` can produce, so a reset that offered one would be a state with no way out.
  title.value = store.activeSession?.title ?? "";
  description.value = store.activeSession?.description ?? "";
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
            data-testid="session-settings-close"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div class="config-tip">
            {{ scopeNote }}{{ t("sessionSettings.scopeSuffix") }}
          </div>

          <div v-if="error" class="widget-error" data-testid="session-settings-error">
            {{ error }}
          </div>

          <!--
            What the conversation is called and what it is about, above the parameters it runs
            with. Only for a conversation that exists — a name before one does is the create
            dialog's business, and the welcome screen has nothing to attach a description to.
          -->
          <div v-if="store.activeSession" class="field">
            <label>{{ t("sessionSettings.name") }}</label>
            <input
              v-model="title"
              class="input"
              data-testid="session-name"
              :placeholder="t('sessionSettings.namePlaceholder')"
            />
            <div class="hint">{{ t("chat.titleHint") }}</div>
          </div>

          <div v-if="store.activeSession" class="field">
            <label>{{ t("sessionSettings.description") }}</label>
            <textarea
              v-model="description"
              class="textarea"
              data-testid="session-description"
              :placeholder="t('sessionSettings.descriptionPlaceholder')"
            ></textarea>
            <div class="hint">{{ t("sessionSettings.descriptionHint") }}</div>
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
            The write location, between the generation parameters and the widgets: it is a
            setting of the conversation like those, and unlike the persona above it can be
            changed for a conversation that does not exist yet — the value is carried onto the
            session when one is created.
          -->
          <WriteLocationField
            v-model="writeLocation"
            :inherit-label="inheritLabel"
            testid="session-write-location"
          />

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
              @toggle-group="
                (groupId, enabled) =>
                  store.setWidgetGroupEnabled(
                    'session',
                    store.activeSession!.id,
                    groupId,
                    enabled
                  )
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
