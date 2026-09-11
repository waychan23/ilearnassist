import { reactive } from "vue";
import { i18n } from "../i18n";

export interface ConfirmOptions {
  title?: string;
  message: string;
  /** Secondary line spelling out the consequences, e.g. what else gets deleted. */
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  /** Renders the confirm button in red. Use for destructive actions. */
  danger?: boolean;
}

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  detail: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
}

/**
 * Resolved at call time, not at import.
 *
 * A frozen `DEFAULTS` object would capture whatever language was active when this module
 * first loaded — which is the module-load language, not the user's. `options` are resolved
 * strings once the dialog is open; see the note on `confirm()` about switching mid-prompt.
 */
function defaults() {
  return {
    title: i18n.global.t("common.confirmTitle"),
    confirmText: i18n.global.t("common.confirm"),
    cancelText: i18n.global.t("common.cancel"),
  };
}

export const confirmState = reactive<ConfirmState>({
  open: false,
  title: "",
  confirmText: "",
  cancelText: "",
  message: "",
  detail: "",
  danger: false,
});

let pending: ((value: boolean) => void) | null = null;

/**
 * Ask the user to confirm a destructive action. Resolves `true` when they accept and
 * `false` when they cancel or dismiss — so `if (await confirm(...))` reads naturally.
 *
 * Only one prompt can be open at a time; a second call resolves the first as cancelled.
 *
 * Callers pass already-resolved strings, so a prompt left open across a language switch
 * keeps the language it opened in. That is accepted rather than fixed: switching language
 * mid-confirm is not a real flow, and holding `{ key, params }` instead would change the
 * shape of every call site for it.
 */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  pending?.(false);
  pending = null;

  const fallback = defaults();
  const opts: ConfirmOptions = typeof options === "string" ? { message: options } : options;
  confirmState.open = true;
  confirmState.title = opts.title ?? fallback.title;
  confirmState.message = opts.message;
  confirmState.detail = opts.detail ?? "";
  confirmState.confirmText = opts.confirmText ?? fallback.confirmText;
  confirmState.cancelText = opts.cancelText ?? fallback.cancelText;
  confirmState.danger = opts.danger ?? false;

  return new Promise<boolean>((resolve) => {
    pending = resolve;
  });
}

/** Called by the dialog host. Resolves the open prompt and closes it. */
export function settleConfirm(value: boolean): void {
  if (!confirmState.open) return;
  confirmState.open = false;
  const resolve = pending;
  pending = null;
  resolve?.(value);
}
