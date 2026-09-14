import { expect, test, type Page } from "./fixtures";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PanelState, ResetResult } from "../apps/desktop/src/shared/panelApi.js";

/**
 * The desktop control panel's page, in a real browser.
 *
 * It runs against the *built* bundle rather than the source, and it does not launch
 * Electron: the panel's own code is a page plus a bundle, and what it needs from Electron is
 * exactly one object on `window`. Stubbing that object is what makes the page testable at
 * all, and it is the right seam — everything above the boundary (`ServerProcess`, the IPC
 * handlers) is already covered by `apps/desktop/test/`, against real child processes.
 *
 * The reason this exists rather than a jsdom test is `will not claim a server is up when it
 * is not`. jsdom has no layout engine and no cascade, so it cannot tell whether `hidden`
 * actually hides anything — and a `display: flex` in the stylesheet overriding the attribute
 * is precisely the bug that shipped once: the address row kept its "copy" button, next to no
 * address, every time a start failed.
 *
 * `pnpm test:e2e` bundles the panel first; the global `locale: "zh-CN"` pin in
 * `playwright.config.ts` means the panel detects Chinese the same way the app does.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PANEL_URL = pathToFileURL(join(ROOT, "apps/desktop/dist/renderer/index.html")).href;

const LOOPBACK = "http://127.0.0.1:51452";
const LAN_ADDRESS = "192.168.1.42";
const LAN_URL = `http://${LAN_ADDRESS}:51452`;

/** The folder the user chose. Deliberately not under the app's own directory. */
const DATA_DIR = "/Users/someone/Documents/ilearnassist";

const RUNNING: PanelState = {
  server: {
    state: "running",
    url: LOOPBACK,
    fault: null,
    dataDir: DATA_DIR,
    logs: ["seeding providers", `[ilearnassist] listening on ${LOOPBACK}`],
  },
  sharedOnLan: false,
  lanUrl: null,
  lanAddress: LAN_ADDRESS,
  needsDataDir: false,
  needsAdmin: false,
  // The panel's language, as the main process would report it. Following the system here, so
  // the spec renders whichever catalog the browser's locale pinned — which is what the rest of
  // the suite already relies on.
  localeChoice: "",
  locale: "zh-CN",
};

const SHARED: PanelState = { ...RUNNING, sharedOnLan: true, lanUrl: LAN_URL };

/**
 * A data folder with no administrator yet. The server cannot be started in this state — it
 * refuses to listen — so the panel offers the create control and keeps Start inert.
 */
const NEEDS_ADMIN: PanelState = {
  ...RUNNING,
  server: { state: "stopped", url: null, fault: null, dataDir: DATA_DIR, logs: [] },
  needsAdmin: true,
};

/**
 * Before anyone has said where the data goes. The server cannot be started in this state —
 * it refuses to run without a data root — so the panel's job is to ask, and nothing that
 * needs a running server should look available.
 */
/**
 * A data folder that is set up, with the server **stopped**.
 *
 * The ordinary state a forgotten password is found in — and the one the reset button used to be
 * dead in, because the reset was a request to the running server. Nothing about it needs the
 * server now.
 */
const STOPPED_WITH_ADMIN: PanelState = {
  ...RUNNING,
  server: { state: "stopped", url: null, fault: null, dataDir: DATA_DIR, logs: [] },
};

const NEEDS_DATA_DIR: PanelState = {
  server: { state: "stopped", url: null, fault: null, dataDir: "", logs: [] },
  sharedOnLan: false,
  lanUrl: null,
  lanAddress: LAN_ADDRESS,
  needsDataDir: true,
  needsAdmin: undefined,
  localeChoice: "",
  locale: "zh-CN",
};

const FAILED: PanelState = {
  ...RUNNING,
  server: { ...RUNNING.server, state: "failed", url: null, fault: { code: "exited", exitCode: 1, signal: null } },
};

interface PanelHandle {
  push(next: PanelState): Promise<void>;
  calls: string[];
}

/**
 * Load the panel with a stubbed `window.panel`, and return a handle for pushing status
 * changes the way the main process would.
 */
