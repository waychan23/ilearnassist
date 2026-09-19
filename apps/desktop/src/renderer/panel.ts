import type { PanelState, ServerState } from "../shared/panelApi.js";
import {
  PANEL_MESSAGES,
  describeFault,
  isPanelLocaleChoice,
  resolvePanelLocale,
  translate,
  type PanelLocale,
  type PanelLocaleChoice,
  type PanelMessages,
} from "../shared/messages.js";
import { qrModules, qrRuns } from "../shared/qr.js";

/**
 * The control panel page.
 *
 * Deliberately tiny and dependency-free apart from the QR encoder. It renders one state
 * object and forwards nine commands; all the judgement about what a state *means* lives in
 * `ServerProcess`, and all the wording lives in `shared/messages.ts`. So this file has no
 * conditionals about the server process and no user-facing strings — just bindings.
 *
 * **The language is the main process's to decide, not this page's.** `navigator.language` is
 * the pre-answer — the same detection rule, used only for the few milliseconds before the first
 * state arrives — and every state broadcast carries the resolved `locale`, which comes from the
 * stored choice and `app.getLocale()`. That is what keeps the page and the menu bar above it
 * from ever showing two languages: only one process can read the preference, so only that one
 * answers.
 */

/** Placeholder until the first state arrives; see the note above. */
let locale: PanelLocale = resolvePanelLocale(navigator.language);
let messages: PanelMessages = PANEL_MESSAGES[locale];

const t = (key: keyof PanelMessages, values?: Record<string, string | number>): string =>
  translate(messages, key, values);

/** Explicit rather than `status.${state}`, so a new state fails to compile instead of rendering blank. */
const STATE_KEYS: Record<ServerState, keyof PanelMessages> = {
  stopped: "status.stopped",
  starting: "status.starting",
  running: "status.running",
  stopping: "status.stopping",
  failed: "status.failed",
};

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * Four modules of margin, which is the spec's minimum and not decoration: a decoder needs
 * to find the code's edges against its surroundings, and a code drawn flush to the white
 * card's padding is found by luck rather than by the algorithm.
 */
const QUIET_ZONE = 4;

const element = <T extends HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`The control panel is missing ${selector}`);
  return found;
};

const panel = element<HTMLElement>(".panel");
const statusCard = element<HTMLElement>(".status");
const stateLabel = element<HTMLElement>('[data-role="state"]');
const detail = element<HTMLElement>('[data-role="detail"]');
const urlRow = element<HTMLElement>('[data-role="url-row"]');
const urlCode = element<HTMLElement>('[data-role="url"]');
const dataDirCode = element<HTMLElement>('[data-role="data-dir"]');
const dataDirHint = element<HTMLElement>('[data-role="data-dir-hint"]');
const defaultDataDirAnswer = element<HTMLElement>('[data-role="default-data-dir"]');
const lanUrlCode = element<HTMLElement>('[data-role="lan-url"]');
const logsLabel = element<HTMLElement>('[data-role="logs-label"]');
const logOutput = element<HTMLPreElement>('[data-role="logs"]');
const logsToggle = element<HTMLButtonElement>('[data-action="logs"]');
const migratedSection = element<HTMLElement>('[data-role="migrated"]');
const migratedNote = element<HTMLElement>('[data-role="migrated-note"]');
const migratedBackup = element<HTMLElement>('[data-role="migrated-backup"]');
const versionCode = element<HTMLElement>('[data-role="version"]');
const updateAvailable = element<HTMLElement>('[data-role="update-available"]');

const qrOverlay = element<HTMLElement>('[data-role="qr-overlay"]');
const qrContainer = element<HTMLElement>('[data-role="qr"]');
const qrMessage = element<HTMLElement>('[data-role="qr-message"]');
const qrAddress = element<HTMLElement>('[data-role="qr-address"]');
const qrUrlCode = element<HTMLElement>('[data-role="qr-url"]');

const action = (name: string): HTMLButtonElement =>
  element<HTMLButtonElement>(`[data-action="${name}"]`);

/* ---- the administrator's password ---------------------------------------- */

const resetOverlay = element<HTMLElement>('[data-role="reset-overlay"]');
const resetPasswordInput = element<HTMLInputElement>('[data-role="reset-password"]');
const resetConfirmInput = element<HTMLInputElement>('[data-role="reset-confirm"]');
const resetError = element<HTMLElement>('[data-role="reset-error"]');
const resetOk = element<HTMLElement>('[data-role="reset-ok"]');

