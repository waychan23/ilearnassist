<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import { showWorkspaceHome } from "../composables/ui";
import { api } from "../api/client";
import type { AdminUser, UserRole } from "../api/types";
import { SUPERADMIN_ROLE, USER_ROLES } from "../api/types";
import TopbarControls from "./TopbarControls.vue";
import CopyButton from "./CopyButton.vue";
import Icon from "./Icon.vue";

/**
 * The platform console: the accounts on this installation.
 *
 * A page of its own rather than a tab of Settings, and the two are about different things.
 * Settings configures *this installation* — providers, parsers, Copilots — and this manages
 * *people*. A superadmin is both an administrator and an ordinary user of the app, which is
 * exactly why one page doing both would read as either.
 *
 * **The server is the authority on all of it.** Every control here is hidden from an account
 * that lacks the role, and hiding is not a permission: the routes answer 403 for anybody else
 * regardless of what the page drew. This component is the shape of the feature, not its guard.
 *
 * Accounts are disabled, never deleted. The row owns workspaces, conversations and uploaded
 * files, so there is no version of deleting it that does not either destroy that or strand it —
 * and "remove this user" in practice means "stop them signing in", which is what the toggle
 * does, sessions and all.
 */

const store = useAppStore();
const { t } = useI18n();

const users = ref<AdminUser[]>([]);
const loading = ref(true);
/**
 * A load failure, shown in the page rather than in the toast.
 *
 * The toast is for something that happened to a request the user made. A list that could not
 * be fetched is the page being empty, and the retry belongs where the list would have been.
 */
const loadError = ref<string | null>(null);
const busyId = ref<string | null>(null);

/**
 * A password the server has just handed over, and will never show again.
 *
 * Only a hash is stored, so there is nothing to re-read — not for the user, not for the
 * administrator. That is why the reply is paired with a copy button instead of a "show
 * password" one, and why this banner says out loud that it is the last time it will be seen.
 */
interface Credential {
  username: string;
  password: string;
  /** True when this replaced an existing password, which reads differently from "created". */
  reset: boolean;
}
const credential = ref<Credential | null>(null);

const creating = ref(false);
const draftName = ref("");
const draftRoles = ref<UserRole[]>(["user"]);
const createError = ref<string | null>(null);
const createBusy = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);

const isSelf = (u: AdminUser): boolean => u.id === store.account?.id;

/**
 * Whether changing this row would take away the account's own authority.
 *
 * Mirrors what the server refuses, so the control is disabled rather than failing after the
 * click — the server still refuses it either way, and this is the version the user can see.
 *
 * The rule is "you cannot lose your own superadmin", and **not** "you cannot be the last one".
 * The difference is not academic: the caller is always an enabled superadmin, so there is
 * always another one besides the row being changed, and a `<= 1` count here leaves the button
 * enabled in exactly the cases the server refuses. Written that way round it was a control
 * that appeared to work and then 400'd.
 */
const lockedOut = (u: AdminUser): boolean => isSelf(u) && u.roles.includes(SUPERADMIN_ROLE);

/**
 * Whether one role checkbox is refused.
 *
 * Two rules, both the server's: an account cannot end up holding no roles at all, and a
 * superadmin cannot demote themselves — see `lockedOut`.
 */
const roleLocked = (u: AdminUser, role: UserRole): boolean =>
  busyId.value === u.id ||
  (u.roles.includes(role) &&
    (u.roles.length === 1 || (role === SUPERADMIN_ROLE && isSelf(u))));

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    users.value = (await api.listAccounts()).users;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// Loaded on mount rather than watched: this page is `v-if`'d in `App.vue`, so it exists only
// while it is being looked at and there is no closed state to load *on open* from.
void load();

/* ----------------------------------- create ---------------------------------- */

function openCreate(): void {
  draftName.value = "";
  draftRoles.value = ["user"];
  createError.value = null;
  creating.value = true;
  void Promise.resolve().then(() => nameInput.value?.focus());
}