async function openPanel(
  page: Page,
  initial: PanelState,
  /**
   * What the main process answers the reset with — the password it generated, a fault, or
   * `null` for a dismissed confirmation. Configurable because the panel renders all three
   * differently, and only the first is the happy path.
   */
  reset: ResetResult | null = null,
  /** What the create-administrator call answers. The happy path by default. */
  adminCreate:
    | { ok: true; username?: string }
    | { ok: false; fault: { code: string; message?: string; params?: Record<string, number | string> } } = {
    ok: true,
    username: "tester",
  }
): Promise<PanelHandle> {
  const calls: string[] = [];
  await page.exposeFunction("__record", (name: string) => {
    calls.push(name);
  });

  await page.addInitScript(
    ({
      status,
      resetResult,
      createResult,
    }: {
      status: PanelState;
      resetResult: ResetResult | null;
      createResult:
        | { ok: true; username?: string }
        | { ok: false; fault: { code: string; message?: string; params?: Record<string, number | string> } };
    }) => {
    const w = window as unknown as Record<string, unknown>;
    w["__status"] = status;
    const record = w["__record"] as (name: string) => Promise<void>;
    w["panel"] = {
      getState: async () => w["__status"],
      start: async () => {
        await record("start");
        return w["__status"];
      },
      stop: async () => {
        await record("stop");
        return w["__status"];
      },
      shareOnLan: async (on: boolean) => {
        await record(`shareOnLan:${on}`);
        return w["__status"];
      },
      chooseDataDir: async () => {
        await record("chooseDataDir");
        return w["__status"];
      },
      openApp: async () => {
        await record("openApp");
      },
      openInBrowser: async () => undefined,
      revealDataDir: async () => undefined,
      resetAdminPassword: async () => {
        await record("resetAdminPassword");
        return resetResult;
      },
      adminStatus: async () => {
        await record("adminStatus");
        return { ok: true, status: { hasAdmin: (w.__status as PanelState).needsAdmin === false, adminUsername: "tester" } };
      },
      createAdministrator: async () => {
        await record("createAdministrator");
        return createResult;
      },
      // The real handler writes the preference and answers with the state it made true; the
      // stub does the same thing in one line, because what the page does with the *answer* is
      // the half this spec can see.
      setLocale: async (choice: string) => {
        await record(`setLocale:${choice}`);
        const next = {
          ...(w["__status"] as PanelState),
          localeChoice: choice === "" ? "" : choice,
          locale: choice === "" ? "zh-CN" : choice,
        } as PanelState;
        w["__status"] = next;
        return next;
      },
      quit: async () => undefined,
      onStateChange: (listener: (state: PanelState) => void) => {
        w["__push"] = listener;
        return () => undefined;
      },
    };
    },
    {
      status: initial,
      resetResult: reset,
      createResult: adminCreate,
    }
  );

  await page.goto(PANEL_URL);

  return {
    calls,
    push: async (next) => {
      await page.evaluate((state) => {
        const w = window as unknown as Record<string, unknown>;
        w["__status"] = state;
        (w["__push"] as (s: PanelState) => void)(state);
      }, next);
    },
  };
}

const status = (page: Page) => page.locator(".status");
const qrSheet = (page: Page) => page.locator('[data-role="qr-overlay"]');

