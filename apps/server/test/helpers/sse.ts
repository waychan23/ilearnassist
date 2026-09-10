import type { ChatStreamEvent } from "@guided-learning/shared";

/**
 * Parse an `event: <type>\ndata: <json>\n\n` transcript into typed events.
 *
 * Mirrors the framing rules the browser client implements in
 * `apps/web/src/api/client.ts` (`sseEvents`), so a test asserting on the server's
 * output is also asserting that the two sides agree on the wire format.
 */
export function parseSse(transcript: string): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  for (const block of transcript.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as ChatStreamEvent);
    } catch {
      // Malformed frames are skipped, exactly as the client does.
    }
  }
  return events;
}

/** Just the event names, in order — handy for sequence assertions. */
export function eventTypes(transcript: string): string[] {
  return parseSse(transcript).map((e) => e.type);
}
