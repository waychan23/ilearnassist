import { i18n } from "../i18n";
import { formatRelativeTime } from "../utils/format";

/**
 * A timestamp as "3 分钟前", from the shared `time.*` catalog keys.
 *
 * `formatRelativeTime` returns a *description* rather than a sentence on purpose — `utils/format.ts`
 * has no i18n — so the wording has to come from here, and the buckets have to be worded the same
 * way wherever they are shown. The workspace cards were the first site; the file lists are the
 * second, which is why this is a module rather than a function inside the card's component. A key
 * per surface would be the same sentence written twice, in two languages.
 *
 * Through `i18n.global.t` rather than `useI18n()`, like `composables/confirm.ts` and `stores/app.ts`:
 * this is called from render helpers in more than one component, and a composable that needs a
 * component instance cannot be one of them.
 *
 * `en` branches on the count where `zh-CN` does not ("1 minute ago | {count} minutes ago" against
 * a single "{count} 分钟前"), which is why the count goes in as the plural argument and the call
 * shape is identical for both.
 */
export function relativeTime(iso: string): string {
  const rel = formatRelativeTime(iso);
  switch (rel.kind) {
    case "now":
      return i18n.global.t("time.now");
    case "minutes":
      return i18n.global.t("time.minutes", { count: rel.count }, rel.count);
    case "hours":
      return i18n.global.t("time.hours", { count: rel.count }, rel.count);
    case "days":
      return i18n.global.t("time.days", { count: rel.count }, rel.count);
    /* Past a week it is a bare date, and there is nothing to say about it beyond the value —
       which is why this branch has no catalog entry. */
    case "date":
      return rel.value;
  }
}