test.describe("the control panel", () => {
  test.use({ viewport: { width: 480, height: 660 } });

  test("shows a running server with the address it came up on", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-role="state"]')).toHaveText("运行中");
    await expect(page.locator('[data-role="url"]')).toHaveText(LOOPBACK);
    await expect(page.locator('[data-role="detail"]')).toBeHidden();
  });

  test("offers only the actions that make sense for the state", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-action="open"]')).toBeEnabled();
    // Already up: starting again would do nothing, and stopping is the only move left.
    await expect(page.locator('[data-action="start"]')).toBeDisabled();
    await expect(page.locator('[data-action="stop"]')).toBeEnabled();
  });

  test("will not claim a server is up when it is not", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await panel.push(FAILED);

    await expect(status(page)).toHaveAttribute("data-state", "failed");
    await expect(page.locator('[data-role="state"]')).toHaveText("启动失败");

    // The address row has to go — and this is the assertion jsdom could not make. The row
    // is `display: flex`, so `hidden` alone left the "copy" button on screen with nothing
    // to copy.
    await expect(page.locator('[data-role="url-row"]')).toBeHidden();
    await expect(page.locator('[data-action="copy"]')).toBeHidden();
  });

  test("says why a start failed, in words a user can act on", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await panel.push(FAILED);

    await expect(page.locator('[data-role="detail"]')).toBeVisible();
    await expect(page.locator('[data-role="detail"]')).toContainText("1");
  });

  test("re-enables starting once the server is down", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await panel.push({ ...RUNNING, server: { ...RUNNING.server, state: "stopped", url: null } });

    await expect(page.locator('[data-action="start"]')).toBeEnabled();
    await expect(page.locator('[data-action="stop"]')).toBeDisabled();
    await expect(page.locator('[data-action="open"]')).toBeDisabled();
  });

  test("keeps the server's output folded away until it is asked for", async ({ page }) => {
    await openPanel(page, RUNNING);

    await expect(page.locator('[data-role="logs"]')).toBeHidden();

    await page.locator('[data-action="logs"]').click();

    await expect(page.locator('[data-action="logs"]')).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-role="logs"]')).toBeVisible();
    await expect(page.locator('[data-role="logs"]')).toContainText("[ilearnassist] listening on");
  });

  test("sends the command when a button is pressed", async ({ page }) => {
    const panel = await openPanel(page, { ...RUNNING, server: { ...RUNNING.server, state: "stopped", url: null } });

    await page.locator('[data-action="start"]').click();
    await expect.poll(() => panel.calls).toContain("start");
  });

  test("names the folder the data lives in", async ({ page }) => {
    await openPanel(page, RUNNING);
    // A user who needs to back up, or to send someone a log, has to be able to find this.
    await expect(page.locator('[data-role="data-dir"]')).toHaveText(RUNNING.server.dataDir);
  });

  test("asks where the data should go, and says why nothing is running", async ({ page }) => {
    // The server refuses to start without a data root, so before one is chosen every control
    // that needs it is inert and the row explains itself. An empty path box and a start
    // button that does nothing is what this replaces.
    await openPanel(page, NEEDS_DATA_DIR);

    await expect(page.locator('[data-role="data-dir"]')).toBeHidden();
    await expect(page.locator('[data-role="data-dir-hint"]')).toContainText("数据存放位置");
    await expect(page.locator('[data-action="reveal"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "选择文件夹…" })).toBeEnabled();
  });

  test("hands the choice to the main process rather than making it", async ({ page }) => {
    // The dialog is native and lives in main, so the page's whole part in this is the ask.
    const panel = await openPanel(page, NEEDS_DATA_DIR);
    await page.getByRole("button", { name: "选择文件夹…" }).click();
    expect(panel.calls).toContain("chooseDataDir");
  });

  test("offers changing the folder once one is chosen, and revealing it", async ({ page }) => {
    // The same control in both states — the first-run prompt and the later "move my data"
    // — because they are the same question, and the panel has no separate settings screen
    // to put the second one in.
    await openPanel(page, RUNNING);

    await expect(page.getByRole("button", { name: "选择文件夹…" })).toBeEnabled();
    await expect(page.locator('[data-action="reveal"]')).toBeEnabled();
    await expect(page.locator('[data-role="data-dir-hint"]')).toBeHidden();
  });

  test("tells a user that closing the window does not stop the server", async ({ page }) => {
    // The tray is invisible until it is needed, so the one window that can explain it does.
    await openPanel(page, RUNNING);
    await expect(page.locator(".note")).toContainText("菜单栏");
  });

  test("fits every control inside the window, with none below the fold", async ({ page }) => {
    // The window is a fixed size and the panel is a fixed stack of rows, so adding a row is
    // how a control ends up off the bottom edge with nothing to indicate it exists. The log
    // disclosure was already half past the edge when the network row was added.
    await openPanel(page, SHARED);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    for (const selector of [
      '[data-action="open"]',
      '[data-action="stop"]',
      '[data-action="share"]',
      '[data-action="reveal"]',
      '[data-action="logs"]',
      ".note",
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      expect(box!.y + box!.height, selector).toBeLessThanOrEqual(viewport!.height);
    }
  });
});

test.describe("opening the app on a phone", () => {
  test.use({ viewport: { width: 480, height: 660 } });

  test("offers the network address only while sharing is on", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);
    await expect(page.locator('[data-role="lan-url"]')).toBeHidden();
    await expect(page.locator('[data-action="unshare"]')).toBeHidden();

    await panel.push(SHARED);

    await expect(page.locator('[data-role="lan-url"]')).toHaveText(LAN_URL);
    await expect(page.locator('[data-action="unshare"]')).toBeVisible();
  });

  test("draws a scannable code for the network address", async ({ page }) => {
    await openPanel(page, SHARED);

    await page.locator('[data-action="share"]').click();

    await expect(qrSheet(page)).toBeVisible();
    await expect(page.locator('[data-role="qr"] svg')).toBeVisible();
    // The address is written out as well as encoded, for a camera that will not cooperate.
    await expect(page.locator('[data-role="qr-url"]')).toHaveText(LAN_URL);
    // A button with no label is a rectangle: the sheet's copy control shipped blank once.
    await expect(page.locator('[data-action="qr-copy"]')).toHaveText("复制地址");

    // A QR code is mostly modules. A handful of rects would be a code that renders and
    // never scans, which is exactly the failure this asserts against.
    const modules = await page.locator('[data-role="qr"] rect, [data-role="qr"] g rect').count();
    expect(modules).toBeGreaterThan(40);
  });

  test("turns sharing on rather than showing a code that cannot work", async ({ page }) => {
    // The panel is loopback-only until this is pressed, so a code drawn from the current
    // state would encode 127.0.0.1 and send the phone to its own loopback.
    const panel = await openPanel(page, RUNNING);

    await page.locator('[data-action="share"]').click();

    await expect.poll(() => panel.calls).toContain("shareOnLan:true");
    // Until the restart lands there is genuinely nothing to scan, and the sheet says so
    // rather than leaving a blank square.
    await expect(page.locator('[data-role="qr-message"]')).toBeVisible();
    await expect(page.locator('[data-role="qr"]')).toBeHidden();

    await panel.push(SHARED);

    await expect(page.locator('[data-role="qr"] svg')).toBeVisible();
    await expect(page.locator('[data-role="qr-message"]')).toBeHidden();
  });

  test("says so when there is no network address to offer", async ({ page }) => {
    // A machine on no network cannot be reached from a phone, and a QR encoding a
    // loopback address would look like it worked.
    await openPanel(page, { ...SHARED, lanUrl: null, lanAddress: null });

    await page.locator('[data-action="share"]').click();

    await expect(page.locator('[data-role="qr-message"]')).toContainText("局域网地址");
    await expect(page.locator('[data-role="qr"]')).toBeHidden();
  });

  test("closes on Escape, so a modal does not trap a keyboard user", async ({ page }) => {
    await openPanel(page, SHARED);
    await page.locator('[data-action="share"]').click();
    await expect(qrSheet(page)).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(qrSheet(page)).toBeHidden();
  });

  test("turns sharing off from the panel, without opening the sheet", async ({ page }) => {
    const panel = await openPanel(page, SHARED);

    await page.locator('[data-action="unshare"]').click();

    await expect.poll(() => panel.calls).toContain("shareOnLan:false");
    await expect(qrSheet(page)).toBeHidden();
  });
});