async function submitCreate(): Promise<void> {
  const username = draftName.value.trim();
  if (!username || createBusy.value) return;

  createBusy.value = true;
  createError.value = null;
  try {
    const created = await api.createAccount({ username, roles: draftRoles.value });
    credential.value = { username: created.user.username, password: created.password, reset: false };
    creating.value = false;
    await load();
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
  }
}

/* ---------------------------------- editing ----------------------------------- */

function toggleDraftRole(role: UserRole): void {
  draftRoles.value = draftRoles.value.includes(role)
    ? draftRoles.value.filter((r) => r !== role)
    : [...draftRoles.value, role];
}

async function setRoles(user: AdminUser, role: UserRole): Promise<void> {
  const next = user.roles.includes(role)
    ? user.roles.filter((r) => r !== role)
    : [...user.roles, role];
  // An account with no roles can reach nothing and no screen would say why, so the last one is
  // not removable here — the server refuses an empty list for the same reason.
  if (next.length === 0) return;
  await act(user, () => api.updateAccount(user.id, { roles: next }));
}

async function setDisabled(user: AdminUser, disabled: boolean): Promise<void> {
  if (disabled) {
    const ok = await confirm({
      title: t("admin.disable.title"),
      message: t("admin.disable.message", { name: user.username }),
      detail: t("admin.disable.detail"),
      confirmText: t("admin.disable.confirm"),
      danger: true,
    });
    if (!ok) return;
  }
  await act(user, () => api.updateAccount(user.id, { disabled }));
}

async function resetPassword(user: AdminUser): Promise<void> {
  const self = isSelf(user);
  const ok = await confirm({
    title: t("admin.reset.title"),
    message: t("admin.reset.message", { name: user.username }),
    // The two cases really do differ, and the difference is the one thing a person would not
    // predict: resetting somebody else's forces them to choose their own, resetting your own
    // does not.
    detail: self ? t("admin.reset.detailSelf") : t("admin.reset.detailOther"),
    confirmText: t("admin.reset.confirm"),
  });
  if (!ok) return;

  busyId.value = user.id;
  try {
    const result = await api.resetAccountPassword(user.id);
    credential.value = {
      username: result.user.username,
      password: result.password,
      reset: true,
    };
    // `api` has already stored the replacement pair when the target was the caller, so this
    // session carries on; the account itself is unchanged, so the list is the only thing that
    // needs re-reading — and only for its "must change" marker.
    await load();
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  } finally {
    busyId.value = null;
  }
}

async function revokeSessions(user: AdminUser): Promise<void> {
  const ok = await confirm({
    title: t("admin.kick.title"),
    message: t("admin.kick.message", { name: user.username }),
    detail: t("admin.kick.detail"),
    confirmText: t("admin.kick.confirm"),
    danger: true,
  });
  if (!ok) return;
  await act(user, () => api.revokeAccountSessions(user.id));
}

