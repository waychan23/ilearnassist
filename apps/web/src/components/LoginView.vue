<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { api } from "../api/client";
import Icon from "./Icon.vue";

/**
 * Who are you?
 *
 * One field, because there is one credential: a username, and no password at all. The screen
 * says that out loud rather than leaving a user to wonder what they were meant to type — and
 * it matters, because "sign in as any name" reads as a security claim if it is not stated.
 *
 * The names that already exist are offered as chips. Without them this is a text field with
 * nothing behind it, which reads as a password prompt whose field is missing; with them it
 * reads as what it is, a profile picker on a single-user installation.
 */

const store = useAppStore();
const { t } = useI18n();

const username = ref("");
const usernames = ref<string[]>([]);
const submitting = ref(false);
/** An error from *this* screen, kept here rather than in the store's toast. */
const failure = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  input.value?.focus();
  try {
    // A convenience, so a failure is swallowed: not being able to list the names must not
    // stop anybody from typing one.
    usernames.value = (await api.listUsers()).usernames;
  } catch {
    usernames.value = [];
  }
});

function choose(name: string): void {
  username.value = name;
  input.value?.focus();
}

async function submit(): Promise<void> {
  const name = username.value.trim();
  if (!name || submitting.value) return;

  submitting.value = true;
  failure.value = null;
  try {
    await store.signIn(name);
  } catch (e) {
    // Reported here rather than as a toast: the user is looking at this form, and the answer
    // to "that name is too long" belongs next to the field that has it.
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
        <p class="auth-lead">{{ t("login.lead") }}</p>
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

      <!--
        Only when there are names to offer. An empty row labelled "existing" is worse than no
        row at all, and on a fresh installation there is genuinely nothing to pick.
      -->
      <div v-if="usernames.length" class="auth-chips" data-testid="login-users">
        <span class="auth-chips-label">{{ t("login.existing") }}</span>
        <button
          v-for="name in usernames"
          :key="name"
          type="button"
          class="auth-chip"
          @click="choose(name)"
        >
          {{ name }}
        </button>
      </div>

      <p v-if="failure" class="auth-error" data-testid="login-error" role="alert">
        <Icon name="warning" />
        <span>{{ failure }}</span>
      </p>

      <button
        class="btn primary auth-submit"
        data-testid="login-submit"
        type="submit"
        :disabled="!username.trim() || submitting"
      >
        {{ t("login.submit") }}
      </button>

      <!--
        Stated on the screen, not buried in the docs. Someone who believes this is a password
        prompt will assume a privacy it does not have, and that belief is the thing that hurts
        them — this installation is reachable from the network whenever LAN sharing is on.
      -->
      <p class="auth-note">
        <Icon name="warning" />
        <span>{{ t("login.noPassword") }}</span>
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

.auth-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-6);
}

.auth-chips-label {
  font-size: var(--fs-2);
  color: var(--text-3);
}

.auth-chip {
  padding: var(--space-2) var(--space-5);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-2);
  font-family: inherit;
  font-size: var(--fs-2);
  cursor: pointer;
}

.auth-chip:hover {
  color: var(--text);
  border-color: var(--accent);
}

.auth-submit {
  width: 100%;
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