/**
 * Resetting the administrator's password — the panel's one account control.
 *
 * It is here, in the panel, because it is the only thing that can fix a forgotten password:
 * every route in the app needs somebody already signed in, and that is exactly what a
 * forgotten password prevents. So the three claims worth making are that the control is not
 * offered when it cannot work, that it hands back a password the user can read and copy, and
 * that a failure says which failure it was.
 */
test.describe("resetting the administrator's password", () => {
  test.use({ viewport: { width: 480, height: 660 } });

  const RESET = '[data-action="reset-admin"]';
  const BOX = '[data-role="reset"]';

  test("is refused only when there is nowhere to write", async ({ page }) => {
    // The one state it cannot help in: nobody has said where the data goes, so there is no
    // database to reset a row in.
    await openPanel(page, NEEDS_DATA_DIR);
    await expect(page.locator(RESET)).toBeDisabled();
  });

  test("is offered with the server stopped, which is when it is most needed", async ({ page }) => {
    /*
     * The bug this spec exists for. The reset used to be a request to the *running* server, so
     * the one control that exists for "I cannot sign in" needed a healthy server — and a
     * forgotten password is often found in the same moment as something else being wrong. It is
     * a one-shot child now, so a stopped server changes nothing.
     */
    await openPanel(page, STOPPED_WITH_ADMIN);
    await expect(page.locator(RESET)).toBeEnabled();
  });

  test("is offered once the server is up", async ({ page }) => {
    await openPanel(page, RUNNING);
    await expect(page.locator(RESET)).toBeEnabled();
  });

  test("shows the new password once, with both halves of it", async ({ page }) => {
    const panel = await openPanel(page, RUNNING, {
      ok: true,
      username: "tester",
      password: "abcd-efgh-ijkl-mnop",
    });

    await page.locator(RESET).click();

    await expect.poll(() => panel.calls).toContain("resetAdminPassword");
    await expect(page.locator(BOX)).toBeVisible();
    await expect(page.locator('[data-role="reset-username"]')).toHaveText("tester");
    await expect(page.locator('[data-role="reset-password"]')).toHaveText("abcd-efgh-ijkl-mnop");
    // Selectable, because the copy button is a convenience and not the only way to get the
    // password out — it is shown once and there is no second chance to read it.
    await expect(page.locator('[data-role="reset-password"]')).toHaveCSS("user-select", "text");
  });

  test("says which failure it was rather than reporting a generic one", async ({ page }) => {
    // The child's own refusal, rendered from the same catalog the create form uses: it is one
    // conversation with one process, so a code means the same thing on either form.
    await openPanel(page, RUNNING, { ok: false, fault: { code: "ADMIN_NOT_FOUND" } });
    await page.locator(RESET).click();
    await expect(page.locator(BOX)).toContainText("还没有超级管理员");
    // No stale value left behind. The box is still in the document — the empty `<code>` is
    // hidden by the stylesheet, which is the point — but a credential from an earlier run
    // read as a new one is the worst thing this block could show, so it is not on screen.
    await expect(page.locator('[data-role="reset-password"]')).toBeHidden();
  });

  test("shows nothing at all when the confirmation was dismissed", async ({ page }) => {
    // `null` is an outcome, not a failure: the user changed their mind, and a box saying so
    // would be the panel arguing with them.
    const panel = await openPanel(page, RUNNING, null);

    await page.locator(RESET).click();

    await expect.poll(() => panel.calls).toContain("resetAdminPassword");
    await expect(page.locator(BOX)).toBeHidden();
  });

  test("closes the password box on demand", async ({ page }) => {
    await openPanel(page, RUNNING, {
      ok: true,
      username: "tester",
      password: "abcd-efgh-ijkl-mnop",
    });
    await page.locator(RESET).click();
    await expect(page.locator(BOX)).toBeVisible();

    await page.locator('[data-action="reset-dismiss"]').click();

    await expect(page.locator(BOX)).toBeHidden();
  });
});

