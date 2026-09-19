<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import PasswordChangeForm from "./PasswordChangeForm.vue";
import ProfileForm from "./ProfileForm.vue";
import TopbarControls from "./TopbarControls.vue";
import Icon from "./Icon.vue";

/**
 * The signed-in account's own page: who it is, and how to change its password.
 *
 * Deliberately *not* the platform console, even for a superadmin — one page is you, the other
 * is everybody else, and they are reached from different controls. A page that did both would
 * have to be read carefully to tell which half you were in.
 *
 * The password form is the same component the forced screen uses, which is the honest
 * arrangement: the only difference between the two is that one can be left.
 */

const store = useAppStore();
const { t } = useI18n();
const router = useRouter();

const changed = ref(false);

/**
 * Which build is answering, and which schema it writes.
 *
 * Asked here rather than kept in the store. `/api/health` is the one call a client already makes
 * before it has a session — `syncInstallation` uses it to tell a stale origin from an expired
 * token — and the answer is about the *installation* rather than about the account, which is why
 * it belongs on this page and not in the state every view shares.
 *
 * Two facts rather than one, because they move independently: a build can be replaced with the
 * schema unchanged, and a database can be upgraded by a build that is not newer. Somebody
 * self-hosting needs both to know what they are running — and this is the page where "about my
 * setup" belongs, since the console is an administrator's and this one is everybody's.
 *
 * A failure is silent: the version is a courtesy, and an error about not being able to read it
 * would be a sentence about a request nobody made.
 */
const version = ref<string | null>(null);

onMounted(async () => {
  try {
    const health = await api.health();
    if (health.appVersion) {
      version.value = t("account.version", {
        version: health.appVersion,
        schema: health.schemaVersion ?? "?",
      });
    }
  } catch {
    // Nothing to say, and nothing to fix: the rest of the page works without it.
  }
});

function onChanged(): void {
  changed.value = true;
}
</script>

<template>
  <div class="workspace-home" data-testid="account-page">
    <header class="home-head">
      <button
        class="icon-btn"
        data-testid="account-back"
        :title="t('common.back')"
        :aria-label="t('common.back')"
        @click="router.push({ name: 'home' })"
      >
        <Icon name="arrow-left" />
      </button>
      <span class="home-brand">{{ t("account.title") }}</span>
      <TopbarControls />
      <button
        class="icon-btn"
        data-testid="account-sign-out"
        :title="t('common.signOut')"
        :aria-label="t('common.signOut')"
        @click="store.signOut()"
      >
        <Icon name="logout" />
      </button>
    </header>

    <div class="home-scroll">
      <div class="account-body">
        <section class="account-card">
          <h2 class="home-title">{{ t("account.identity") }}</h2>
          <dl class="account-facts">
            <dt>{{ t("login.username") }}</dt>
            <dd data-testid="account-username">{{ store.account?.username ?? "" }}</dd>
            <dt>{{ t("admin.roles") }}</dt>
            <dd class="account-roles">
              <span
                v-for="role in store.account?.roles ?? []"
                :key="role"
                class="badge"
                data-testid="account-role"
              >
                {{ t(`roles.${role}`) }}
              </span>
            </dd>
          </dl>
          <!-- The console is one control away for the accounts that have it, and the server is
               what decides — this hides a button, it does not grant anything. -->
          <button
            v-if="store.canAdmin"
            class="btn"
            data-testid="account-open-admin"
            @click="router.push({ name: 'admin' })"
          >
            <Icon name="shield" /> {{ t("admin.title") }}
          </button>
        </section>

        <!--
          Between the identity card and the password: it is the other half of "who is this", and it
          is a thing the account writes about itself rather than a credential it changes.
        -->
        <section class="account-card">
          <h2 class="home-title">{{ t("account.about.title") }}</h2>
          <ProfileForm />
        </section>

        <!--
          The line a self-hoster is asked for when they report something. Silent until `/api/health`
          answers, rather than showing a placeholder that would read as "unknown version".
        -->
        <p v-if="version" class="account-lead" data-testid="account-version">{{ version }}</p>

        <section class="account-card">
          <h2 class="home-title">{{ t("password.title") }}</h2>
          <p class="home-sub account-lead">{{ t("account.passwordLead") }}</p>

          <p v-if="changed" class="account-ok" data-testid="account-password-changed" role="status">
            <Icon name="check" />
            <span>{{ t("account.passwordChanged") }}</span>
          </p>

          <PasswordChangeForm @done="onChanged" />
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  max-width: 640px;
}

.account-card {
  padding: var(--space-7);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.account-lead {
  margin-bottom: var(--space-6);
}

.account-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-3) var(--space-6);
  margin: 0 0 var(--space-6);
  font-size: var(--fs-3);
}

.account-facts dt {
  color: var(--text-3);
}

.account-facts dd {
  margin: 0;
  color: var(--text);
}

.account-roles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.account-ok {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 0 var(--space-5);
  font-size: var(--fs-2);
  color: var(--text-2);
}
</style>