/* ---- the first administrator -------------------------------------------- */

const adminCard = element<HTMLElement>('[data-role="admin"]');
const adminOverlay = element<HTMLElement>('[data-role="admin-overlay"]');
const adminUsername = element<HTMLInputElement>('[data-role="admin-username"]');
const adminPassword = element<HTMLInputElement>('[data-role="admin-password"]');
const adminConfirm = element<HTMLInputElement>('[data-role="admin-confirm"]');
const adminError = element<HTMLElement>('[data-role="admin-error"]');
const adminOk = element<HTMLElement>('[data-role="admin-ok"]');

const localeSelect = element<HTMLSelectElement>('[data-role="locale"]');

const buttons = {
  open: action("open"),
  start: action("start"),
  stop: action("stop"),
  browser: action("browser"),
  copy: action("copy"),
  reveal: action("reveal"),
  chooseDataDir: action("choose-data-dir"),
  useDefaultDataDir: action("use-default-data-dir"),
  share: action("share"),
  unshare: action("unshare"),
  qrCopy: action("qr-copy"),
  resetAdmin: action("reset-admin"),
  resetSubmit: action("reset-submit"),
  adminCreate: action("admin-create"),
  adminSubmit: action("admin-submit"),
  checkUpdates: action("check-updates"),
  update: action("update"),
};

/** macOS draws its traffic lights inside the window because of `titleBarStyle: hiddenInset`. */
if (navigator.platform.startsWith("Mac")) document.body.classList.add("is-mac");

/**
 * Every label that does not depend on the state, written from the catalog.
 *
 * A function rather than a block that runs once at module scope, because the panel is now
 * bilingual at runtime: a change of language has to reach these, and they are the majority of
 * the page's words. The *dynamic* labels — the status word, the log disclosure, a copy button
 * mid-acknowledgement — are set in `render`, which runs on the same broadcast.
 *
 * `data-i18n` on the element names its own key, which is what keeps this list from having to be
 * maintained alongside the markup for the labels that have no other reason to be in this file.
 */
function applyStaticLabels(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n as keyof PanelMessages);
  }
  buttons.open.textContent = t("action.open");
  buttons.start.textContent = t("action.start");
  buttons.stop.textContent = t("action.stop");
  buttons.browser.textContent = t("action.openInBrowser");
  buttons.copy.textContent = t("action.copyUrl");
  buttons.qrCopy.textContent = t("action.copyUrl");
  buttons.reveal.textContent = t("action.reveal");
  buttons.chooseDataDir.textContent = t("action.chooseDataDir");
  buttons.useDefaultDataDir.textContent = t("action.useDefaultDataDir");
  buttons.share.textContent = t("action.share");
  buttons.unshare.textContent = t("action.unshare");
  buttons.resetAdmin.textContent = t("action.resetAdmin");
  buttons.resetSubmit.textContent = t("reset.submit");
  buttons.adminCreate.textContent = t("action.createAdmin");
  buttons.adminSubmit.textContent = t("create.submit");
  buttons.checkUpdates.textContent = t("action.checkUpdates");
  buttons.update.textContent = t("update.download");
  localeSelect.title = t("label.language");
  localeSelect.setAttribute("aria-label", t("label.language"));
  document.title = t("window.title");
  document.documentElement.lang = locale;
}

/**
 * The three options, one per choice, labelled once.
 *
 * Built here rather than written into `index.html` because two of the three are autonyms and do
 * not change with the language — while the third does, and a markup literal is invisible to the
 * catalog. `""` is the value for "follow the system": a `<select>` whose option values are all
 * non-empty strings has no other way to express it.
 */
function buildLocaleOptions(): void {
  localeSelect.replaceChildren(
    ...( [
      ["", t("language.system")],
      ["zh-CN", t("language.zh-CN")],
      ["en", t("language.en")],
    ] as const
    ).map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    })
  );
}

buildLocaleOptions();
applyStaticLabels();

let state: PanelState | null = null;
let logsOpen = false;
/**
 * Whether the reset sheet is open, and whether a reset is in flight.
 *
 * Component-local rather than part of `PanelState`, like the create sheet: the state object is
 * the *server's*, broadcast on every change, and a transient form is not a server fact. The
 * password fields' values never leave this renderer except in the one IPC call that submits
 * them.
 */