test.describe("creating the first administrator", () => {
  const CARD = '[data-role="admin"]';
  const OVERLAY = '[data-role="admin-overlay"]';

  test("offers the create control and refuses Start when there is no administrator", async ({ page }) => {
    const handle = await openPanel(page, NEEDS_ADMIN);

    await expect(page.locator(CARD)).toBeVisible();
    expect(await page.locator('[data-action="start"]').isEnabled()).toBe(false);
    // No reset either: it is a conversation with the running server, which is deliberately
    // stopped in this state.
    expect(await page.locator('[data-action="reset-admin"]').isEnabled()).toBe(false);

    // Pressing Start does not even ask main to start, because the button is disabled — but
    // the card's button is live and opens the sheet.
    await page.locator('[data-action="admin-create"]').click();
    await expect(page.locator(OVERLAY)).toBeVisible();
    expect(handle.calls).not.toContain("start");
  });

  test("hides the card once an administrator exists", async ({ page }) => {
    await openPanel(page, RUNNING);
    await expect(page.locator(CARD)).toBeHidden();
  });

  test("refuses a mismatched confirmation without leaving the sheet", async ({ page }) => {
    const handle = await openPanel(page, NEEDS_ADMIN);
    await page.locator('[data-action="admin-create"]').click();

    await page.locator('[data-role="admin-username"]').fill("ada");
    await page.locator('[data-role="admin-password"]').fill("a-good-password");
    await page.locator('[data-role="admin-confirm"]').fill("a-good-password-typo");
    await page.locator('[data-action="admin-submit"]').click();

    await expect(page.locator('[data-role="admin-error"]')).toBeVisible();
    expect(handle.calls).not.toContain("createAdministrator");
  });

  test("creates and reports success", async ({ page }) => {
    // The stub hands back the typed username, the way the real IPC result does.
    await openPanel(page, NEEDS_ADMIN, null, { ok: true, username: "ada" });
    await page.locator('[data-action="admin-create"]').click();

    await page.locator('[data-role="admin-username"]').fill("ada");
    await page.locator('[data-role="admin-password"]').fill("a-good-password");
    await page.locator('[data-role="admin-confirm"]').fill("a-good-password");
    await page.locator('[data-action="admin-submit"]').click();

    await expect(page.locator('[data-role="admin-ok"]')).toContainText("ada");
  });

  test("shows the CLI's refusal with its own wording", async ({ page }) => {
    await openPanel(page, NEEDS_ADMIN, null, {
      ok: false,
      fault: { code: "PASSWORD_TOO_SHORT", message: "too short", params: { min: 8 } },
    });
    await page.locator('[data-action="admin-create"]').click();

    await page.locator('[data-role="admin-username"]').fill("ada");
    await page.locator('[data-role="admin-password"]').fill("short");
    await page.locator('[data-role="admin-confirm"]').fill("short");
    await page.locator('[data-action="admin-submit"]').click();

    // The catalog string for the CLI code, not the English sentence the child sent.
    await expect(page.locator('[data-role="admin-error"]')).toContainText("8");
  });

  test("closes on the scrim, the cancel link and Escape", async ({ page }) => {
    await openPanel(page, NEEDS_ADMIN);
    const open = async () => page.locator('[data-action="admin-create"]').click();

    // The scrim sits behind the sheet, so it is clicked by its position rather than by the
    // same selector as the in-sheet button (which the sheet covers).
    await open();
    await page.locator(`${OVERLAY} .overlay__scrim`).click({ position: { x: 5, y: 5 } });
    await expect(page.locator(OVERLAY)).toBeHidden();

    await open();
    await page.locator(`${OVERLAY} .sheet [data-action="admin-cancel"]`).first().click();
    await expect(page.locator(OVERLAY)).toBeHidden();

    await open();
    await page.keyboard.press("Escape");
    await expect(page.locator(OVERLAY)).toBeHidden();
  });
});

