<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import { showWorkspaceHome, uiState, type AdminSection } from "../composables/ui";
import { api } from "../api/client";
import type { AdminUser, UserRole } from "../api/types";
import { ADMIN_ROLE, CONSOLE_GRANTABLE_ROLES, isPlatformAdmin, isSuperadmin } from "../api/types";
import TopbarControls from "./TopbarControls.vue";
import CopyButton from "./CopyButton.vue";
import Icon from "./Icon.vue";
import ProvidersSection from "./admin/ProvidersSection.vue";
import DocumentsSection from "./admin/DocumentsSection.vue";
import UploadsSection from "./admin/UploadsSection.vue";
import type { IconName } from "../utils/icons";

/**
 * The platform console: everything that belongs to the *installation* rather than to one
 * account.
 *
 * Laid out the way an administration back end usually is — a menu down the left, one section
 * on the right — because that is what it is: a small number of unrelated management screens
 * that share a shell. The alternative, tabs across a dialog, is what this replaced, and it does
 * not survive a second section: a tab strip is a strip of equals, and "accounts" and "model
 * providers" are not equal halves of one question.
 *
 * The menu is data (`SECTIONS`) rather than markup, so a new section is an entry plus a
 * component. One entry today; the shape is what makes the second one a row.
 *
 * **The server is the authority on all of it.** Every control here is hidden or disabled from
 * an account that may not use it, and hiding is not a permission: the routes answer 403 for
 * anybody else regardless of what the page drew. This component is the shape of the feature,
 * not its guard.
 *
 * Accounts are disabled, never deleted. The row owns workspaces, conversations and uploaded
 * files, so there is no version of deleting it that does not either destroy that or strand it —
 * and "remove this user" in practice means "stop them signing in", which is what the toggle
 * does, sessions and all.
 *
 * **Two tiers, and this page is where the difference shows.** Exactly one superadmin exists —
 * the account the desktop control panel bootstraps with the server stopped — and it cannot be
 * created, appointed, disabled or signed out from this console at all. It may change anybody
 * else, and it is the only role that may appoint an ordinary administrator. An ordinary
 * administrator runs the installation's accounts and may not touch an account that administers
 * it — see `manageRefusal` on the server, which this mirrors control for control.
 */

const store = useAppStore();
const { t } = useI18n();

/**
 * What the menu offers.
 *
 * `label` and `hint` are catalog *keys* held as literals in the template rather than in this
 * data, because `i18n/catalog.test.ts` statically scans the source for `t("…")` calls and a key
 * reached through an object property is invisible to it — a dead-key scan that cannot see a key
 * reports it as unused. The id stays data; the words stay at the call site.
 *
 * Every one of these is *installation-wide*, which is the whole test for whether a screen
 * belongs here: it changes something every account shares, or it is an account itself. Anything
 * one account does for itself — a Copilot, a workspace, a preference — belongs in the app, not
 * behind an administrator's login.
 */
interface Section {
  id: AdminSection;
  icon: IconName;
}

const SECTIONS: Section[] = [
  { id: "users", icon: "user" },
  { id: "providers", icon: "sliders" },
  { id: "documents", icon: "file" },
  { id: "uploads", icon: "upload" },
];

/**
 * Read from `uiState` rather than held here, because one entry point outside the console opens
 * it on a particular section — the composer's "manage models…" means providers, and landing on
 * the accounts list would answer a different question.
 */
const section = computed({
  get: () => uiState.adminSection,
  set: (next) => {
    uiState.adminSection = next;
  },
});

/**
 * The one line under the title, per section.
 *
 * A `switch` with a literal key per case rather than `t(\`admin.subtitle.${section}\`)`, for the
 * reason `widgets/registry.ts` resolves names the same way: the second spelling needs
 * `admin.subtitle.` in `catalog.test.ts`'s allowlist, and a prefix is exactly where a typo
 * hides. Written out, a new section is a missing return rather than a blank line.
 *
 * (The *menu* labels do use the dynamic form, because `admin.nav.` is already allowed over the
 * same closed union and the values are one word each.)
 */
