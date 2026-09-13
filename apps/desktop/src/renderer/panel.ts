import type { PanelState, ResetResult, ServerState } from "../shared/panelApi.js";
import {
  PANEL_MESSAGES,
  describeFault,
  resolvePanelLocale,
  translate,
  type PanelMessages,
} from "../shared/messages.js";
import { qrModules, qrRuns } from "../shared/qr.js";

/**
 * The control panel page.
 *
 * Deliberately tiny and dependency-free apart from the QR encoder. It renders one state
 * object and forwards eight commands; all the judgement about what a state *means* lives in
 * `ServerProcess`, and all the wording lives in `shared/messages.ts`. So this file has no
 * conditionals about the server process and no user-facing strings — just bindings.
 */

const messages = PANEL_MESSAGES[resolvePanelLocale(navigator.language)];
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
const lanUrlCode = element<HTMLElement>('[data-role="lan-url"]');
const logsLabel = element<HTMLElement>('[data-role="logs-label"]');
const logOutput = element<HTMLPreElement>('[data-role="logs"]');
const logsToggle = element<HTMLButtonElement>('[data-action="logs"]');

const qrOverlay = element<HTMLElement>('[data-role="qr-overlay"]');
const qrContainer = element<HTMLElement>('[data-role="qr"]');
const qrMessage = element<HTMLElement>('[data-role="qr-message"]');
const qrAddress = element<HTMLElement>('[data-role="qr-address"]');
const qrUrlCode = element<HTMLElement>('[data-role="qr-url"]');

const action = (name: string): HTMLButtonElement =>
  element<HTMLButtonElement>(`[data-action="${name}"]`);

/* ---- the administrator's password ---------------------------------------- */

const resetBox = element<HTMLElement>('[data-role="reset"]');
const resetLead = element<HTMLElement>('[data-role="reset-lead"]');
const resetUserLabel = element<HTMLElement>('[data-role="reset-user-label"]');
const resetUsername = element<HTMLElement>('[data-role="reset-username"]');
const resetPassLabel = element<HTMLElement>('[data-role="reset-pass-label"]');
const resetPassword = element<HTMLElement>('[data-role="reset-password"]');

/* ---- the first administrator -------------------------------------------- */

const adminCard = element<HTMLElement>('[data-role="admin"]');
const adminOverlay = element<HTMLElement>('[data-role="admin-overlay"]');
const adminUsername = element<HTMLInputElement>('[data-role="admin-username"]');
const adminPassword = element<HTMLInputElement>('[data-role="admin-password"]');
const adminConfirm = element<HTMLInputElement>('[data-role="admin-confirm"]');
const adminError = element<HTMLElement>('[data-role="admin-error"]');
const adminOk = element<HTMLElement>('[data-role="admin-ok"]');

const buttons = {
  open: action("open"),
  start: action("start"),
  stop: action("stop"),
  browser: action("browser"),
  copy: action("copy"),
  reveal: action("reveal"),
  chooseDataDir: action("choose-data-dir"),
  share: action("share"),
  unshare: action("unshare"),
  qrCopy: action("qr-copy"),
  resetAdmin: action("reset-admin"),
  resetCopy: action("reset-copy"),
  resetDismiss: action("reset-dismiss"),
  adminCreate: action("admin-create"),
  adminSubmit: action("admin-submit"),
};

/** macOS draws its traffic lights inside the window because of `titleBarStyle: hiddenInset`. */
if (navigator.platform.startsWith("Mac")) document.body.classList.add("is-mac");

// Static labels, written once. The dynamic ones are set in `render`.
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
buttons.share.textContent = t("action.share");
buttons.unshare.textContent = t("action.unshare");
buttons.resetAdmin.textContent = t("action.resetAdmin");
buttons.resetCopy.textContent = t("reset.copy");
buttons.resetDismiss.textContent = t("reset.dismiss");
buttons.adminCreate.textContent = t("action.createAdmin");
buttons.adminSubmit.textContent = t("create.submit");
resetUserLabel.textContent = t("reset.username");
resetPassLabel.textContent = t("reset.password");
document.title = t("window.title");

let state: PanelState | null = null;
let logsOpen = false;
/**
 * What the last reset produced, or null.
 *
 * Component-local rather than part of `PanelState`, and deliberately: the state object is the
 * *server's*, broadcast on every change, and a password is not something to put in it — every
 * re-render would carry it back over the IPC boundary. It lives here until the user closes it,
 * which is the whole of its lifetime; nothing persists it.
 */
