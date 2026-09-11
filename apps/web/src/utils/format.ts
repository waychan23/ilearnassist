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