const sectionSubtitle = computed(() => {
  switch (section.value) {
    case "users":
      return t("admin.subtitle.users");
    case "providers":
      return t("admin.subtitle.providers");
    case "documents":
      return t("admin.subtitle.documents");
    case "uploads":
      return t("admin.subtitle.uploads");
  }
});

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

/* --------------------------------- who am I --------------------------------- */

const me = computed(() => store.account);
/** The only role that may appoint, rename the tier of, or reach an administrator's row. */
const amSuperadmin = computed(() => !!me.value && isSuperadmin(me.value));

const isSelf = (u: AdminUser): boolean => u.id === me.value?.id;

/**
 * Whether this row is out of an ordinary administrator's reach.
 *
 * The mirror of the server's `manageRefusal`: an account holding a role that administers the
 * platform is a superadmin's to change and nobody else's. A superadmin sees every row live,
 * which is the same asymmetry the routes have.
 */
const rowLocked = (u: AdminUser): boolean => !amSuperadmin.value && isPlatformAdmin(u);

/**
 * Whether the account's own authority is what this row carries.
 *
 * Mirrors what the server refuses, so the control is disabled rather than failing after the
 * click — the server still refuses it either way, and this is the version the user can see.
 *
 * The rule is "you cannot lose your own administrator role", and **not** "you cannot be the last
 * one". The difference is not academic: the caller is always an enabled administrator, so there
 * is always another one besides the row being changed, and a `<= 1` count here leaves the button
 * enabled in exactly the cases the server refuses. Written that way round it was a control that
 * appeared to work and then 400'd.
 */
const lockedOut = (u: AdminUser): boolean => isSelf(u) && isPlatformAdmin(u);

/**
 * Whether one role checkbox is refused, and why.
 *
 * Three rules, all the server's: an account cannot end up holding no roles at all; an
 * administrator cannot demote themselves (see `lockedOut`); and only a superadmin may hand the
 * administrative roles to anybody — including to a brand-new account in the create dialog.
 */
// The boxes cover only `CONSOLE_GRANTABLE_ROLES` (admin, user): the superadmin role is shown
// as a static label on its row, never as an editable thing. Three rules remain, all the
// server's: the row is out of this administrator's reach, an ordinary administrator cannot
// hand out the admin tier, and an account's last role cannot be removed.
const roleLocked = (u: AdminUser, role: UserRole): boolean =>
  busyId.value === u.id ||
  rowLocked(u) ||
  (!amSuperadmin.value && role === ADMIN_ROLE) ||
  (u.roles.includes(role) && u.roles.length === 1);

/**
 * Whether the reset control is refused, and it is the one refusal that is about a *kind* of
 * account rather than about a caller.
 *
 * A superadmin's own password is reset in the desktop control panel and nowhere else: the web
 * console is reached with a credential the account already holds, so replacing the one
 * credential that can undo the installation from here would be a weaker second way in. The
 * server refuses it outright; this is that refusal, drawn.
 */
