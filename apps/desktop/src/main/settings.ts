import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
}

export const DEFAULT_SETTINGS: DesktopSettings = { sharedOnLan: false };

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
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Write the file, creating its directory. Throws only if the write itself fails. */
export function writeSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
