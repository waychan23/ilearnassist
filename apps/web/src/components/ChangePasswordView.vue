<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useAppStore } from "../stores/app";
import PasswordChangeForm from "./PasswordChangeForm.vue";
import Icon from "./Icon.vue";

/**
 * The screen an account is held on until it has chosen a password.
 *
 * Reached when `mustChangePassword` is set, which is what an administrator's create or reset
 * leaves behind: the password the account was handed was read off a screen and sent through a
 * chat window, and it is a way in rather than one to keep.
 *
 * **There is no way past this screen, and that is the design rather than a gap.** The server
 * refuses every route except the three that make the state escapable, so a "skip" control
 * would lead to a page where nothing loads. The one exit offered is signing out, because an
 * account that cannot remember what it was given has to be able to get back to the sign-in
 * form — anything else is a locked door with no handle on either side.
 *
 * Not a dialog: a dialog can be dismissed, escaped or navigated out from under, and a state
 * the server enforces should not be dismissible by the thing it is enforced against.
 */

const store = useAppStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

/**
 * Where the account goes now that it may.
 *
 * Back to whatever the guard refused it from, which is the whole of why `/login` and this
 * screen carry a `redirect`: a session that expires mid-conversation — or a first-run password
 * that has to be replaced before anything loads — would otherwise always end on the workspace
 * list, having lost the address the reader arrived with. The front door is the fallback, and
 * the guard has already cleared `mustChangePassword` by the time this runs, so it will let it
 * through.
 */
function onChanged(): void {
  const to = route.query.redirect;
  void router.replace(typeof to === "string" && to ? to : { name: "home" });
}
</script>

<template>
  <main class="auth">
    <div class="auth-card" data-testid="change-password">
      <header class="auth-head">
        <h1 class="auth-wordmark">{{ t("password.title") }}</h1>
        <p class="auth-lead">{{ t("password.lead", { name: store.account?.username ?? "" }) }}</p>
      </header>

      <PasswordChangeForm @done="onChanged" />

      <button class="link-btn" data-testid="change-password-sign-out" @click="store.signOut()">
        <Icon name="logout" />
        <span>{{ t("password.signOut") }}</span>
      </button>
    </div>
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
  font-size: var(--fs-6);
  line-height: var(--lh-tight);
  color: var(--text);
}

.auth-lead {
  margin: var(--space-3) 0 0;
  font-size: var(--fs-3);
  color: var(--text-2);
}

.link-btn {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-7) auto 0;
  background: none;
  border: none;
  padding: 0;
  color: var(--text-3);
  font-family: inherit;
  font-size: var(--fs-2);
  cursor: pointer;
}

.link-btn:hover {
  color: var(--text);
}
</style>