let reset: ResetResult | null = null;
/** In flight, so the button cannot fire twice and the wait is visible. */
let resetting = false;
let logCount = 0;
/** The address the sheet is currently drawing, so a log line cannot repaint ~150 rects. */
let paintedUrl: string | null = null;

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
  const { server, sharedOnLan, lanUrl, needsDataDir, needsAdmin } = next;
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
  dataDirHint.textContent = needsDataDir ? t("hint.chooseDataDir") : "";
  dataDirHint.hidden = !needsDataDir;

  // Only while the server is up: the reset is a conversation with it, and a button that could
  // only fail is one the user has to guess the reason for.
  buttons.resetAdmin.disabled = !running || resetting;
  buttons.resetAdmin.textContent = resetting ? t("reset.working") : t("action.resetAdmin");

  buttons.open.disabled = !running;
  buttons.browser.disabled = !running;
  buttons.copy.disabled = !running;
  // Start is also refused while an administrator is missing: the server exits on it, so a
  // button that produced "failed: exited 1" would be the exact failure the card prevents.
  // The card's own create control needs a folder to write into, and is inert until one is
  // chosen.
  const waitingForAdmin = needsAdmin === true;
  adminCard.hidden = !waitingForAdmin;
  buttons.adminCreate.disabled = needsDataDir || creating;
  buttons.start.disabled = busy || running || waitingForAdmin;
  buttons.stop.disabled = !(busy || running);
  buttons.reveal.disabled = needsDataDir;
  buttons.chooseDataDir.disabled = busy;
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
  renderReset();
  renderCreateAdmin();
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

function openCreateAdmin(): void {
  if (!state || state.needsDataDir) return;
  createOpen = true;
  adminError.hidden = true;
  adminOk.hidden = true;
  adminOverlay.hidden = false;
  adminUsername.value = "";
  adminPassword.value = "";
  adminConfirm.value = "";
  adminUsername.focus();
}

function closeCreateAdmin(): void {
  createOpen = false;
  adminOverlay.hidden = true;
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
    showCreateError(password ? t("create.fault.USERNAME_REQUIRED") : t("create.fault.PASSWORD_REQUIRED"));
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
      // The main process re-checks and broadcasts `needsAdmin: false`, so the card and the
      // Start button follow on their own. Here the sheet only reports success.
      adminOk.textContent = t("create.done", { name: result.username });
      adminOk.hidden = false;
      adminUsername.disabled = true;
      adminPassword.disabled = true;
      adminConfirm.disabled = true;
      buttons.adminSubmit.hidden = true;
      buttons.adminCreate.disabled = true;
      creating = false;
      return;
    }
    showCreateError(describeAdminFault(messages, result.fault));
  } catch (error) {
    showCreateError(error instanceof Error ? error.message : String(error));
  } finally {
    creating = false;
    buttons.adminSubmit.textContent = t("create.submit");
  }
}

function showCreateError(message: string): void {
  adminError.textContent = message;
  adminError.hidden = false;
}

/** A fault sentence: the CLI code if the catalog has it, else the sentence the child sent. */
function describeAdminFault(
  catalog: PanelMessages,
  fault: { code: string; message?: string; params?: Record<string, string | number> }
): string {
  const key = `create.fault.${fault.code}` as keyof PanelMessages;
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

/**
 * Draw whatever the last reset produced.
 *
 * One function for all four outcomes, because they are one region of the page: the success
 * panel, the two lines of a fault, and nothing at all when there is nothing to say.
 */
function renderReset(): void {
  if (!reset) {
    resetBox.hidden = true;
    return;
  }
  resetBox.hidden = false;

  if (reset.ok) {
    resetBox.dataset.state = "done";
    resetLead.textContent = t("reset.done");
    resetUsername.textContent = reset.username;
    resetPassword.textContent = reset.password;
    return;
  }

  // A fault is a sentence with no code to copy, so the label lines are cleared rather than
  // left showing the previous run's password — which is exactly the sort of stale credential
  // a reader would take for a new one.
  resetBox.dataset.state = "fault";
  resetLead.textContent = t(`reset.fault.${reset.fault.code}` as keyof PanelMessages);
  resetUsername.textContent = "";
  resetPassword.textContent = "";
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

buttons.start.addEventListener("click", () => void window.panel.start().then(render));
buttons.stop.addEventListener("click", () => void window.panel.stop().then(render));
buttons.open.addEventListener("click", () => void window.panel.openApp());
buttons.browser.addEventListener("click", () => void window.panel.openInBrowser());
buttons.reveal.addEventListener("click", () => void window.panel.revealDataDir());
buttons.chooseDataDir.addEventListener("click", () =>
  void window.panel.chooseDataDir().then(render)
);
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
  // request to dismiss the QR sheet underneath.
  if (!adminOverlay.hidden) {
    event.preventDefault();
    closeCreateAdmin();
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
          button.textContent = t("action.copyUrl");
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

buttons.resetAdmin.addEventListener("click", () => {
  resetting = true;
  reset = null;
  if (state) render(state);
  void window.panel.resetAdminPassword().then((result) => {
    resetting = false;
    // `null` is a dismissed confirmation, which is an outcome and not something to report.
    if (result !== null) reset = result;
    if (state) render(state);
  });
});
buttons.resetCopy.addEventListener("click", () => {
  // Both lines in one press: they are only useful together, and the username is the half a
  // reader would otherwise retype by hand.
  const username = resetUsername.textContent ?? "";
  const password = resetPassword.textContent ?? "";
  copy(buttons.resetCopy, username && password ? `${t("reset.username")}: ${username}\n${t("reset.password")}: ${password}` : "");
});
buttons.resetDismiss.addEventListener("click", () => {
  reset = null;
  if (state) render(state);
});

buttons.adminCreate.addEventListener("click", openCreateAdmin);
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