let resetOpen = false;
let resetting = false;
let logCount = 0;
/** The address the sheet is currently drawing, so a log line cannot repaint ~150 rects. */
let paintedUrl: string | null = null;

/**
 * Adopt the language the main process resolved.
 *
 * Returns early when it has not changed, which is the common case — the state is pushed on every
 * server log line, and rewriting every label in the panel several times a second for a language
 * that has not moved would be work nobody can see. `render` still runs its own dynamic
 * assignments afterwards, so the early return costs nothing.
 */
function applyLocale(next: PanelLocale): void {
  if (next === locale) return;
  locale = next;
  messages = PANEL_MESSAGES[locale];
  // The option labels are rebuilt as well as the rest: "follow the system" is a translated
  // phrase, and the two autonyms beside it are deliberately not.
  buildLocaleOptions();
  applyStaticLabels();
}

// ---- rendering -------------------------------------------------------------

/**
 * The disclosure's label, which is the one piece of text two things want to own: it names
 * the pane, counts its lines, and flips to "hide" when it is open. Kept in one place so
 * `render` refreshing the count cannot fight `setLogsOpen` over the wording.
 */
function refreshLogsHeader(): void {
  if (logsOpen) {
    logsLabel.textContent = t("action.hideLogs");
    return;
  }
  logsLabel.textContent = logCount > 0 ? `${t("label.logs")} (${logCount})` : t("label.logs");
}

function render(next: PanelState): void {
  state = next;
  // Before anything is written: every label below comes from the catalog this picks.
  applyLocale(next.locale);
  // And the control shows the *choice*, which is `""` while the panel is following the system —
  // binding it to the rendered language instead would turn "follow the system" into an explicit
  // choice the first time a state arrived.
  localeSelect.value = next.localeChoice;

  const { server, sharedOnLan, lanUrl, needsDataDir, defaultDataDir, needsAdmin } = next;
  const running = server.state === "running";
  const busy = server.state === "starting" || server.state === "stopping";

  panel.dataset.state = server.state;
  statusCard.dataset.state = server.state;
  stateLabel.textContent = t(STATE_KEYS[server.state]);

  // The fault, not the state, is what a user needs when a start fails; the state word alone
  // ("Failed to start") says nothing they can act on.
  if (server.state === "failed" && server.fault) {
    detail.textContent = describeFault(messages, server.fault);
    detail.hidden = false;
  } else {
    detail.hidden = true;
  }

  urlCode.textContent = server.url ?? "";
  urlRow.hidden = !running || !server.url;
  dataDirCode.textContent = server.dataDir;
  // An empty path box reads as a bug. Until one is chosen, the row shows the reason instead
  // — and there is nothing to reveal, so that action goes inert with it.
  dataDirCode.hidden = needsDataDir;
  // The sentence names the folder it is about to offer, so it comes off the state rather than
  // the catalog alone: "one will be created" is only honest with the path in it.
  dataDirHint.textContent = needsDataDir ? t("hint.chooseDataDir", { dir: defaultDataDir }) : "";
  dataDirHint.hidden = !needsDataDir;
  // The one-click answer, in the same state and only that state: once a folder is chosen the
  // question is answered, and the control that changes it is the head's "Choose folder…".
  defaultDataDirAnswer.hidden = !needsDataDir;

  // Start is also refused while an administrator is missing: the server exits on it, so a
  // button that produced "failed: exited 1" would be the exact failure the card prevents.
  // The card's own create control needs a folder to write into, and is inert until one is
  // chosen.
  const waitingForAdmin = needsAdmin === true;
  adminCard.hidden = !waitingForAdmin;

  /*
   * The reset is **not** gated on the server running, and that is the fix for a button that
   * was unusable in the state it exists for. It is a one-shot child now — the same bundle the
   * server comes from — so it works with the server up, stopped, or refusing to start; the last
   * of those is exactly when somebody reaches for it.
   *
   * What it does need is a data root to write into, and something to write: while the create
   * card is up there is provably no administrator yet, and a press could only come back with
   * "there is nothing here to recover" under a card that already said so.
   */
  buttons.resetAdmin.disabled = needsDataDir || waitingForAdmin || resetting;
  buttons.resetAdmin.textContent = resetting ? t("reset.working") : t("action.resetAdmin");
  // The sheet's submit says "working" while its request is in flight.
  buttons.resetSubmit.textContent = resetting ? t("reset.working") : t("reset.submit");

  buttons.open.disabled = !running;
  buttons.browser.disabled = !running;
  buttons.copy.disabled = !running;
  buttons.adminCreate.disabled = needsDataDir || creating;
  /*
   * Start is live in the needs-admin state on purpose: it is now the door that walks the reader
   * through creating the first administrator (see `startFlow`). It used to be inert there, with
   * the card's own button as the only way in — which left the panel's primary action dead in
   * precisely the state a new install is in.
   */
  buttons.start.disabled = busy || running;
  buttons.stop.disabled = !(busy || running);
  buttons.reveal.disabled = needsDataDir;
  buttons.chooseDataDir.disabled = busy;
  buttons.useDefaultDataDir.disabled = busy;
  buttons.open.title = running ? "" : t("hint.notRunning");

  // The switch, and the address it produces. `lanUrl` is null unless sharing is on, so the
  // address appearing and the switch reading "on" cannot get out of step.
  buttons.unshare.hidden = !sharedOnLan;
  lanUrlCode.textContent = lanUrl ?? "";
  lanUrlCode.hidden = !lanUrl;

  logCount = server.logs.length;
  refreshLogsHeader();
  logOutput.textContent = logCount > 0 ? server.logs.join("\n") : t("label.logsEmpty");

  // Keep the newest line in view, but only while the user is already at the bottom —
  // otherwise a scrollback they are reading would jump under them.
  if (logsOpen) {
    const atBottom = logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 24;
    if (atBottom) logOutput.scrollTop = logOutput.scrollHeight;
  }

  renderQrSheet();
  renderResetAdmin();
  renderCreateAdmin();
  renderVersion(next);
  renderMigrated(server);
}

