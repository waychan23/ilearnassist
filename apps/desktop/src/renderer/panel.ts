import type { PanelState, ServerState } from "../shared/panelApi.js";
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
document.title = t("window.title");

let state: PanelState | null = null;
let logsOpen = false;
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
  const { server, sharedOnLan, lanUrl, needsDataDir } = next;
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

  buttons.open.disabled = !running;
  buttons.browser.disabled = !running;
  buttons.copy.disabled = !running;
  buttons.start.disabled = busy || running;
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
  if (event.key === "Escape" && !qrOverlay.hidden) {
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

setLogsOpen(false);
window.panel.onStateChange(render);
void window.panel.getState().then(render);
