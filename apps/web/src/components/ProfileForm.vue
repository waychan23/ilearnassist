<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { PROFILE_ABOUT_MAX } from "../api/types";
import Icon from "./Icon.vue";

/**
 * The account's own introduction, in its own words.
 *
 * Optional, and the card it lives in says so — an account that never fills this in loses nothing.
 * What it buys when it is filled in is that the agent is told once, rather than being reintroduced
 * in every new conversation: the text is sent as system-prompt context on every turn, so an
 * explanation can be pitched at the right level from the first message. See `chat.system.about`
 * in the server's prompt catalog.
 *
 * A real form with a save button rather than saving on blur, which is the cheaper interaction and
 * the wrong one here: this is one field of prose that somebody will rewrite in several passes, and
 * a request per keystroke-pause is a token cost paid on every turn in the meantime.
 */

const store = useAppStore();
const { t } = useI18n();

const about = ref(store.account?.about ?? "");
const saving = ref(false);
const saved = ref(false);
const failure = ref<string | null>(null);

/**
 * The draft follows the account when it changes underneath — a save's own answer, most often, and
 * that is the point: the route trims, so adopting the stored value is what keeps the field from
 * showing whitespace the record does not hold.
 */
watch(
  () => store.account?.about,
  (next) => {
    about.value = next ?? "";
  }
);

const dirty = computed(() => about.value !== (store.account?.about ?? ""));
const canSave = computed(() => dirty.value && !saving.value);

async function submit(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  saved.value = false;
  failure.value = null;
  try {
    await store.saveProfile(about.value);
    saved.value = true;
  } catch (e) {
    // Already a sentence: `utils/apiError.ts` is the one place a server code becomes wording.
    failure.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form data-testid="profile-form" @submit.prevent="submit">
    <p class="home-sub account-lead">{{ t("account.about.lead") }}</p>

    <div class="field">
      <label for="profile-about">{{ t("account.about.label") }}</label>
      <textarea
        id="profile-about"
        v-model="about"
        class="input profile-about"
        data-testid="profile-about"
        rows="6"
        :maxlength="PROFILE_ABOUT_MAX"
        :placeholder="t('account.about.placeholder')"
        @input="saved = false"
      />
      <p class="hint" data-testid="profile-count">
        {{ t("account.about.count", { used: about.length, max: PROFILE_ABOUT_MAX }) }}
      </p>
    </div>

    <p v-if="failure" class="form-error" data-testid="profile-error" role="alert">
      <Icon name="warning" />
      <span>{{ failure }}</span>
    </p>
    <p v-else-if="saved" class="account-ok" data-testid="profile-saved" role="status">
      <Icon name="check" />
      <span>{{ t("account.about.saved") }}</span>
    </p>

    <button
      type="submit"
      class="btn primary"
      data-testid="profile-save"
      :disabled="!canSave"
      :title="dirty ? t('account.about.save') : t('account.about.noChanges')"
    >
      {{ saving ? t("common.saving") : t("common.save") }}
    </button>
  </form>
</template>

<style scoped>
/* The one field on this page that is prose rather than a credential, so it gets room and the
 * monospace-free face the rest of the app's text areas use. Vertical resize only: a wider box
 * would break the card's own column. */
.profile-about {
  resize: vertical;
  min-height: 96px;
  font-family: inherit;
  line-height: 1.5;
}
</style>