/**
 * The version, and whether a newer release exists.
 *
 * Three states in one row, and the *checking* one is why this is a function: a manual check takes
 * a second or two, and a control that looks live and does nothing is the failure the panel's own
 * docblock names. While it runs the row says so; afterwards it shows the version again, whether or
 * not anything was found.
 */
function renderVersion(next: PanelState): void {
  const { update } = next;
  versionCode.textContent = update.checking
    ? t("update.checking")
    : t("update.version", { version: next.appVersion });

  // The manual item is disabled while one is running, so a double-press cannot start two.
  buttons.checkUpdates.disabled = update.checking;

  /*
   * Only when there is something to say. An up-to-date app shows its version and nothing else —
   * "you are up to date" on every launch is a sentence people learn to stop reading, and the
   * version row is already the confirmation that a manual check finished.
   */
  updateAvailable.textContent = update.available
    ? t("update.available", { version: update.latestVersion ?? "" })
    : "";
  updateAvailable.hidden = !update.available;
  buttons.update.hidden = !update.available;
}

/**
 * The line about a migration this boot performed.
 *
 * Drawn from the *server's* status rather than from anything stored, so it describes the launch
 * that is on screen: a restart that migrates nothing clears it, which is right — the note is about
 * what just happened to this database, not a permanent record. The backup path is shown when one
 * was taken, because that is the file somebody would need if the upgrade turns out to be wrong.
 */
function renderMigrated(server: PanelState["server"]): void {
  const migrated = server.migrated;
  migratedSection.hidden = migrated === null;
  if (!migrated) return;

  migratedNote.textContent = t("migrated.note", { from: migrated.from, to: migrated.to });
  migratedBackup.textContent = migrated.backup ? t("migrated.backup", { path: migrated.backup }) : "";
  migratedBackup.hidden = !migrated.backup;
}

/* ---- creating the first administrator ------------------------------------ */

/**
 * Whether the create sheet is open, and whether a child is running.
 *
 * Like the reset result, this is component-local rather than part of `PanelState`: it is a
 * transient interaction, not a fact about the server, and the state object is pushed on every
 * server log line. The password fields' values never leave this renderer except in the one
 * IPC call that submits them.
 */
let createOpen = false;
let creating = false;

/**
 * Whether the administrator was created — which is how `startFlow` learns it may carry on.
 *
 * The sheet answers on the *submission*, not on the dismissal, because the two callers want
 * different things from the same form. The card's button ignores the answer and leaves the sheet
 * open on its success line, as it always has: the reader asked to create an account, and the
 * acknowledgement is theirs to close. `startFlow` waits on the answer, closes the sheet itself,
 * and goes on to start the server.
 */
let created: ((ok: boolean) => void) | null = null;

