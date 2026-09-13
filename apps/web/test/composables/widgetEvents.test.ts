import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitWidgetEvent,
  subscribeWidgetEvents,
  type WidgetEvent,
} from "../../src/composables/widgetEvents.js";

/*
 * The bus is a singleton whose subscribers outlive a test, so every test unsubscribes — or it
 * would be testing a set that the previous test left something in.
 */

const TURN: WidgetEvent = { type: "turn.finished", sessionId: "s1" };

let unsubscribe: (() => void) | null = null;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.restoreAllMocks();
});

describe("the widget event bus", () => {
  it("delivers to a subscriber", () => {
    const seen: WidgetEvent[] = [];
    unsubscribe = subscribeWidgetEvents((e) => seen.push(e));

    emitWidgetEvent(TURN);

    expect(seen).toEqual([TURN]);
  });

  it("delivers to every subscriber, in subscription order", () => {
    const first: string[] = [];
    const second: string[] = [];
    const offFirst = subscribeWidgetEvents(() => first.push("a"));
    const offSecond = subscribeWidgetEvents(() => second.push("b"));
    unsubscribe = () => {
      offFirst();
      offSecond();
    };

    emitWidgetEvent(TURN);

    expect(first).toEqual(["a"]);
    expect(second).toEqual(["b"]);
  });

  it("stops delivering once unsubscribed", () => {
    // What `onBeforeUnmount` is for: a subscription is not scoped to a component the way a
    // `watch` is, so this is the only thing standing between a closed tab and a handler that
    // keeps being called.
    const seen: WidgetEvent[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e));

    emitWidgetEvent(TURN);
    off();
    emitWidgetEvent(TURN);

    expect(seen).toEqual([TURN]);
  });

  it("keeps delivering to the others when one subscriber throws", () => {
    /*
     * The publisher is the store, mid-turn, so a widget's bug must not become a turn's bug — and
     * the subscriber *after* the broken one is the case that matters: without the guard, one
     * widget's mistake would silently stop every other widget from updating.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: WidgetEvent[] = [];
    const offBroken = subscribeWidgetEvents(() => {
      throw new Error("widget bug");
    });
    const offGood = subscribeWidgetEvents((e) => seen.push(e));
    unsubscribe = () => {
      offBroken();
      offGood();
    };

    expect(() => emitWidgetEvent(TURN)).not.toThrow();
    expect(seen).toEqual([TURN]);
    expect(warn).toHaveBeenCalled();
  });

  it("is a no-op with no subscribers", () => {
    expect(() => emitWidgetEvent(TURN)).not.toThrow();
  });

  it("delivers to subscribers that unsubscribed during delivery only once", () => {
    // Copying the set before walking it, so a handler that removes itself from inside itself
    // does not shorten the list being iterated — which would skip whichever handler came next.
    const seen: string[] = [];
    const off = subscribeWidgetEvents(() => {
      seen.push("first");
      off();
    });
    const offSecond = subscribeWidgetEvents(() => seen.push("second"));
    // Assigned *after* `off` is referenced above; the closure reads it at call time.
    unsubscribe = offSecond;

    emitWidgetEvent(TURN);

    expect(seen).toEqual(["first", "second"]);
  });
});
