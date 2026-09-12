import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../src/i18n.js";
import type { Message } from "@ilearnassist/shared";
import {
  MINIMAP_ITEM_HEIGHT,
  buildMinimapAnchors,
  getMinimapRenderRange,
  messagePreview,
  normalizePreviewText,
  smoothstep,
} from "../../src/utils/minimap.js";

// `messagePreview` emits translated attachment placeholders, and jsdom's navigator is
// en-US — so pin the locale rather than let the ambient one decide the expected text.
beforeEach(() => {
  i18n.global.locale.value = "zh-CN";
});

function message(overrides: Partial<Message> & Pick<Message, "role">): Message {
  return {
    id: `m${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    content: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("getMinimapRenderRange", () => {
  it("returns an empty range when there is nothing to show", () => {
    expect(getMinimapRenderRange(0, 0, 360)).toEqual({ start: 0, end: 0 });
  });

  it("covers the visible window plus an overscan on both sides", () => {
    // 360px viewport / 12px pitch = 30 visible items; scrollTop 1200 → first index 100.
    const { start, end } = getMinimapRenderRange(500, 1200, 360);
    expect(start).toBe(100 - 8);
    expect(end).toBe(100 + 30 + 8);
  });

  it("never starts before zero", () => {
    expect(getMinimapRenderRange(100, 0, 360).start).toBe(0);
  });

  it("renders only the window, not everything after it", () => {
    // 30 visible + 8 overscan; the remaining anchors are left unrendered by design.
    expect(getMinimapRenderRange(50, 0, 360).end).toBe(38);
  });

  it("never runs past the last anchor", () => {
    expect(getMinimapRenderRange(10, 0, 360).end).toBe(10);
  });

  it("falls back to a default viewport height of zero or negative", () => {
    expect(getMinimapRenderRange(500, 0, 0).end).toBe(getMinimapRenderRange(500, 0, 360).end);
    expect(getMinimapRenderRange(500, 0, -10).end).toBe(getMinimapRenderRange(500, 0, 360).end);
  });

  it("always renders at least one item", () => {
    expect(getMinimapRenderRange(10, 0, 1).end).toBeGreaterThan(0);
  });

  it("uses the exported item pitch", () => {
    expect(MINIMAP_ITEM_HEIGHT).toBe(12);
  });
});

describe("smoothstep", () => {
  it("is clamped at both ends", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
  });

  it("is symmetric about the midpoint", () => {
    expect(smoothstep(0.5)).toBeCloseTo(0.5);
    expect(smoothstep(0.25) + smoothstep(0.75)).toBeCloseTo(1);
  });

  it("eases in and out", () => {
    expect(smoothstep(0.1)).toBeLessThan(0.1);
    expect(smoothstep(0.9)).toBeGreaterThan(0.9);
  });
});

describe("normalizePreviewText", () => {
  it("collapses whitespace so a label cannot wrap", () => {
    expect(normalizePreviewText("a\n\n  b\t c")).toBe("a b c");
  });

  it("uses the fallback when there is nothing left", () => {
    expect(normalizePreviewText("   ", "fallback")).toBe("fallback");
    expect(normalizePreviewText("", "fallback")).toBe("fallback");
  });
});

describe("messagePreview", () => {
  it("trims and flattens the content", () => {
    expect(messagePreview(message({ role: "user", content: "  hello \n world  " }))).toBe("hello world");
  });

  it("clips long content", () => {
    expect(messagePreview(message({ role: "user", content: "x".repeat(1000) }))).toHaveLength(300);
  });

  it("falls back to attachment names when there is no text", () => {
    // An image-only turn must still produce a visible anchor.
    const preview = messagePreview(
      message({
        role: "user",
        attachments: [
          { id: "a1", name: "shot.png", mimeType: "image/png", size: 1, kind: "image" },
          { id: "a2", name: "notes.md", mimeType: "text/markdown", size: 1, kind: "file" },
        ],
      })
    );
    expect(preview).toBe("[图片] [附件：notes.md]"); // pinned to zh-CN below
  });

  it("prefers the text when both are present", () => {
    const preview = messagePreview(
      message({
        role: "user",
        content: "look at this",
        attachments: [{ id: "a1", name: "shot.png", mimeType: "image/png", size: 1, kind: "image" }],
      })
    );
    expect(preview).toBe("look at this");
  });
});

describe("buildMinimapAnchors", () => {
  it("creates one anchor per user turn, paired with its reply", () => {
    const anchors = buildMinimapAnchors([
      message({ id: "u1", role: "user", content: "first question" }),
      message({ id: "a1", role: "assistant", content: "first answer" }),
      message({ id: "u2", role: "user", content: "second question" }),
      message({ id: "a2", role: "assistant", content: "second answer" }),
    ]);

    expect(anchors).toEqual([
      { messageId: "u1", itemIndex: 0, text: "first question", assistantText: "first answer" },
      { messageId: "u2", itemIndex: 2, text: "second question", assistantText: "second answer" },
    ]);
  });

  it("indexes into the rendered message list, not into the anchor list", () => {
    const anchors = buildMinimapAnchors([
      message({ role: "assistant", content: "orphan reply" }),
      message({ id: "u1", role: "user", content: "q" }),
    ]);
    expect(anchors[0]!.itemIndex).toBe(1);
  });

  it("leaves assistantText undefined when the turn has no reply yet", () => {
    const anchors = buildMinimapAnchors([message({ id: "u1", role: "user", content: "unanswered" })]);
    expect(anchors[0]!.assistantText).toBeUndefined();
  });

  it("takes only the first assistant message of each turn", () => {
    // A turn that used tools has tool-only assistant rows; only the first reply counts.
    const anchors = buildMinimapAnchors([
      message({ id: "u1", role: "user", content: "q" }),
      message({ role: "assistant", content: "the reply" }),
      message({ role: "assistant", content: "a later note" }),
    ]);
    expect(anchors[0]!.assistantText).toBe("the reply");
  });

  it("returns nothing for an empty conversation", () => {
    expect(buildMinimapAnchors([])).toEqual([]);
  });
});
