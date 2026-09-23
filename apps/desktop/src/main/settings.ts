import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPanelLocaleChoice, type PanelLocaleChoice } from "../shared/messages.js";
import { DEFAULT_PORT, isUserPort } from "./launch.js";

/**
 * The control panel's own preferences.
 *
 * Kept apart from the server's config on purpose. That file describes the *product* —
 * providers, keys, parsing policy — and is seeded once and then owned by the user. This one
 * describes the *desktop app*: whether it is reachable from other devices, which window was
 * open, and whatever else is about the shell rather than the service. Mixing them would put
 * app-level switches in a file a user is invited to hand-edit, and would make "reset the
 * desktop app" mean "lose your API keys".
 *
 * Deliberately tiny, and deliberately tolerant: a settings file is a cache of a preference,
 * never a source of truth worth failing a launch over.
 */

export interface DesktopSettings {
  /**
   * Bind the server beyond loopback so a phone or tablet on the same network can open it.
   *
   * Off by default, and that default is the feature. Turning it on makes this machine's
   * workspaces, conversations and — through the chat UI on that device — the configured
   * provider keys reachable by anything on the network. That is a reasonable thing to want
   * on a home network and a bad thing to have happen by accident on a café's.
   */
  sharedOnLan: boolean;
  /**
   * The fixed port the server listens on.
   *
   * A panel decision passed to the server per launch, like the bind address, and for the same
   * reason: the port has to be changeable at runtime without rewriting the overlay the panel
   * seeded and the user may have edited. It is a fixed value rather than 0 — the address the
   * app is reached at must stay put, or bookmarks and saved passwords stop working.
   */
  port: number;
  /**
   * The chosen data root: the sqlite database, every account's workspaces, and the files
   * they upload. Empty until someone has chosen one.
   *
   * Stored here rather than in the server's config for the reason this module exists: it is
   * a decision the *launcher* makes and passes down, and a value in a config file could not
   * differ between two launches of the same install. It is also the one preference whose
   * loss is not merely inconvenient — it is what says where the user's work is, so
   * `readSettings` falling back to `""` on a corrupt file means "ask again", never "use
   * somewhere else".
   */
  dataDir: string;
  /**
   * Which language the panel speaks: `""` for "follow the operating system", or a shipped
   * locale tag.
   *
   * Stored here rather than in the renderer's `localStorage`, and that is not a convenience:
   * the panel's language is not only the page's. The menu bar, the tray menu, the window title
   * and every native dialog — including the two that confirm a data folder and a password reset
   * — are strings the **main** process renders, and they have to change with the page rather
   * than a restart later. This file is the only thing both processes already share.
   */
  locale: PanelLocaleChoice;
  /**
   * What the last look at GitHub found, so an offline launch does not look like a broken one.
   *
   * `null` means no check has ever completed — a first run, or one that has never had a network.
   * The panel distinguishes the two: "never checked" shows nothing, and "checked, and there is
   * nothing newer" also shows nothing, but a *cached* answer lets the notice survive a restart
   * without asking GitHub again on every launch.
   *
   * Written by the main process only, and read back through `readSettings`'s narrowing like
   * everything else here. Note what is *not* cached: a failure. A check that could not answer
   * leaves the previous result alone rather than replacing it with "nothing", which would make a
   * flaky network look like a confirmed up-to-date app.
   */
  updateCheck: UpdateCheckCache | null;
}

/** A completed version check, as it is remembered between launches. */
export interface UpdateCheckCache {
  latestVersion: string;
  url: string;
  /** ISO, so the panel could show it later; nothing reads it yet. */
  checkedAt: string;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  sharedOnLan: false,
  port: DEFAULT_PORT,
  dataDir: "",
  locale: "",
  updateCheck: null,
};

/**
 * Read the file, falling back to the defaults for anything missing or unreadable.
 *
 * Every failure is swallowed to the default rather than raised. A truncated file from a
 * crash mid-write, a hand-edit with a trailing comma, a disk that is suddenly read-only —
 * none of those is a reason to refuse to open the control panel, and the worst case of the
 * fallback is that LAN sharing is off.
 */
export function readSettings(file: string): DesktopSettings {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
    const value = parsed as Record<string, unknown>;
    return {
      sharedOnLan:
        typeof value["sharedOnLan"] === "boolean" ? value["sharedOnLan"] : DEFAULT_SETTINGS.sharedOnLan,
      // Narrowed to a usable listen port; anything else (a hand-typed string, 70000) falls
      // back to the fixed default rather than being passed to the server as-is.
      port: isUserPort(value["port"]) ? value["port"] : DEFAULT_SETTINGS.port,
      // A non-string (or a blank one) is treated as "not chosen yet" rather than as a path,
      // so the panel asks. Falling back to some other directory would be the one kind of
      // tolerance this file must not have: it would point the app at data that is not the
      // user's.
      dataDir:
        typeof value["dataDir"] === "string" && value["dataDir"].trim()
          ? value["dataDir"]
          : DEFAULT_SETTINGS.dataDir,
      // Narrowed to a value this build can render, and anything else read as "follow the
      // system". That is a different question from what the choice *means* — which
      // `choosePanelLocale` owns, system versus explicit — and it is the one this file has to
      // answer, because it is the boundary where a hand-edited JSON value becomes a value the
      // rest of the program is entitled to treat as a locale.
      locale: isPanelLocaleChoice(value["locale"]) ? value["locale"] : DEFAULT_SETTINGS.locale,
      // Narrowed field by field, and a partial object throws away all of it: a cache with a
      // missing version is not half-usable, it is unusable, and "no answer" is a state the panel
      // already handles.
      updateCheck: readUpdateCheck(value["updateCheck"]),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** A cached check, or null for anything that is not a complete one. */
function readUpdateCheck(value: unknown): UpdateCheckCache | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const latestVersion = typeof v["latestVersion"] === "string" ? v["latestVersion"] : null;
  const url = typeof v["url"] === "string" ? v["url"] : null;
  const checkedAt = typeof v["checkedAt"] === "string" ? v["checkedAt"] : null;
  if (!latestVersion || !url || !checkedAt) return null;
  return { latestVersion, url, checkedAt };
}

/** Write the file, creating its directory. Throws only if the write itself fails. */
export function writeSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
