/**
 * What time it is, where the user is.
 *
 * Every turn's system prompt states the current date, time and timezone, and this is the whole
 * of how that string is built. The reason is a failure mode rather than a nicety: a model asked
 * about "today" without being told the date answers from the most recent date it saw in
 * training, which is confident, plausible and wrong — and wrong in a way nothing in the reply
 * reveals. The date is therefore *given* on every turn rather than left to be inferred.
 *
 * Two decisions are worth stating, because both could reasonably have gone the other way:
 *
 * - **The zone is a name, and the offset is derived here.** `Asia/Shanghai` rather than
 *   `+08:00`, so a browser left open across a daylight-saving boundary still gets the right hour
 *   — the offset is computed from the zone at the moment the turn runs, not sent by a page that
 *   read it once when it loaded.
 * - **The instant comes from the server**, not from the client. The client's clock is the same
 *   machine's in the desktop app and a phone's otherwise, and two opinions about "now" is one
 *   more than a turn needs. The browser contributes the *zone*; the server contributes the time.
 *
 * Everything here is pure and takes its inputs explicitly, which is what lets the formatting be
 * tested at a pinned instant and a pinned zone instead of at whatever today happens to be.
 */

export interface TurnClock {
  /** The local date and time, e.g. `Friday, 2026-09-16 14:32`. */
  local: string;
  /** Where that is, e.g. `Asia/Shanghai, UTC+08:00`. */
  zone: string;
}

/**
 * A zone the runtime recognises, or `undefined`.
 *
 * A request body is not a trust boundary for much, but it is one for this: `Intl` throws a
 * `RangeError` on a name it does not know, and a thrown error here would fail the turn. An
 * unrecognised zone is dropped to the server's own, which is the same answer as not sending one.
 */
export function knownTimeZone(timeZone: unknown): string | undefined {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** The server's own zone, for a turn that did not name one. */
export function serverTimeZone(): string | undefined {
  return knownTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * `now` as the user would say it, in `timeZone` when one is given.
 *
 * `en-CA` for the date parts because it is the locale whose numeric form is ISO-8601 — the one
 * ordering a model cannot read ambiguously. The weekday is spelled out anyway, since a model
 * asked about "this Friday" is much better served by a name than by having to compute one.
 */
export function turnClock(now: Date, timeZone?: string): TurnClock {
  const zone = knownTimeZone(timeZone) ?? serverTimeZone();
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  };

  // An absent zone is not an error: `Intl` then uses the runtime's own, which is the same
  // answer `serverTimeZone()` just gave.
  const at = zone ? { ...options, timeZone: zone } : options;
  const parts = new Intl.DateTimeFormat("en-CA", at).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  // `formatToParts` gives 24 as the hour for midnight under `hour12: false` in some ICU
  // versions; `24:05` reads as the wrong end of the day to a model and to a person.
  const hour = get("hour") === "24" ? "00" : get("hour");

  return {
    local: `${get("weekday")}, ${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`,
    zone: zone
      ? `${zone}, ${offsetLabel(now, zone)}`
      : offsetLabel(now, undefined),
  };
}

/**
 * `UTC+08:00` for the zone at this instant — the offset itself, spelled the way a person would.
 *
 * Read back out of `longOffset` rather than computed from `getTimezoneOffset()`, which reports
 * the *runtime's* zone and not the one asked for: the question here is what the offset is in
 * `Asia/Kolkata`, and the runtime has no opinion about that.
 *
 * ICU spells this in terms of GMT, and spells a *zero* offset as a bare `GMT` with no `+00:00`.
 * Both are relabelled, because the rest of the string says UTC and because a model reading
 * `UTC+HH:MM` in every other case would have to notice that this one is a different shape.
 */
function offsetLabel(now: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "longOffset",
    ...(timeZone ? { timeZone: timeZone } : {}),
  }).formatToParts(now);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  if (name === "GMT" || name === "UTC") return "UTC+00:00";
  return name.replace(/^GMT/, "UTC");
}
