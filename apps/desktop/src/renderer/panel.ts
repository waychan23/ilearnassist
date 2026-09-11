import type { ServerState, ServerStatus } from "../shared/panelApi.js";
import {
  PANEL_MESSAGES,
  describeFault,
  resolvePanelLocale,
  translate,
  type PanelMessages,
} from "../shared/messages.js";

/**
 * The control panel page.
 *
 * Deliberately tiny and dependency-free. It renders one status object and forwards seven
 * commands; all the judgement about what a state *means* lives in `ServerProcess`, and all
 * the wording lives in `shared/messages.ts`. So this file has no conditionals about the
 * server and no user-facing strings — just bindings.
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
const logsLabel = element<HTMLElement>('[data-role="logs-label"]');
const logOutput = element<HTMLPreElement>('[data-role="logs"]');
const logsToggle = element<HTMLButtonElement>('[data-action="logs"]');

const action = (name: string): HTMLButtonElement => element<HTMLButtonElement>(`[data-action="${name}"]`);

const buttons = {
  open: action("open"),
  start: action("start"),
  stop: action("stop"),
  browser: action("browser"),
  copy: action("copy"),
  reveal: action("reveal"),
};

/** macOS draws its traffic lights inside the window because of `titleBarStyle: hiddenInset`. */
if (navigator.platform.startsWith("Mac")) document.body.classList.add("is-mac");

// Static labels, written once. The dynamic ones are set in `render`.
for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
  const key = node.dataset.i18n as keyof PanelMessages;
  node.textContent = t(key);
}
buttons.open.textContent = t("action.open");
buttons.start.textContent = t("action.start");
buttons.stop.textContent = t("action.stop");
buttons.browser.textContent = t("action.openInBrowser");
buttons.copy.textContent = t("action.copyUrl");
buttons.reveal.textContent = t("action.reveal");
document.title = t("window.title");

let logsOpen = false;
let logCount = 0;
/** Cleared after a moment so "已复制" is an acknowledgement and not a new label. */
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

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

function render(status: ServerStatus): void {
  const running = status.state === "running";
  const busy = status.state === "starting" || status.state === "stopping";

  panel.dataset.state = status.state;
  statusCard.dataset.state = status.state;
  stateLabel.textContent = t(STATE_KEYS[status.state]);

  // The fault, not the state, is what a user needs when a start fails; the state word alone
  // ("Failed to start") says nothing they can act on.
  if (status.state === "failed" && status.fault) {
    detail.textContent = describeFault(messages, status.fault);
    detail.hidden = false;
  } else {
    detail.hidden = true;
  }

  urlCode.textContent = status.url ?? "";
  urlRow.hidden = !running || !status.url;
  dataDirCode.textContent = status.dataDir;

  buttons.open.disabled = !running;
  buttons.browser.disabled = !running;
  buttons.copy.disabled = !running;
  buttons.start.disabled = busy || running;
  buttons.stop.disabled = !(busy || running);
  buttons.open.title = running ? "" : t("hint.notRunning");

  logCount = status.logs.length;
  refreshLogsHeader();
  logOutput.textContent = logCount > 0 ? status.logs.join("\n") : t("label.logsEmpty");

  // Keep the newest line in view, but only while the user is already at the bottom —
  // otherwise a scrollback they are reading would jump under them.
  if (logsOpen) {
    const atBottom =
      logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 24;
    if (atBottom) logOutput.scrollTop = logOutput.scrollHeight;
  }
}

function setLogsOpen(open: boolean): void {
  logsOpen = open;
  logsToggle.setAttribute("aria-expanded", String(open));
  refreshLogsHeader();
  logOutput.hidden = !open;
  if (open) logOutput.scrollTop = logOutput.scrollHeight;
}

buttons.start.addEventListener("click", () => void window.panel.start());
buttons.stop.addEventListener("click", () => void window.panel.stop());
buttons.open.addEventListener("click", () => void window.panel.openApp());
buttons.browser.addEventListener("click", () => void window.panel.openInBrowser());
buttons.reveal.addEventListener("click", () => void window.panel.revealDataDir());
logsToggle.addEventListener("click", () => setLogsOpen(!logsOpen));

buttons.copy.addEventListener("click", () => {
  const url = urlCode.textContent ?? "";
  if (!url) return;
  void navigator.clipboard.writeText(url).then(
    () => {
      buttons.copy.textContent = t("action.copied");
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        buttons.copy.textContent = t("action.copyUrl");
      }, 1500);
    },
    // No clipboard permission is the only realistic failure, and the address is right
    // there and selectable — so this stays silent rather than claiming a copy happened.
    () => undefined
  );
});

window.panel.onStateChange(render);
void window.panel.getState().then(render);

setLogsOpen(false);