function openCreateAdmin(): Promise<boolean> {
  if (!state || state.needsDataDir) return Promise.resolve(false);
  createOpen = true;
  adminError.hidden = true;
  adminOk.hidden = true;
  adminOverlay.hidden = false;
  adminUsername.value = "";
  adminPassword.value = "";
  adminConfirm.value = "";
  adminUsername.focus();
  return new Promise((resolve) => {
    // A second open while one is pending cannot happen — the sheet is modal — but resolving the
    // abandoned one is what keeps a `Promise` from being left dangling if it ever does.
    created?.(false);
    created = resolve;
  });
}

function settleCreate(ok: boolean): void {
  const resolve = created;
  created = null;
  resolve?.(ok);
}

function closeCreateAdmin(): void {
  createOpen = false;
  adminOverlay.hidden = true;
  // A dismissal before anything was submitted is a "no"; one after a success is just tidying up,
  // and `settleCreate` has already answered by then.
  settleCreate(false);
}

/**
 * Submit the form. The mismatch check is a courtesy done in the renderer — like the web
 * sign-in form's — and the CLI's own length policy is what is actually enforced, so the
 * error from either is rendered with the same catalog and the same element.
 */
async function submitCreateAdmin(): Promise<void> {
  if (creating) return;
  const username = adminUsername.value.trim();
  const password = adminPassword.value;
  adminError.hidden = true;
  adminOk.hidden = true;

  if (!username || !password) {
    showCreateError(password ? t("cli.fault.USERNAME_REQUIRED") : t("cli.fault.PASSWORD_REQUIRED"));
    return;
  }
  if (password !== adminConfirm.value) {
    showCreateError(t("create.mismatch"));
    return;
  }

  creating = true;
  buttons.adminSubmit.textContent = t("create.working");
  try {
    const result = await window.panel.createAdministrator({ username, password });
    if (result.ok) {
      // The main process re-checks and broadcasts `needsAdmin: false`, so the card follows on its
      // own. Here the sheet reports success — and answers whoever opened it, which is how the
      // Start flow learns it may carry on.
      adminOk.textContent = t("create.done", { name: result.username });
      adminOk.hidden = false;
      adminUsername.disabled = true;
      adminPassword.disabled = true;
      adminConfirm.disabled = true;
      buttons.adminSubmit.hidden = true;
      buttons.adminCreate.disabled = true;
      creating = false;
      settleCreate(true);
      return;
    }
    showCreateError(describeAdminFault(messages, result.fault));
  } catch (error) {
    showCreateError(error instanceof Error ? error.message : String(error));
  } finally {
    creating = false;
    buttons.adminSubmit.textContent = t("create.submit");
  buttons.checkUpdates.textContent = t("action.checkUpdates");
  buttons.update.textContent = t("update.download");
  }
}

function showCreateError(message: string): void {
  adminError.textContent = message;
  adminError.hidden = false;
}

/**
 * A fault sentence: the CLI code if the catalog has it, else the sentence the child sent.
 *
 * One function for both commands that spawn the CLI — creating the first administrator and
 * resetting a forgotten password — because it is one conversation with one child, and a code
 * means the same thing on either form.
 */
function describeAdminFault(
  catalog: PanelMessages,
  fault: { code: string; message?: string; params?: Record<string, string | number> }
): string {
  const key = `cli.fault.${fault.code}` as keyof PanelMessages;
  // An unknown code renders the child's own sentence: `translate` falls back to the key, but
  // a raw code in the UI is less useful than the message the CLI already wrote.
  if (key in catalog) return translate(catalog, key, fault.params);
  return fault.message ?? fault.code;
}

function renderCreateAdmin(): void {
  // The create button's disabled state is set in `render`; this only keeps the sheet honest
  // if a state broadcast arrives while it is open (e.g. the folder changed).
  if (createOpen && state?.needsDataDir) closeCreateAdmin();
}

/* ---- resetting the administrator password ------------------------------- */

function openResetAdmin(): void {
  if (!state || state.needsDataDir) return;
  resetOpen = true;
  resetError.hidden = true;
  resetOk.hidden = true;
  resetOverlay.hidden = false;
  resetPasswordInput.value = "";
  resetConfirmInput.value = "";
  resetPasswordInput.disabled = false;
  resetConfirmInput.disabled = false;
  buttons.resetSubmit.hidden = false;
  resetPasswordInput.focus();
}

function closeResetAdmin(): void {
  resetOpen = false;
  resetOverlay.hidden = true;
}

