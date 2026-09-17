import catalog from "./prompts.json";

/**
 * The prompt catalog: every system prompt and guidance block the server sends a model,
 * in one file, addressable by key.
 *
 * The point is legibility and tunability rather than tidiness. Before this, the text was a
 * template literal inside each module that used it, so "what does the system actually say to
 * a model" had no single answer, and changing a sentence meant editing TypeScript and
 * rebuilding. `prompts.json` is that answer, and `<dataRoot>/config.patch.json` is how a
 * deployment changes one without rebuilding — see `setPromptOverrides`.
 *
 * **Everything here is read at call time, never captured in a module constant.** That is not a
 * style preference: the patch arrives from the process entry point, which runs after every
 * module has been evaluated. A `export const THREAD_SYSTEM_PROMPT = renderPrompt(…)` would be
 * the bundled text forever, and a patched prompt would silently do nothing — the failure this
 * repository names most often.
 *
 * A **`{{name}}` placeholder** is substituted from the call's variables. The one rule worth
 * knowing: a placeholder with **no value supplied throws**, while a placeholder supplied as the
 * empty string renders as nothing. That split is deliberate — it is what lets a block be
 * *dropped* (a widget that is not installed supplies `""`) while a *typo* is loud. A prompt
 * that quietly loses a sentence is invisible; a throw is not.
 */

/** One catalog entry: what it is for, and what it says. */
export interface PromptEntry {
  /** Purpose, when it is used, and any caveat — written for whoever is tuning it. */
  description: string;
  /** The text itself, with `{{name}}` placeholders. */
  text: string;
}

export type PromptKey = keyof typeof catalog.prompts;

/**
 * Where the catalog lives, named in the error a patch typo produces.
 *
 * A path rather than a URL because this file is bundled — esbuild inlines it into
 * `dist/server/index.mjs`, and `tsc`/`vitest`/`tsx` each read it directly — so there is no
 * runtime path to show. The message names it the way a reader would look for it.
 */
export const PROMPT_CATALOG_FILE = "apps/server/src/prompts.json";

/** The bundled catalog, exactly as shipped. */
export const BUNDLED_PROMPTS: Readonly<Record<string, PromptEntry>> = catalog.prompts;

/**
 * The catalog in force: the bundle, with any patch applied.
 *
 * A copy rather than the imported object, because the imported object is a module-level
 * constant shared by every importer — mutating it would make a patch leak into the next test
 * in the same process.
 */
const active: Record<string, PromptEntry> = { ...catalog.prompts };

/** Every key in force, the bundled ones first. */
export function promptKeys(): PromptKey[] {
  return Object.keys(active) as PromptKey[];
}

/**
 * Read one entry, failing loudly on a key that does not exist.
 *
 * A missing key is a programming error rather than user input, so it throws: the type system
 * already makes a literal typo a compile error, and this covers the paths it cannot see.
 */
export function promptEntry(key: PromptKey): PromptEntry {
  const entry = active[key];
  if (!entry) {
    throw new Error(`Unknown prompt key "${key}". It is not in ${PROMPT_CATALOG_FILE}.`);
  }
  return entry;
}

/** A catalog entry's text, unrendered. */
export function promptText(key: PromptKey): string {
  return promptEntry(key).text;
}

/** What the entry is for — the half a reader tunes by. */
export function promptDescription(key: PromptKey): string {
  return promptEntry(key).description;
}

/**
 * `{{name}}` and nothing else.
 *
 * The name is restricted to an identifier so that a prompt containing literal braces — the
 * classifier's output schema is `{"decisions":[{"thread":"continue"}]}`, for instance — cannot
 * be mistaken for a placeholder. `test/prompts.test.ts` asserts that no catalog text contains
 * a `{{` this pattern does not match, which is what keeps that guarantee honest rather than
 * assumed.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/**
 * A prompt, with its placeholders filled in.
 *
 * Throws when a placeholder has no value. Passing `""` is the way to render a block out of
 * existence — that is how a guidance block for an uninstalled widget is dropped — so the
 * distinction between "no value" and "an empty value" is the whole error handling here.
 */
export function renderPrompt(key: PromptKey, vars: Record<string, string> = {}): string {
  return promptEntry(key).text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(
        `Prompt "${key}" uses {{${name}}} but no value was supplied for it. ` +
          `Pass a value for "${name}" at the call site, or remove the placeholder from ` +
          `${PROMPT_CATALOG_FILE}.`
      );
    }
    return value;
  });
}

/** A patch entry that did not take effect, and which of the two ways it failed. */
export interface PromptOverrideProblem {
  key: string;
  /** `unknown` — no such key in the catalog. `unreadable` — the value is not a string or entry. */
  reason: "unknown" | "unreadable";
}

/**
 * Apply the `prompts` section of a `config.patch.json`, returning the entries that had no effect.
 *
 * Called by the process entry point and nothing else — the same rule `configureModelLog` follows,
 * and for the same reason: the unit test suite points `ILA_DATA_DIR` at a real directory through
 * `.env`, so a patch resolved inside this module would make tests depend on whatever the machine
 * running them happens to have in its data folder. Injecting it from the entry point keeps the
 * bundled catalog the only thing a test ever sees.
 *
 * A patch entry may be a **plain string** — shorthand for `{ "text": … }`, which is what somebody
 * overriding one sentence naturally writes — or an object. A patched entry keeps the bundled
 * `description` unless the patch supplies one, because the description documents the *default*
 * and replacing the text does not invalidate it.
 *
 * Failures are **returned rather than ignored**, so the caller can warn. The two reasons are kept
 * apart because the fixes differ: an unknown key is a typo in something that will never work,
 * while an unreadable value is a key that does work with a value written in the wrong shape.
 */
export function setPromptOverrides(patch: unknown): PromptOverrideProblem[] {
  const section = isPlainObject(patch) ? patch : {};
  const problems: PromptOverrideProblem[] = [];

  for (const [key, raw] of Object.entries(section)) {
    if (!(key in BUNDLED_PROMPTS)) {
      problems.push({ key, reason: "unknown" });
      continue;
    }
    const entry = normalizeEntry(raw);
    if (!entry) {
      problems.push({ key, reason: "unreadable" });
      continue;
    }
    const bundled = BUNDLED_PROMPTS[key];
    active[key] = {
      description: entry.description ?? bundled?.description ?? "",
      text: entry.text,
    };
  }

  return problems;
}

/** Drop every override, restoring the bundled catalog. Tests only. */
export function resetPromptOverrides(): void {
  for (const key of Object.keys(active)) delete active[key];
  Object.assign(active, catalog.prompts);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A patch entry, however it was written. Null when it cannot be read at all, which the caller
 * reports as an unrecognised key rather than throwing — one malformed entry should not stop the
 * server, and it is reported either way.
 */
function normalizeEntry(raw: unknown): { text: string; description?: string } | null {
  if (typeof raw === "string") return { text: raw };
  if (!isPlainObject(raw)) return null;
  const text = raw["text"];
  if (typeof text !== "string") return null;
  const description = raw["description"];
  return typeof description === "string" ? { text, description } : { text };
}