/**
 * The language control.
 *
 * The panel is bilingual at runtime, and the interesting half is that the *page* does not decide
 * the language: it asks the main process and renders the answer. That is what keeps the page and
 * the menu bar above it — the application menu, the tray, the window title — from ever showing
 * two languages, and it is why this spec drives the control through the stub's `setLocale`
 * rather than expecting a `navigator.language` it cannot change.
 */
test.describe("the panel's language", () => {
  test("offers the three choices, with the system one selected by default", async ({ page }) => {
    await openPanel(page, RUNNING);

    const select = page.locator('[data-role="locale"]');
    await expect(select).toBeVisible();
    await expect(select.locator("option")).toHaveCount(3);
    // "Follow the system" is the empty value: a select whose options are all non-empty strings
    // has no other way to spell "nobody has chosen".
    await expect(select).toHaveValue("");
    await expect(select).toContainText("跟随系统");
  });

  test("takes the language from the state rather than from the browser", async ({ page }) => {
    // The state says English, and the spec's own locale is zh-CN — so the page rendering English
    // is the page following main rather than its own `navigator.language`.
    await openPanel(page, { ...RUNNING, locale: "en", localeChoice: "en" });

    await expect(page.locator('[data-role="state"]')).toHaveText("Running");
    await expect(page.locator('[data-action="start"]')).toHaveText("Start server");
    await expect(page.locator('[data-role="locale"]')).toHaveValue("en");
  });

  test("hands the choice to the main process and renders what comes back", async ({ page }) => {
    const panel = await openPanel(page, RUNNING);

    await page.locator('[data-role="locale"]').selectOption("en");

    // Asked, not assumed: the page does not switch on its own, because the menu bar cannot.
    expect(panel.calls).toContain("setLocale:en");
    await expect(page.locator('[data-role="state"]')).toHaveText("Running");
    await expect(page.locator('[data-action="reset-admin"]')).toHaveText("Reset superadmin password");
    // The autonyms do not follow the language, which is the point of labelling each option in
    // its own — the picker stays usable to somebody who has just switched to a language they
    // cannot read.
    await expect(page.locator('[data-role="locale"]')).toContainText("简体中文");
  });

  test("goes back to following the system when that choice is picked", async ({ page }) => {
    const panel = await openPanel(page, { ...RUNNING, locale: "en", localeChoice: "en" });
    await expect(page.locator('[data-role="state"]')).toHaveText("Running");

    await page.locator('[data-role="locale"]').selectOption("");

    expect(panel.calls).toContain("setLocale:");
    await expect(page.locator('[data-role="state"]')).toHaveText("运行中");
  });
});
