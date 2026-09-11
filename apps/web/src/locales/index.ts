import en from "./en";
import zhCN from "./zh-CN";
import type { Locale } from "../utils/locale";

/** Every catalog we ship, keyed by locale tag. Adding a language starts here. */
export const catalogs: Record<Locale, typeof zhCN> = {
  "zh-CN": zhCN,
  en,
};

/** The shape every catalog must satisfy — `zh-CN` defines it. */
export type MessageSchema = typeof zhCN;
