import { reactive } from "vue";

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

const DEFAULTS = {
  title: "确认操作",
  confirmText: "确认",
  cancelText: "取消",
};

export const confirmState = reactive<ConfirmState>({
  open: false,
  ...DEFAULTS,
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
 */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  pending?.(false);
  pending = null;

  const opts: ConfirmOptions = typeof options === "string" ? { message: options } : options;
  confirmState.open = true;
  confirmState.title = opts.title ?? DEFAULTS.title;
  confirmState.message = opts.message;
  confirmState.detail = opts.detail ?? "";
  confirmState.confirmText = opts.confirmText ?? DEFAULTS.confirmText;
  confirmState.cancelText = opts.cancelText ?? DEFAULTS.cancelText;
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
