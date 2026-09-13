<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import Icon from "./Icon.vue";

/**
 * The sign-in screen.
 *
 * One form, and there is deliberately no second one beside it: **this app cannot create an
 * account**, and in particular not the first one. The administrator is made by the control
 * panel, which spawns the server package's CLI as a one-shot child so it works with the server
 * stopped — and the server refuses to listen until one exists, so a page that could be reached
 * at all is a page whose installation already has an administrator.
 *
 * That is what keeps a stranger from claiming the installation: the old create-an-administrator
 * form was `public`, and on a LAN-shared server it was reachable by the whole network during
 * the one window in the product's life where there was no owner to refuse them.
 */

const store = useAppStore();
const { t } = useI18n();

const username = ref("");
const password = ref("");
const submitting = ref(false);
/** An error from *this* screen, kept here rather than in the store's toast. */
const failure = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);

const canSubmit = computed(
  () => !!username.value.trim() && !!password.value && !submitting.value
);

onMounted(() => input.value?.focus());

async function submit(): Promise<void> {
  if (!canSubmit.value) return;

  submitting.value = true;
  failure.value = null;
  try {
    await store.signIn(username.value, password.value);
  } catch (e) {
    // Reported here rather than as a toast: the user is looking at this form, and the answer
    // to "that password is wrong" belongs next to the field it is about.
    failure.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="auth">
    <form class="auth-card" data-testid="login-form" @submit.prevent="submit">
      <header class="auth-head">
        <h1 class="auth-wordmark">{{ t("app.title") }}</h1>
        <p class="auth-lead" data-testid="auth-lead">{{ t("login.lead") }}</p>
      </header>

      <div class="field">
        <label for="login-username">{{ t("login.username") }}</label>
        <input
          id="login-username"
          ref="input"
          v-model="username"
          class="input"
          data-testid="login-username"
          type="text"
          name="username"
          autocomplete="username"
          :maxlength="64"
          :placeholder="t('login.usernamePlaceholder')"
        />
      </div>

      <div class="field">
        <label for="login-password">{{ t("login.password") }}</label>
        <input
          id="login-password"
          v-model="password"
          class="input"
          data-testid="login-password"
          type="password"
          name="password"
          autocomplete="current-password"
          :placeholder="t('login.passwordPlaceholder')"
        />
      </div>

      <p v-if="failure" class="auth-error" data-testid="login-error" role="alert">
        <Icon name="warning" />
        <span>{{ failure }}</span>
      </p>

      <button
        class="btn primary auth-submit"
        data-testid="login-submit"
        type="submit"
        :disabled="!canSubmit"
      >
        {{ t("login.submit") }}
      </button>

      <p class="auth-note" data-testid="auth-note">
        <Icon name="user" />
        <span>{{ t("login.note") }}</span>
      </p>
    </form>
  </main>
</template>

<style scoped>
.auth {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-7);
  background: var(--bg);
}

.auth-card {
  width: 100%;
  max-width: var(--modal-sm);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-8);
}

.auth-head {
  margin-bottom: var(--space-7);
}

.auth-wordmark {
  margin: 0;
  font-size: var(--fs-7);
  line-height: var(--lh-tight);
  color: var(--text);
}

.auth-lead {
  margin: var(--space-3) 0 0;
  font-size: var(--fs-3);
  color: var(--text-2);
}

.auth-submit {
  width: 100%;
  margin-top: var(--space-4);
}

.auth-error,
.auth-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin: var(--space-5) 0 0;
  font-size: var(--fs-2);
  line-height: var(--lh-base);
}

.auth-error {
  color: var(--danger-text);
}

.auth-note {
  color: var(--text-3);
}
</style>