function showResetError(message: string): void {
  resetOk.hidden = true;
  resetError.textContent = message;
  resetError.hidden = false;
}

/**
 * Submit the chosen password.
 *
 * The mismatch and empty-field checks are renderer courtesies, exactly as on the create form;
 * the CLI's own length policy is what is actually enforced, and its coded refusal is rendered
 * through the same catalog as a create refusal. Nothing chosen is echoed back: the success
 * message names the account and that is all the IPC reply carries.
 */
async function submitResetAdmin(): Promise<void> {
  if (resetting) return;
  const password = resetPasswordInput.value;
  resetError.hidden = true;
  resetOk.hidden = true;

  if (!password) {
    showResetError(t("cli.fault.PASSWORD_REQUIRED"));
    return;
  }
  if (password !== resetConfirmInput.value) {
    showResetError(t("create.mismatch"));
    return;
  }

  resetting = true;
  buttons.resetSubmit.textContent = t("reset.working");
  try {
    const result = await window.panel.resetAdminPassword({ password });
    if (result.ok) {
      resetOk.textContent = t("reset.done", { name: result.username });
      resetOk.hidden = false;
      resetPasswordInput.disabled = true;
      resetConfirmInput.disabled = true;
      buttons.resetSubmit.hidden = true;
      return;
    }
    showResetError(describeAdminFault(messages, result.fault));
  } catch (error) {
    showResetError(error instanceof Error ? error.message : String(error));
  } finally {
    resetting = false;
    buttons.resetSubmit.textContent = t("reset.submit");
  }
}

/** Close the sheet if a state broadcast while it is open takes away its data folder. */
function renderResetAdmin(): void {
  if (resetOpen && state?.needsDataDir) closeResetAdmin();
}

function setLogsOpen(open: boolean): void {
  logsOpen = open;
  logsToggle.setAttribute("aria-expanded", String(open));
  refreshLogsHeader();
  logOutput.hidden = !open;
  if (open) logOutput.scrollTop = logOutput.scrollHeight;
}

// ---- the QR sheet ----------------------------------------------------------

/**
 * Draw the code.
 *
 * Built through `createElementNS` rather than by assembling an SVG string: the values are
 * numbers that this file produced, so a string would be safe, but "safe because of where
 * the numbers came from" is a property a reader cannot check at a glance — and this is the
 * one place in the panel that writes a structure rather than a text node.
 */
