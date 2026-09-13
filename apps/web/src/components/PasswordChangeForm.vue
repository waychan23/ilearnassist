<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { PASSWORD_MIN_LENGTH } from "../api/types";
import Icon from "./Icon.vue";

/**
 * Choosing a new password, with the current one as proof.
 *
 * One component, two places, and the two are genuinely the same form: the forced screen after
 * a generated password, and the ordinary page an account can visit any time. They differ in
 * what surrounds them — a heading, and whether leaving is allowed — so that lives at the call
 * site rather than being threaded in here as a mode.
 *
 * The old password is required in both. It is the one thing standing between a stolen token
 * and a permanent account takeover, and the server enforces it too; asking here is what makes
 * the refusal something the user can act on rather than a failed request.
 */

const emit = defineEmits<{ done: [] }>();

const store = useAppStore();
const { t } = useI18n();

const current = ref("");
const next = ref("");
const confirm = ref("");
const submitting = ref(false);
const failure = ref<string | null>(null);

/** Only once something is in the second field — see the same note in `LoginView`. */
const mismatch = computed(() => confirm.value.length > 0 && confirm.value !== next.value);
const tooShort = computed(
  () => next.value.length > 0 && next.value.length < PASSWORD_MIN_LENGTH
);
/**
 * The new password being the current one.
 *
 * Refused by the server as well, and it is not a formality there: the change is what clears
 * the "must change" flag, so accepting the same value would clear the flag with the choice
 * still unmade. Checked here so the user hears it before the round trip.
 */
const unchanged = computed(() => next.value.length > 0 && next.value === current.value);

const canSubmit = computed(
  () =>
    !!current.value &&
    !!next.value &&
    !submitting.value &&
    !mismatch.value &&
    !tooShort.value &&
    !unchanged.value
);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  failure.value = null;
  try {
    await store.changePassword(current.value, next.value);
    current.value = "";
    next.value = "";
    confirm.value = "";
    emit("done");
  } catch (e) {
    failure.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="password-form" data-testid="password-form" @submit.prevent="submit">
    <div class="field">
      <label for="pw-current">{{ t("password.current") }}</label>
      <input
        id="pw-current"
        v-model="current"
        class="input"
        data-testid="password-current"
        type="password"
        name="current-password"
        autocomplete="current-password"
      />
    </div>

    <div class="field">
      <label for="pw-new">{{ t("password.new") }}</label>
      <input
        id="pw-new"
        v-model="next"
        class="input"
        data-testid="password-new"
        type="password"
        name="new-password"
        autocomplete="new-password"
      />
      <p class="hint">{{ t("password.hint", { min: PASSWORD_MIN_LENGTH }) }}</p>
    </div>

    <div class="field">
      <label for="pw-confirm">{{ t("password.confirm") }}</label>
      <input
        id="pw-confirm"
        v-model="confirm"
        class="input"
        data-testid="password-confirm"
        type="password"
        name="confirm-password"
        autocomplete="new-password"
      />
    </div>

    <p v-if="mismatch" class="form-error" data-testid="password-mismatch" role="alert">
      <Icon name="warning" />
      <span>{{ t("password.mismatch") }}</span>
    </p>
    <p v-else-if="tooShort" class="form-error" data-testid="password-too-short" role="alert">
      <Icon name="warning" />
      <span>{{ t("password.tooShort", { min: PASSWORD_MIN_LENGTH }) }}</span>
    </p>
    <p v-else-if="unchanged" class="form-error" data-testid="password-unchanged" role="alert">
      <Icon name="warning" />
      <span>{{ t("password.unchanged") }}</span>
    </p>
    <p v-if="failure" class="form-error" data-testid="password-error" role="alert">
      <Icon name="warning" />
      <span>{{ failure }}</span>
    </p>

    <button class="btn primary" data-testid="password-submit" type="submit" :disabled="!canSubmit">
      {{ t("password.submit") }}
    </button>
  </form>
</template>

<style scoped>
.form-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin: 0 0 var(--space-5);
  font-size: var(--fs-2);
  color: var(--danger-text);
}
</style>
