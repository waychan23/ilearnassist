import type { Message } from "../api/types";

/**
 * Minimap rail helpers, modelled on chatbox's `MessageMinimapRail`.
 *
 * The rail shows one anchor per *turn* — that is, per user message, paired with the
 * reply it produced.
 */

export interface MessageMinimapAnchor {
  messageId: string;
  /** Index into the rendered message list, used to jump back to the anchor. */
  itemIndex: number;
  /** Preview of the user's message. */
  text: string;
  /** Preview of the assistant's reply, when there is one. */
  assistantText?: string;
}

/** Vertical pitch between anchors, in px. */
export const MINIMAP_ITEM_HEIGHT = 12;

/** Anchors rendered beyond the visible window, so scrolling the rail does not flicker. */
const WINDOW_OVERSCAN_ITEMS = 8;
const DEFAULT_VIEWPORT_HEIGHT = 360;

/**
 * Previews show at most a few clamped lines, so anchors only need a prefix of each
 * message. Building them from the full text would re-scan the whole conversation on
 * every streaming chunk.
 */
export const MINIMAP_PREVIEW_MAX_LENGTH = 300;

/** Which slice of anchors to render for the rail's current scroll window. */
export function getMinimapRenderRange(
  anchorCount: number,
  scrollTop: number,
  viewportHeight: number
): { start: number; end: number } {
  if (anchorCount <= 0) return { start: 0, end: 0 };

  const effectiveViewportHeight = viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT;
  const firstVisibleIndex = Math.max(0, Math.floor(scrollTop / MINIMAP_ITEM_HEIGHT));
  const visibleItemCount = Math.max(1, Math.ceil(effectiveViewportHeight / MINIMAP_ITEM_HEIGHT));
  const start = Math.max(0, firstVisibleIndex - WINDOW_OVERSCAN_ITEMS);
  const end = Math.min(anchorCount, firstVisibleIndex + visibleItemCount + WINDOW_OVERSCAN_ITEMS);

  return { start, end };
}

/** Classic smoothstep — eases the magnetic widening so the rail does not look jittery. */
export function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

export function normalizePreviewText(text: string, fallback = ""): string {
  const preview = text.replace(/\s+/g, " ").trim();
  return preview || fallback;
}

/**
 * Short preview of a message for the rail. Falls back to the attachment names when the
 * user sent files with no text, so an image-only turn is not a blank anchor.
 */
export function messagePreview(message: Message, maxLength = MINIMAP_PREVIEW_MAX_LENGTH): string {
  let text = message.content.trim();
  if (!text && message.attachments?.length) {
    text = message.attachments
      .map((a) => (a.kind === "image" ? "[图片]" : `[附件：${a.name}]`))
      .join(" ");
  }
  return normalizePreviewText(text.slice(0, maxLength));
}

/** One anchor per user turn, carrying the reply that followed it. */
export function buildMinimapAnchors(messages: Message[]): MessageMinimapAnchor[] {
  const anchors: MessageMinimapAnchor[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "user") continue;

    let assistantText: string | undefined;
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (next.role === "user") break;
      if (next.role === "assistant") {
        assistantText = messagePreview(next) || undefined;
        break;
      }
    }

    anchors.push({
      messageId: message.id,
      itemIndex: i,
      text: messagePreview(message),
      assistantText,
    });
  }

  return anchors;
}
