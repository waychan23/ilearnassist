import { describe, expect, it } from "vitest";
import { autosizeTextarea } from "../../src/utils/autosize.js";

/**
 * A real textarea measures its content; jsdom will not, so these drive a stand-in whose
 * `scrollHeight` is a function of its own `style.height`.
 *
 * The stand-in is not merely a substitute for a missing engine — it is what makes the one
 * subtle thing here observable. `scrollHeight` answers "what does the element need *at its
 * current height*", not "what does the content need", so a stand-in that reports a sensible
 * number only while the height is cleared fails the moment that reset is dropped from the
 * implementation. That is the mistake worth catching: it leaves a box that grows to fit a
 * long note and then never comes back down.
 */
function box(contentPx: number) {
  const el = {
    style: { height: "80px" },
    get scrollHeight() {
      return this.style.height === "auto" ? contentPx : 9999;
    },
  };
  return el as unknown as HTMLTextAreaElement & { style: { height: string } };
}

describe("autosizeTextarea", () => {
  it("sizes the box to its content", () => {
    const el = box(40);
    autosizeTextarea(el);
    expect(el.style.height).toBe("40px");
  });

  it("clears the height before measuring, so the box can shrink too", () => {
    // The order is the load-bearing part, so this watches the writes rather than their
    // result: `auto` first, then whatever the cleared box reported it needed.
    const writes: string[] = [];
    const el = {
      style: {
        get height(): string {
          return writes.at(-1) ?? "";
        },
        set height(value: string) {
          writes.push(value);
        },
      },
      get scrollHeight(): number {
        // Only a cleared height measures the content; otherwise the element reports itself.
        return writes.at(-1) === "auto" ? 40 : 9999;
      },
    };

    autosizeTextarea(el as unknown as HTMLTextAreaElement);

    expect(writes).toEqual(["auto", "40px"]);
  });

  it("caps the height and leaves the rest to scroll", () => {
    const el = box(5000);
    autosizeTextarea(el);
    expect(el.style.height).toBe("200px");
  });

  it("takes a caller's own cap", () => {
    const el = box(5000);
    autosizeTextarea(el, 120);
    expect(el.style.height).toBe("120px");
  });

  it("leaves a box under the cap exactly as tall as it needs", () => {
    // Otherwise the cap would be a floor for everything near it.
    const el = box(199);
    autosizeTextarea(el);
    expect(el.style.height).toBe("199px");
  });
});