/** Run one row action, with the row marked busy and any failure reported. */
async function act(user: AdminUser, run: () => Promise<unknown>): Promise<void> {
  busyId.value = user.id;
  try {
    await run();
    await load();
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="workspace-home" data-testid="admin-console">
    <header class="home-head">
      <button
        class="icon-btn"
        data-testid="admin-back"
        :title="t('common.back')"
        :aria-label="t('common.back')"
        @click="showWorkspaceHome()"
      >
        <Icon name="arrow-left" />
      </button>
      <!-- The page shell is `.workspace-home`/`.home-head` from `style.css`: a header that
           does not scroll over a body that does, which is the same shape this page needs. -->
      <span class="home-brand">{{ t("admin.title") }}</span>
      <TopbarControls />
      <button
        class="icon-btn"
        data-testid="admin-sign-out"
        :title="t('common.signOut')"
        :aria-label="t('common.signOut')"
        @click="store.signOut()"
      >
        <Icon name="logout" />
      </button>
    </header>

    <div class="home-scroll">
      <div class="home-intro admin-intro">
        <div>
          <h2 class="home-title">{{ t("admin.title") }}</h2>
          <p class="home-sub">{{ t("admin.subtitle") }}</p>
        </div>
        <button class="btn primary" data-testid="admin-new-user" @click="openCreate">
          <Icon name="plus" /> {{ t("admin.create") }}
        </button>
      </div>

      <!--
        The one-time password. It is shown here, above the list, rather than inside the dialog
        that produced it: the dialog closes and this has to survive it, because the copy button
        is the whole point and a password read off a closing panel is a password mistyped.
      -->
      <div v-if="credential" class="credential" data-testid="admin-credential">
        <div class="credential-body">
          <p class="credential-lead">
            {{ credential.reset ? t("admin.credential.reset") : t("admin.credential.created") }}
          </p>
          <p class="credential-line">
            <span class="credential-label">{{ t("admin.credential.username") }}</span>
            <code data-testid="admin-credential-username">{{ credential.username }}</code>
          </p>
          <p class="credential-line">
            <span class="credential-label">{{ t("admin.credential.password") }}</span>
            <code data-testid="admin-credential-password">{{ credential.password }}</code>
          </p>
          <p class="credential-note">
            <Icon name="warning" />
            <span>{{ t("admin.credential.note") }}</span>
          </p>
        </div>
        <div class="credential-actions">
          <CopyButton
            :value="`${t('admin.credential.username')}: ${credential.username}\n${t('admin.credential.password')}: ${credential.password}`"
            testid="admin-credential-copy"
          />
          <button class="btn small ghost" data-testid="admin-credential-dismiss" @click="credential = null">
            {{ t("common.close") }}
          </button>
        </div>
      </div>

      <p v-if="loadError" class="form-error" data-testid="admin-error" role="alert">
        <Icon name="warning" />
        <span>{{ loadError }}</span>
        <button class="btn small" @click="load">{{ t("common.retry") }}</button>
      </p>

      <p v-else-if="loading" class="home-sub">{{ t("common.loading") }}</p>

      <template v-else>
        <p class="home-sub admin-count" data-testid="admin-count">
          {{ t("admin.count", { count: users.length }, users.length) }}
        </p>

        <div
          v-for="u in users"
          :key="u.id"
          class="list-row user-row"
          data-testid="admin-user"
          :data-username="u.username"
        >
          <div class="user-main">
            <div class="user-name">
              <span class="user-username">{{ u.username }}</span>
              <span v-if="isSelf(u)" class="badge muted">{{ t("admin.you") }}</span>
              <span v-if="u.disabled" class="badge danger">{{ t("admin.disabled") }}</span>
              <span v-else-if="u.mustChangePassword" class="badge muted">
                {{ t("admin.mustChange") }}
              </span>
            </div>

            <!--
              A checkbox per role rather than a select, because the model is a set: an account
              may hold several, and a select would make the second one unreachable. Every click
              writes immediately — this edits an account that already exists, which is the
              toggle half of the "a checkbox installs what does not exist yet" rule.
            -->
            <div class="role-picker">
              <label v-for="role in USER_ROLES" :key="role" class="role-option">
                <input
                  type="checkbox"
                  :checked="u.roles.includes(role)"
                  :disabled="roleLocked(u, role)"
                  :data-testid="`admin-role-${role}`"
                  @change="setRoles(u, role)"
                />
                <span>{{ t(`roles.${role}`) }}</span>
              </label>
            </div>
          </div>

          <div class="user-actions">
            <button
              class="btn small"
              :data-testid="`admin-toggle-${u.username}`"
              :disabled="busyId === u.id || lockedOut(u)"
              :title="u.disabled === false && lockedOut(u) ? t('admin.selfLocked') : undefined"
              @click="setDisabled(u, !u.disabled)"
            >
              {{ u.disabled ? t("admin.enable") : t("admin.disable.action") }}
            </button>
            <button
              class="btn small"
              :data-testid="`admin-reset-${u.username}`"
              :disabled="busyId === u.id"
              @click="resetPassword(u)"
            >
              {{ t("admin.reset.action") }}
            </button>
            <button
              class="btn small"
              :data-testid="`admin-kick-${u.username}`"
              :disabled="busyId === u.id || isSelf(u)"
              :title="isSelf(u) ? t('admin.kick.self') : undefined"
              @click="revokeSessions(u)"
            >
              {{ t("admin.kick.action") }}
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- The create form, teleported like every other overlay so it is never trapped inside a
         transformed ancestor. -->
    <Teleport to="body">
      <div v-if="creating" class="modal-overlay" @click.self="creating = false">
        <div class="modal sm" data-testid="admin-create-dialog">
          <div class="modal-head">
            <h3>{{ t("admin.create") }}</h3>
            <button
              class="icon-btn"
              :title="t('common.close')"
              :aria-label="t('common.close')"
              @click="creating = false"
            >
              <Icon name="close" />
            </button>
          </div>
          <div class="modal-body">
            <div class="field">
              <label for="new-user-name">{{ t("login.username") }}</label>
              <input
                id="new-user-name"
                ref="nameInput"
                v-model="draftName"
                class="input"
                data-testid="admin-create-username"
                type="text"
                autocomplete="off"
                :maxlength="64"
              />
            </div>
            <div class="field">
              <label>{{ t("admin.roles") }}</label>
              <div class="role-picker">
                <label v-for="role in USER_ROLES" :key="role" class="role-option">
                  <input
                    type="checkbox"
                    :checked="draftRoles.includes(role)"
                    :data-testid="`admin-create-role-${role}`"
                    @change="toggleDraftRole(role)"
                  />
                  <span>{{ t(`roles.${role}`) }}</span>
                </label>
              </div>
              <!-- The generated password is stated before the account exists, so nobody is
                   surprised by a credential they did not choose. -->
              <p class="hint">{{ t("admin.createPasswordHint") }}</p>
            </div>
            <p v-if="createError" class="form-error" role="alert">
              <Icon name="warning" />
              <span>{{ createError }}</span>
            </p>
          </div>
          <div class="modal-foot">
            <button class="btn" @click="creating = false">{{ t("common.cancel") }}</button>
            <button
              class="btn primary"
              data-testid="admin-create-submit"
              :disabled="!draftName.trim() || draftRoles.length === 0 || createBusy"
              @click="submitCreate"
            >
              {{ t("common.create") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.admin-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-6);
  max-width: 1100px;
}

.admin-count {
  margin-bottom: var(--space-5);
}

.user-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  max-width: 1100px;
}

.user-main {
  min-width: 0;
}

.user-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.user-username {
  font-size: var(--fs-4);
  color: var(--text);
}

.role-picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
}

.role-option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--fs-3);
  color: var(--text-2);
  cursor: pointer;
}

.user-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  flex-shrink: 0;
}

.credential {
  max-width: 1100px;
  margin-bottom: var(--space-6);
  padding: var(--space-6);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.credential-lead {
  margin: 0 0 var(--space-5);
  font-size: var(--fs-3);
  color: var(--text);
}

.credential-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  margin: 0 0 var(--space-3);
  font-size: var(--fs-3);
}

.credential-label {
  color: var(--text-3);
  min-width: 80px;
}

.credential-line code {
  font-size: var(--fs-4);
  color: var(--text);
  user-select: all;
}

.credential-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin: var(--space-5) 0 0;
  font-size: var(--fs-2);
  color: var(--text-2);
}

.credential-actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-5);
}

.form-error {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 0 var(--space-5);
  font-size: var(--fs-2);
  color: var(--danger-text);
}
</style>
