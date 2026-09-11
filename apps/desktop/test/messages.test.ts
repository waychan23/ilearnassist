import { describe, expect, it } from "vitest";
import {
  PANEL_LOCALES,
  PANEL_MESSAGES,
  describeFault,
  resolvePanelLocale,
  translate,
} from "../src/shared/messages.js";

/**
 * Guards on the panel's strings.
 *
 * The same shape as `apps/web/test/i18n/`, scaled to two dozen keys: the type system already
 * proves both catalogs declare the same keys, so what is left is the part it cannot see —
 * a value left empty, or English that still contains Chinese.
 */

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿]/;

describe("resolvePanelLocale", () => {
  it("treats any Chinese tag as Simplified Chinese", () => {
    for (const tag of ["zh", "zh-CN", "zh-Hans-CN", "zh_CN", "ZH-TW"]) {
      expect(resolvePanelLocale(tag)).toBe("zh-CN");
    }
  });

  it("treats any English tag as English", () => {
    for (const tag of ["en", "en-US", "en-GB"]) {
      expect(resolvePanelLocale(tag)).toBe("en");
    }
  });

  it("falls back to English for anything it does not ship", () => {
    // Not "the closest match" — a wrong language is worse than a lingua franca, and the
    // panel has no language switcher to recover with.
    for (const tag of ["fr-FR", "ja", "", undefined]) {
      expect(resolvePanelLocale(tag)).toBe("en");
    }
  });
});

describe("catalogs", () => {
  it("has no empty values", () => {
    for (const locale of PANEL_LOCALES) {
      for (const [key, value] of Object.entries(PANEL_MESSAGES[locale])) {
        expect(value.trim(), `${locale}: ${key}`).not.toBe("");
      }
    }
  });

  it("leaves no untranslated Chinese in the English catalog", () => {
    for (const [key, value] of Object.entries(PANEL_MESSAGES.en)) {
      expect(CJK.test(value), `en: ${key} = ${value}`).toBe(false);
    }
  });

  it("uses the same placeholders in both catalogs", () => {
    // A `{message}` that survives into the Chinese string but not the English one renders
    // a literal brace to the user, and only in one language — the kind of thing a
    // screenshot review misses.
    const names = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const key of Object.keys(PANEL_MESSAGES.en) as (keyof typeof PANEL_MESSAGES.en)[]) {
      expect(names(PANEL_MESSAGES["zh-CN"][key]), key).toEqual(names(PANEL_MESSAGES.en[key]));
    }
  });
});

describe("translate", () => {
  it("substitutes named values", () => {
    expect(translate(PANEL_MESSAGES.en, "fault.timeout", { seconds: 30 })).toContain("30");
  });

  it("renders the key when it is missing, rather than an empty string", () => {
    // An empty label is a mystery; a visible `action.nope` is a bug report.
    const missing = "action.nope" as keyof typeof PANEL_MESSAGES.en;
    expect(translate(PANEL_MESSAGES.en, missing)).toBe("action.nope");
  });

  it("leaves an unfilled placeholder alone instead of printing undefined", () => {
    expect(translate(PANEL_MESSAGES.en, "fault.timeout")).toContain("{seconds}");
  });
});

describe("describeFault", () => {
  it("names the exit code of a crash", () => {
    const text = describeFault(PANEL_MESSAGES.en, { code: "exited", exitCode: 1, signal: null });
    expect(text).toContain("1");
  });

  it("names the signal when there is no exit code", () => {
    const text = describeFault(PANEL_MESSAGES.en, { code: "exited", exitCode: null, signal: "SIGKILL" });
    expect(text).toContain("SIGKILL");
  });

  it("says so when there is neither", () => {
    const text = describeFault(PANEL_MESSAGES.en, { code: "exited", exitCode: null, signal: null });
    expect(text).toContain("unknown");
  });

  it("passes the operating system's own wording through for a spawn failure", () => {
    const text = describeFault(PANEL_MESSAGES.en, { code: "spawn_failed", message: "ENOENT" });
    expect(text).toContain("ENOENT");
  });

  it("covers every fault in both languages", () => {
    for (const locale of PANEL_LOCALES) {
      for (const fault of [
        { code: "exited", exitCode: 1, signal: null },
        { code: "exited", exitCode: null, signal: "SIGTERM" },
        { code: "exited", exitCode: null, signal: null },
        { code: "timeout", seconds: 30 },
        { code: "spawn_failed", message: "ENOENT" },
      ] as const) {
        const text = describeFault(PANEL_MESSAGES[locale], fault);
        expect(text, `${locale} ${fault.code}`).not.toContain("{");
      }
    }
  });
});