const resetLocked = (u: AdminUser): boolean => isSelf(u) && isSuperadmin(u);

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
  <div class="console" data-testid="admin-console">
    <!--
      The menu. A back control in its header rather than in the section's own toolbar, because
      leaving the console is about the console and not about the section you happen to be in —
      and because that is where a management back end puts it.
    -->
    <aside class="console-nav">
      <div class="console-nav-head">
        <button
          class="icon-btn"
          data-testid="admin-back"
          :title="t('common.back')"
          :aria-label="t('common.back')"
          @click="showWorkspaceHome()"
        >
          <Icon name="arrow-left" />
        </button>
        <span class="console-brand">{{ t("admin.title") }}</span>
      </div>

      <nav class="console-menu">
        <button
          v-for="item in SECTIONS"
          :key="item.id"
          class="console-menu-item"
          :class="{ active: section === item.id }"
          :aria-current="section === item.id ? 'page' : undefined"
          :data-testid="`admin-nav-${item.id}`"
          @click="section = item.id"
        >
          <Icon :name="item.icon" />
          <span>{{ t(`admin.nav.${item.id}`) }}</span>
        </button>
      </nav>

      <div class="console-nav-foot">
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
      </div>
    </aside>

    <main class="console-main">
      <!--
        One header for the shell, with the section's own action on the right. The accounts
        section is the only one with a primary action, so the button is conditional rather than
        the header being per-section: a title that has to be repeated three times is a title
        that drifts.
      -->
      <header class="console-head">
        <div>
          <h2 class="console-title">{{ t(`admin.nav.${section}`) }}</h2>
          <p class="console-sub">{{ sectionSubtitle }}</p>
        </div>
        <button
          v-if="section === 'users'"
          class="btn primary"
          data-testid="admin-new-user"
          @click="openCreate"
        >
          <Icon name="plus" /> {{ t("admin.create") }}
        </button>
      </header>

      <div v-if="section === 'providers'" class="console-body" data-testid="admin-providers">
        <ProvidersSection />
      </div>

      <div v-else-if="section === 'documents'" class="console-body" data-testid="admin-documents">
        <DocumentsSection />
      </div>

      <div v-else-if="section === 'uploads'" class="console-body" data-testid="admin-uploads-panel">
        <UploadsSection />
      </div>

      <div v-else class="console-body">
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

        <p v-else-if="loading" class="console-sub">{{ t("common.loading") }}</p>

        <template v-else>
          <p class="console-sub admin-count" data-testid="admin-count">
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

                The superadmin row is the exception: the role cannot be granted or taken away
                from a screen (the only superadmin is the one the control panel bootstrapped),
                so it is shown as a static label rather than as a box that lies about being
                tickable. The admin box is drawn for an ordinary administrator but cannot be
                ticked, because seeing which tier a row is in is how they learn why it is out of
                reach; hiding it would leave a disabled row with no stated reason.
              -->
              <div class="role-picker">
                <span
                  v-if="isSuperadmin(u)"
                  class="role-static"
                  data-testid="admin-role-superadmin"
                >{{ t("roles.superadmin") }}</span>
                <template v-else>
                  <label
                    v-for="role in CONSOLE_GRANTABLE_ROLES"
                    :key="role"
                    class="role-option"
                    :class="{ locked: roleLocked(u, role) }"
                  >
                    <input
                      type="checkbox"
                      :checked="u.roles.includes(role)"
                      :disabled="roleLocked(u, role)"
                      :data-testid="`admin-role-${role}`"
                      @change="setRoles(u, role)"
                    />
                    <span>{{ t(`roles.${role}`) }}</span>
                  </label>
                </template>
              </div>
            </div>

            <div class="user-actions">
              <button
                class="btn small"
                :data-testid="`admin-toggle-${u.username}`"
                :disabled="busyId === u.id || lockedOut(u) || rowLocked(u)"
                :title="
                  lockedOut(u) && !u.disabled
                    ? t('admin.selfLocked')
                    : rowLocked(u)
                      ? t('admin.rowLocked')
                      : undefined
                "
                @click="setDisabled(u, !u.disabled)"
              >
                {{ u.disabled ? t("admin.enable") : t("admin.disable.action") }}
              </button>
              <button
                class="btn small"
                :data-testid="`admin-reset-${u.username}`"
                :disabled="busyId === u.id || resetLocked(u) || rowLocked(u)"
                :title="
                  resetLocked(u)
                    ? t('admin.resetPanel')
                    : rowLocked(u)
                      ? t('admin.rowLocked')
                      : undefined
                "
                @click="resetPassword(u)"
              >
                {{ t("admin.reset.action") }}
              </button>
              <button
                class="btn small"
                :data-testid="`admin-kick-${u.username}`"
                :disabled="busyId === u.id || isSelf(u) || rowLocked(u)"
                :title="
                  isSelf(u) ? t('admin.kick.self') : rowLocked(u) ? t('admin.rowLocked') : undefined
                "
                @click="revokeSessions(u)"
              >
                {{ t("admin.kick.action") }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </main>

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
                <label
                  v-for="role in CONSOLE_GRANTABLE_ROLES"
                  :key="role"
                  class="role-option"
                  :class="{ locked: !amSuperadmin && role === ADMIN_ROLE }"
                >
                  <input
                    type="checkbox"
                    :checked="draftRoles.includes(role)"
                    :disabled="!amSuperadmin && role === ADMIN_ROLE"
                    :data-testid="`admin-create-role-${role}`"
                    @change="toggleDraftRole(role)"
                  />
                  <span>{{ t(`roles.${role}`) }}</span>
                </label>
              </div>
              <!-- Stated because its absence asks the question: the superadmin role is made in
                   the desktop control panel with the server stopped, never from here. -->
              <p class="hint">{{ t("admin.superadminFixed") }}</p>
              <!-- Stated because it is not obvious from the form: only the account that was
                   created first can appoint administrators. -->
              <p v-if="!amSuperadmin" class="hint">{{ t("admin.grantHint") }}</p>
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
/*
 * A two-column shell that fills the viewport: a menu that does not scroll beside a body that
 * does. The left column is a fixed width rather than a fraction — a menu whose items move
 * around with the window is one nobody can learn — and the body takes the rest and owns the
 * only scrollbar.
 */
.console {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}

.console-nav {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--sidebar);
  border-right: 1px solid var(--border);
}

