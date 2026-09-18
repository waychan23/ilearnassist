import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeCopyClick } from "../../src/composables/codeCopy";
import { renderMarkdown } from "../../src/utils/markdown";

/**
 * The copy control's click side.
 *
 * The markup is `utils/markdown.ts`'s business and is asserted there; what is here is the state
 * machine — which element counts as the control, that a press does not also do whatever the
 * container does, and that the two feedback states are reachable. jsdom has no
 * `navigator.clipboard`, so it is stubbed rather than worked around: the failure branch is
 * reachable in a real browser too, which is exactly why the control says so.
 */

/** The markup `renderMarkdown` emits, with the code's own text inside it. */
function block(code = "const a = 1;", id = "b1"): void {
  document.body.innerHTML = `
    <div id="host">
      <pre class="hljs code-block"><button type="button" class="code-copy" data-copy-code
        data-copy-state="idle" data-idle-label="复制" data-copied-label="已复制"
        title="复制" aria-label="复制"><svg></svg><svg></svg></button><code>${code}</code></pre>
    </div>`;
  document.getElementById("host")!.dataset.host = id;
}

function button(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-copy-code]")!;
}

/** Press it, through the container — which is how the handler is wired. */
function press(target: Element = button()): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  block();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("codeCopyClick", () => {
  it("copies the block's code, not the button's own markup", async () => {
    const handled = codeCopyClick(press());

    expect(handled).toBe(true);
    // One tick for the promise the handler does not await.
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
  });

  it("copies the code alone, not the block's own header", async () => {
    /*
     * The header names the file and the language, and it lives inside the same `<pre>` as the code
     * — so it is excluded from a copy only because the handler reads `querySelector("code")` and
     * the header is spans. Built from `renderMarkdown`'s real output rather than the hand-written
     * block above, because the markup is the thing that could change: the day somebody wraps a
     * filename in a `<code>` element, the copy silently starts carrying it.
     */
    document.body.innerHTML =
      `<div id="host">` +
      renderMarkdown("```python app.py\nconst a = 1;\n```", { copy: "复制", copied: "已复制" }) +
      `</div>`;

    expect(codeCopyClick(press())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith("const a = 1;\n");
  });

  it("says it copied, then says nothing again", async () => {
    codeCopyClick(press());
    await vi.advanceTimersByTimeAsync(0);

    expect(button().dataset.copyState).toBe("copied");
    // The accessible name moves with the icon: a changed colour is not something a screen reader
    // can report, and "copied" is the whole confirmation.
    expect(button().getAttribute("aria-label")).toBe("已复制");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(button().dataset.copyState).toBe("idle");
    expect(button().getAttribute("aria-label")).toBe("复制");
  });

  it("reads its labels off the element rather than the catalog", async () => {
    /*
     * The handler has no i18n access — it is given an element, not a component — so the labels
     * travel on the button. Reading the *current* name back to restore it would capture "已复制"
     * on a second press inside the reset window, which is what `data-idle-label` is for.
     */
    codeCopyClick(press());
    await vi.advanceTimersByTimeAsync(0);
    codeCopyClick(press());
    await vi.advanceTimersByTimeAsync(0);

    expect(button().dataset.copyState).toBe("copied");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(button().getAttribute("aria-label")).toBe("复制");
  });

  it("says it failed when the clipboard refuses", async () => {
    // Reachable in a real browser — `navigator.clipboard` is absent outside a secure context —
    // and the one outcome the user cannot act on, so it is said out loud rather than swallowed.
    writeText.mockRejectedValue(new Error("denied"));

    codeCopyClick(press());
    await vi.advanceTimersByTimeAsync(0);

    expect(button().dataset.copyState).toBe("failed");
  });

  /** The real wiring: the handler on the container, the press on the button inside it. */
  function wire(handler: (event: MouseEvent) => boolean): { ancestor: ReturnType<typeof vi.fn> } {
    const ancestor = vi.fn();
    document.body.addEventListener("click", ancestor);
    document.getElementById("host")!.addEventListener("click", (event) => {
      handler(event);
    });
    return { ancestor };
  }

  it("stops a handled press reaching an ancestor's handler", () => {
    /*
     * `stopPropagation` guards *ancestors*, not siblings on the same element — the container's
     * own handler is the one calling this. In the message list there is an ancestor: the list
     * itself listens for clicks, and a press on Copy is not a press on the conversation.
     */
    const { ancestor } = wire(codeCopyClick);

    press();

    expect(ancestor).not.toHaveBeenCalled();
  });

  it("leaves a click anywhere else alone", () => {
    // The other half: an unhandled press must keep propagating, or the message list would stop
    // opening notes the moment a reply contained a code block.
    const { ancestor } = wire(codeCopyClick);
    const code = document.querySelector("code")!;

    press(code);

    expect(ancestor).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports whether it handled the press, so the caller can tell the two apart", () => {
    // The container has one handler for both behaviours — `MessageItem`'s checks this before it
    // looks for a note — so the return value is the interface, not a courtesy.
    expect(codeCopyClick(new MouseEvent("click") as MouseEvent)).toBe(false);

    const event = new MouseEvent("click", { bubbles: true });
    button().dispatchEvent(event);
    expect(codeCopyClick(event)).toBe(true);
  });
});