function paintQr(text: string): void {
  const modules = qrModules(text);
  const extent = modules.length + QUIET_ZONE * 2;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${extent} ${extent}`);
  // The same address is written out in text directly below the code, so announcing the
  // image as well would make a screen reader say it twice.
  svg.setAttribute("aria-hidden", "true");

  // Colours are attributes, not classes, and that is not a style choice.
  //
  // A scanner needs dark modules on a light field — inverting the code to follow a dark
  // window is the classic way to ship a QR that renders beautifully and never reads. As
  // classes, those two colours live only as long as the stylesheet does: copy the SVG out
  // of the page, or rasterise it on its own, and every rect falls back to SVG's default
  // black fill — including the quiet zone, which then paints over the whole code. Written
  // onto the elements, the code is a QR wherever it ends up.
  const quiet = document.createElementNS(SVG_NS, "rect");
  quiet.setAttribute("fill", "#ffffff");
  quiet.setAttribute("width", String(extent));
  quiet.setAttribute("height", String(extent));
  svg.append(quiet);

  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("fill", "#0d1117");
  for (const run of qrRuns(modules)) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(run.start + QUIET_ZONE));
    rect.setAttribute("y", String(run.row + QUIET_ZONE));
    rect.setAttribute("width", String(run.length));
    rect.setAttribute("height", "1");
    group.append(rect);
  }
  svg.append(group);

  qrContainer.replaceChildren(svg);
}

/**
 * What the sheet shows, given the state it is open over.
 *
 * Every branch that is not "here is the code" exists so the sheet is never a blank square:
 * a QR is the one thing on this panel that cannot explain itself, so when there is nothing
 * to draw, the sentence in its place has to say why.
 */
function renderQrSheet(): void {
  if (!state || qrOverlay.hidden) return;
  const { server, sharedOnLan, lanUrl } = state;

  let message: string | null = null;
  let fault = false;

  if (server.state === "starting" || server.state === "stopping") {
    message = t("qr.preparing");
  } else if (server.state === "failed") {
    message = server.fault ? describeFault(messages, server.fault) : t("qr.notRunning");
    fault = true;
  } else if (server.state !== "running") {
    message = t("qr.notRunning");
  } else if (!lanUrl) {
    // Sharing off means the switch is mid-flight — `openQrOverlay` turns it on before
    // settling here. Sharing on but no URL means the machine genuinely has no address.
    message = sharedOnLan ? t("qr.noNetwork") : t("qr.preparing");
  }

  qrMessage.textContent = message ?? "";
  qrMessage.hidden = message === null;
  qrMessage.classList.toggle("sheet__message--fault", fault);

  const showCode = message === null && lanUrl !== null;
  qrContainer.hidden = !showCode;
  qrAddress.hidden = !showCode;

  if (showCode && lanUrl !== paintedUrl) {
    paintQr(lanUrl);
    paintedUrl = lanUrl;
  }
  if (!showCode) paintedUrl = null;

  qrUrlCode.textContent = lanUrl ?? "";
}

async function openQrOverlay(): Promise<void> {
  qrOverlay.hidden = false;
  renderQrSheet();
  buttons.qrCopy.focus();

  // Turning it on here rather than behind a separate switch is what makes the button mean
  // what it says: pressing "open on your phone" *is* the consent to be reachable, so the
  // panel performs it and then reports the truth of what happened.
  if (state && !state.sharedOnLan) {
    render(await window.panel.shareOnLan(true));
  }
}

function closeQrOverlay(): void {
  qrOverlay.hidden = true;
  buttons.share.focus();
}

// ---- wiring ----------------------------------------------------------------

/**
 * Start, and the two preconditions the server has in front of it.
 *
 * A data root and an administrator, and the server refuses to listen without either. The button
 * walks them in order and ends by actually starting — which is the difference between a Start that
 * works and one that leaves the reader to work out what else is missing.
 *
 * ### Which side owns which step
 *
 * The **folder** is main's, and main asks for it itself: the question is native, and main is the
 * side that knows what folder it would create. Nothing about it is here.
 *
 * The **administrator** is unavoidably split, because the form that collects a name and a password
 * is this page's. So main answers a Start with "nobody can sign in yet" by *not* spawning and
 * saying so in the state, and this function opens the sheet and calls Start again once the account
 * exists. The chaining lives here because the sheet does, and because both preconditions are
 * already readable from the state rather than needing anything new to carry them.
 *
 * ### The other door does not do this
 *
 * The card's own 创建管理员 button creates and stops there — *creating an administrator is not a
 * request to run the server*, which is what the reader asked for by pressing Start. Same form, two
 * endings, and the door they came through is what tells them apart. So a sheet opened from Start is
 * closed here the moment it succeeds, because the reader's attention belongs back on the panel.
 */
async function startFlow(): Promise<void> {
  const first = await window.panel.start();
  render(first);

  // "Nobody has said where the data goes", which main has just asked about natively. Reaching here
  // with it still true means that question was dismissed, and there is nothing to chain into.
  if (first.needsDataDir) return;
  // Started, or failed for a reason of its own — which the status line now reports. The one thing
  // left to handle is the state this whole function exists for.
  if (first.needsAdmin !== true) return;

  const created = await openCreateAdmin();
  if (!created) return;

  closeCreateAdmin();
  render(await window.panel.start());
}

buttons.start.addEventListener("click", () => void startFlow());
buttons.stop.addEventListener("click", () => void window.panel.stop().then(render));
buttons.open.addEventListener("click", () => void window.panel.openApp());
buttons.browser.addEventListener("click", () => void window.panel.openInBrowser());
buttons.reveal.addEventListener("click", () => void window.panel.revealDataDir());
// The check resolves with the state it produced, so there is nothing to poll: `render` draws the
// result, including the "checking" phase, which arrives through the broadcast.
buttons.checkUpdates.addEventListener("click", () =>
  void window.panel.checkForUpdates().then(render)
);
buttons.update.addEventListener("click", () => void window.panel.openUpdatePage());
buttons.chooseDataDir.addEventListener("click", () =>
  void window.panel.chooseDataDir().then(render)
);
buttons.useDefaultDataDir.addEventListener("click", () =>
  void window.panel.useDefaultDataDir().then(render)
);

/**
 * The language control.
 *
 * A round trip rather than a local swap, and the answer is what gets rendered — so the page
 * never shows a language the menu bar above it has not adopted yet. The value is checked here
 * only to *narrow the type*: `<select>` cannot produce anything else, and main is the side that
 * decides what an unknown value means.
 */
localeSelect.addEventListener("change", () => {
  const choice = localeSelect.value;
  void window.panel
    .setLocale(isPanelLocaleChoice(choice) ? choice : "")
    .then(render);
});

logsToggle.addEventListener("click", () => setLogsOpen(!logsOpen));

buttons.share.addEventListener("click", () => void openQrOverlay());
buttons.unshare.addEventListener("click", () => void window.panel.shareOnLan(false).then(render));

for (const control of document.querySelectorAll<HTMLElement>('[data-action="qr-dismiss"]')) {
  control.addEventListener("click", closeQrOverlay);
}

// Escape is what a keyboard user reaches for, and a modal that ignores it traps them.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // The create sheet first if it is open: the fields have focus, and typing in them is not a
  // request to dismiss the sheet underneath.
  if (!adminOverlay.hidden) {
    event.preventDefault();
    closeCreateAdmin();
    return;
  }
  if (!resetOverlay.hidden) {
    event.preventDefault();
    closeResetAdmin();
    return;
  }
  if (!qrOverlay.hidden) {
    event.preventDefault();
    closeQrOverlay();
  }
});

/**
 * Copy, and say so.
 *
 * One timer per button rather than one shared: the two copy buttons live in different
 * places and a shared timer would reset whichever was not pressed. The label reverts after
 * a moment so "Copied" is an acknowledgement rather than a new name for the button.
 */
const copyTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

/**
 * What each copy button is called when it is not saying "copied".
 *
 * A map rather than a single literal inside `copy`, because the two buttons do not share a
 * label: the address ones are "copy address" and the credential one is just "copy". Restoring
 * all three to `action.copyUrl` was a live bug — the reset button came back from its
 * acknowledgement labelled "Copy address", on a row that has no address on it. Keyed by the
 * button so a change of language cannot leave a stale string behind either: the restore reads
 * the catalog at the moment it happens.
 */
const COPY_LABEL = new Map<HTMLButtonElement, keyof PanelMessages>([
  [buttons.copy, "action.copyUrl"],
  [buttons.qrCopy, "action.copyUrl"],
]);

function copy(button: HTMLButtonElement, text: string): void {
  if (!text) return;
  void navigator.clipboard.writeText(text).then(
    () => {
      button.textContent = t("action.copied");
      const existing = copyTimers.get(button);
      if (existing) clearTimeout(existing);
      copyTimers.set(
        button,
        setTimeout(() => {
          button.textContent = t(COPY_LABEL.get(button) ?? "action.copyUrl");
          copyTimers.delete(button);
        }, 1500)
      );
    },
    // No clipboard permission is the only realistic failure, and both addresses are on
    // screen and selectable — so this stays silent rather than claiming a copy happened.
    () => undefined
  );
}

buttons.copy.addEventListener("click", () => copy(buttons.copy, urlCode.textContent ?? ""));
buttons.qrCopy.addEventListener("click", () => copy(buttons.qrCopy, qrUrlCode.textContent ?? ""));

// The entry button opens the sheet; the actual reset is submitted from it.
buttons.resetAdmin.addEventListener("click", openResetAdmin);
buttons.resetSubmit.addEventListener("click", () => void submitResetAdmin());
for (const control of document.querySelectorAll<HTMLElement>('[data-action="reset-cancel"]')) {
  control.addEventListener("click", closeResetAdmin);
}
for (const field of [resetPasswordInput, resetConfirmInput]) {
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitResetAdmin();
    }
  });
}

/*
 * The card's own button, which **creates and stops there** — opening this form is not a request to
 * run the server. `startFlow` below is the other door, and it starts because *Start* is what the
 * reader pressed.
 */
buttons.adminCreate.addEventListener("click", () => void openCreateAdmin());
buttons.adminSubmit.addEventListener("click", () => void submitCreateAdmin());
document
  .querySelectorAll<HTMLElement>('[data-action="admin-cancel"]')
  .forEach((node) => node.addEventListener("click", closeCreateAdmin));
// Submit on Enter, matching how the web sign-in form behaves.
for (const field of [adminUsername, adminPassword, adminConfirm]) {
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitCreateAdmin();
    }
  });
}

setLogsOpen(false);
window.panel.onStateChange(render);
void window.panel.getState().then(render);