.console-nav-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6) var(--space-5);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.console-brand {
  font-size: var(--fs-4);
  font-weight: 600;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-menu {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-5) var(--space-3);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* The state is carried by `aria-current` and by the class together: the sheet paints the
   class, and the attribute is what a screen reader announces, so the two are one fact. */
.console-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-4) var(--space-5);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-family: inherit;
  font-size: var(--fs-3);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur-fast),
    color var(--dur-fast);
}

.console-menu-item:hover {
  background: var(--panel);
  color: var(--text);
}

.console-menu-item.active {
  background: var(--accent-bg);
  color: var(--accent);
}

.console-nav-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-5);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.console-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.console-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-6);
  padding: var(--space-8) var(--space-8) var(--space-6);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.console-title {
  margin: 0 0 var(--space-3);
  font-size: var(--fs-7);
  font-weight: 600;
  color: var(--text);
}

.console-sub {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-3);
}

.console-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-8);
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

/* A locked box still states which role the account holds; it says so in the muted tone rather
   than by disappearing, and the cursor stops claiming it is clickable. */
.role-option.locked {
  cursor: not-allowed;
}

/* The superadmin tier is not editable from a screen at all, so it reads as a badge rather than
   as a disabled control — nobody can tick it, and a greyed-out checkbox would suggest
   otherwise. */
.role-static {
  font-size: var(--fs-3);
  color: var(--text-3);
}

.role-option.locked span {
  color: var(--text-3);
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

/*
 * The narrow screen collapses the menu to a strip across the top rather than hiding it: there
 * are a handful of sections and they are the page's only navigation, so a hidden menu would be
 * a page you cannot leave. The rules live at the end of this block for the reason the sheet's
 * responsive rules do — a media query does not raise specificity, so an override written above
 * the rule it means to override loses on source order alone.
 */
@media (max-width: 720px) {
  .console {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }

  .console-nav {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .console-menu {
    flex-direction: row;
    overflow-x: auto;
  }

  .console-menu-item {
    width: auto;
    flex-shrink: 0;
  }

  .console-nav-foot {
    border-top: none;
    padding-top: 0;
  }

  .console-head {
    padding: var(--space-6);
    flex-wrap: wrap;
  }

  .console-body {
    padding: var(--space-6);
  }

  .user-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
