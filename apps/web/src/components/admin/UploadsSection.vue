<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { MAX_UPLOAD_CEILING_BYTES, MIN_UPLOAD_LIMIT_BYTES } from "../../api/types";
import { useAppStore } from "../../stores/app";

/**
 * The installation's upload limit — how large a file any account may send.
 *
 * A section of its own rather than a field on the providers screen, because the question it
 * answers is not about models: it changes what every account may *put into* the app, and the
 * console's test for what belongs here is whether it is something every account shares.
 *
 * The form is one number in megabytes, and the unit is the reason it needs a component at all:
 * the setting is stored and enforced in **bytes**, because that is what a `Content-Length` and a
 * `bodyLimit` are, while every number a person says out loud about a file is MB. The conversion
 * lives here, at the one boundary where a human types one.
 *
 * It follows `ProvidersSection`'s shape: read from `store.config` rather than fetching, save
 * through a store method, and report a failure with `store.setError` — the store is already the
 * one holder of the installation-wide config, so a local copy would be a second place to
 * disagree.
 */

const { t } = useI18n();
const store = useAppStore();

/** The value in force, in MB — the unit an administrator thinks in. */
const mb = computed(() => Math.round((store.config?.maxUploadBytes ?? 0) / 1024 / 1024));

const draft = ref<number>(mb.value);
const saving = ref(false);
const saved = ref(false);

/** The bounds, in MB, as the form says them. Derived from the shared bytes so there is one rule. */
const minMb = Math.ceil(MIN_UPLOAD_LIMIT_BYTES / 1024 / 1024);
const maxMb = Math.floor(MAX_UPLOAD_CEILING_BYTES / 1024 / 1024);

/**
 * Follow the stored value when it changes underneath.
 *
 * `immediate` for the first load, and a `watch` rather than an initialiser for the rest: the
 * config arrives from `/api/config` a moment after this mounts, and a draft seeded once would
 * show an empty box for an installation whose limit is set.
 */
watch(mb, (next) => {
  draft.value = next;
  saved.value = false;
}, { immediate: true });

const valid = computed(
  () => Number.isInteger(draft.value) && draft.value >= minMb && draft.value <= maxMb
);

const dirty = computed(() => valid.value && draft.value !== mb.value);

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  saved.value = false;
  try {
    await store.setUploadSettings(draft.value * 1024 * 1024);
    saved.value = true;
  } catch (e) {
    // The dialog-free convention `ProvidersSection` uses: the failure goes to the toast, and the
    // form stays as the user left it so the number is not lost.
    store.setError(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="panel" data-testid="admin-uploads">
    <div class="field">
      <label class="field-label" for="max-upload-mb">{{ t("admin.uploads.maxSize") }}</label>
      <!--
        A number input, not a text one: the bounds are what the server enforces, and letting a
        person type "60MB" here would mean either refusing it or guessing what they meant.
      -->
      <input
        id="max-upload-mb"
        v-model.number="draft"
        class="input"
        data-testid="admin-upload-mb"
        type="number"
        :min="minMb"
        :max="maxMb"
        step="1"
        @keydown.enter.prevent="save"
      />
      <p class="field-hint">
        {{ t("admin.uploads.range", { min: minMb, max: maxMb }) }}
      </p>
    </div>

    <div class="actions">
      <button
        class="btn primary"
        data-testid="admin-upload-save"
        :disabled="!dirty || saving"
        @click="save"
      >
        {{ saving ? t("admin.uploads.saving") : t("common.save") }}
      </button>
      <span v-if="saved" class="saved" data-testid="admin-upload-saved">
        {{ t("admin.uploads.saved") }}
      </span>
    </div>

    <!-- Said once, under the form, because it is the half of the rule a number cannot state: what
         happens to a file that is over the limit, and that it is refused before it is sent. -->
    <p class="note">{{ t("admin.uploads.note") }}</p>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  max-width: 480px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.field-label {
  color: var(--text-2);
  font-size: var(--fs-3);
}
.field-hint,
.note {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-2);
  line-height: 1.5;
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.saved {
  color: var(--accent);
  font-size: var(--fs-3);
}
</style>
