import { computed, ref } from "vue";

/**
 * Light / Dark / Auto theme.
 *
 * Pure UI state and purely client-side — the server knows nothing about it. The choice is
 * kept in `localStorage`, and the *effective* theme is communicated to CSS through a
 * `data-theme` attribute on `<html>`:
 *
 *   `light` / `dark` → forced
 *   `auto`           → resolved from `prefers-color-scheme` at render time
 *
 * `style.css` keys off that attribute, so forcing a theme and following the system are the
 * same mechanism — `auto` is just "the CSS media query decides".
 *
 * One coupling to respect: the key/values here MUST match the inline pre-paint script in
 * `index.html`, which sets the attribute before the bundle loads to avoid a flash of the
 * wrong theme on reload.
 */

export type ThemeMode = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "gl-theme";
const DATA_ATTR = "data-theme";
const ORDER: ThemeMode[] = ["light", "dark", "auto"];

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "auto") return value;
  } catch {
    // Storage can be unavailable (private browsing, disabled cookies). `auto` is a
    // sensible fallback — no crash over a cosmetic preference.
  }
  return "auto";
}

function apply(mode: ThemeMode): void {
  document.documentElement.setAttribute(DATA_ATTR, mode);
}

/* ------------------------------ reactive state ------------------------------ */

/** Module-level so every consumer (the sidebar button, future settings) agrees. */
const mode = ref<ThemeMode>(readStored());

/**
 * Whether the system currently prefers dark. Reactive so an "auto" user watching the icon
 * sees it flip live when the OS theme changes mid-session.
 */
const systemDark = ref(matchesDark());

function matchesDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

if (typeof window !== "undefined" && window.matchMedia) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    systemDark.value = media.matches;
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", onChange);
  else media.addListener(onChange);
}

/** The theme actually in force right now — what the UI should call "current". */
const resolved = computed<ResolvedTheme>(() =>
  mode.value === "auto" ? (systemDark.value ? "dark" : "light") : mode.value
);

let applied = false;

export function useTheme() {
  // Apply once. The inline script has already done it pre-paint; this keeps the runtime
  // state in lock-step with what is actually on the element (they share a key, so in
  // practice this is a no-op unless storage changed between the two).
  if (!applied) {
    apply(mode.value);
    applied = true;
  }

  function setTheme(next: ThemeMode): void {
    mode.value = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort; the in-memory theme still applies for this session.
    }
    apply(next);
  }

  /** Light → Dark → Auto → Light. A single button covers all three states. */
  function cycle(): ThemeMode {
    const current = ORDER.indexOf(mode.value);
    const next = ORDER[(current + 1) % ORDER.length]!;
    setTheme(next);
    return next;
  }

  return { mode, resolved, setTheme, cycle };
}