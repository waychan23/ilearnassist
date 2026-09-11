/** Human-readable byte size, e.g. 1024 → "1.0 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Compact token count, e.g. 12_345 → "12.3k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Which bucket a timestamp falls into, for the workspace cards' "last active" line.
 *
 * A description rather than a sentence: this module has no i18n, and the wording has to come
 * from the catalogs — which is also what keeps the `en` plural branches honest. A `count` of
 * 1 is the case the two languages disagree about, so the call site passes it straight
 * through as the plural argument.
 *
 * The buckets stop at a week. Past that "43 days ago" is a number the reader has to convert
 * back into a date, so it becomes the date.
 *
 * The date branch is a plain ISO day rather than a localised one. `i18n.ts` documents the
 * absence of `datetimeFormats` deliberately, and one date on one card is not the reason to
 * introduce a whole second catalog structure.
 */
export type RelativeTime =
  | { kind: "now" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "days"; count: number }
  | { kind: "date"; value: string };

export function formatRelativeTime(iso: string, now: number = Date.now()): RelativeTime {
  const then = Date.parse(iso);
  // An unparseable timestamp is a server bug, not a user-facing state. "Just now" would be
  // a lie dressed as a fallback, so this shows what actually arrived.
  if (Number.isNaN(then)) return { kind: "date", value: iso };

  /*
   * Clamped at zero, so a server clock a little ahead of the browser reports "just now"
   * rather than a negative age. The two are on the same machine in every supported setup,
   * but skew between them is not something the card should be able to render as "-3 minutes".
   */
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return { kind: "now" };

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { kind: "minutes", count: minutes };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "hours", count: hours };

  const days = Math.floor(hours / 24);
  if (days < 7) return { kind: "days", count: days };

  return { kind: "date", value: iso.slice(0, 10) };
}

/**
 * Rough token estimate for text that has not been sent yet. `chars / 4` is the
 * long-standing OpenAI rule of thumb for English; CJK is closer to 1 token per
 * character, so it deliberately under-counts — this only drives a pre-send preview,
 * never billing or truncation.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // i18n-exempt: a character range for token estimation, not user-facing copy.
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}
