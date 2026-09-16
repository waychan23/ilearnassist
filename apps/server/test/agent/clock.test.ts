import { describe, expect, it } from "vitest";
import { knownTimeZone, serverTimeZone, turnClock } from "../../src/agent/clock.js";

/**
 * The turn's clock, at a pinned instant and a pinned zone.
 *
 * Pinned rather than "now", because the assertions are about a *format* and the alternative is
 * a test that passes every day except the one it is written on. The zones are chosen for what
 * they exercise rather than for being common: a whole-hour offset, a half-hour one, and one that
 * is on the other side of the date line from UTC — so a string built from the wrong zone is
 * wrong about the *day*, which is the mistake worth catching.
 */
describe("turnClock", () => {
  // 2026-09-16T06:32:00Z — the afternoon of the 16th in Shanghai, the morning of the 16th in
  // London, and still the 15th in Los Angeles.
  const now = new Date("2026-09-16T06:32:00Z");

  it("states the local date, time and weekday in the user's zone", () => {
    expect(turnClock(now, "Asia/Shanghai")).toEqual({
      local: "Wednesday, 2026-09-16 14:32",
      zone: "Asia/Shanghai, UTC+08:00",
    });
  });

  it("puts the day where the zone puts it, not where UTC does", () => {
    // The same instant, west of UTC: a formatting bug that ignores the zone would say the 16th.
    expect(turnClock(now, "America/Los_Angeles")).toEqual({
      local: "Tuesday, 2026-09-15 23:32",
      zone: "America/Los_Angeles, UTC-07:00",
    });
  });

  it("carries a non-hour offset through", () => {
    // `Asia/Kolkata` is +05:30. An implementation that rounded to the hour would be half an
    // hour wrong for a fifth of the world, and the date would still look right.
    expect(turnClock(now, "Asia/Kolkata")).toEqual({
      local: "Wednesday, 2026-09-16 12:02",
      zone: "Asia/Kolkata, UTC+05:30",
    });
  });

  it("derives the offset from the zone at that instant, not from a fixed table", () => {
    /*
     * The reason the wire carries a zone *name* rather than an offset. London is UTC+01:00 in
     * September and UTC+00:00 in January, and both of these are the same zone.
     */
    const winter = new Date("2026-01-16T06:32:00Z");
    expect(turnClock(now, "Europe/London").zone).toBe("Europe/London, UTC+01:00");
    expect(turnClock(winter, "Europe/London").zone).toBe("Europe/London, UTC+00:00");
  });

  it("falls back to the server's own zone rather than failing the turn", () => {
    // A browser that sent nothing, a script, an older client — and, the one that matters, a
    // body carrying a zone this ICU does not know.
    const fallback = turnClock(now, "Mars/Olympus_Mons");
    const server = serverTimeZone();

    expect(fallback.zone.startsWith(`${server}, UTC`)).toBe(true);
    expect(fallback).toEqual(turnClock(now));
  });
});

describe("knownTimeZone", () => {
  it("accepts a zone the runtime knows, and nothing else", () => {
    expect(knownTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    for (const bad of ["Mars/Olympus_Mons", "", "x".repeat(200), 42, null, undefined, {}]) {
      expect(knownTimeZone(bad)).toBeUndefined();
    }
  });
});
