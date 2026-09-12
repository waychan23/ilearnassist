import type { FastifyReply } from "fastify";
import type { ChatStreamEvent } from "@ilearnassist/shared";

/**
 * Minimal Server-Sent Events writer built directly on the Node response.
 * Uses `event: <name>` + `data: <json>` framing so any standard SSE parser
 * (or the fetch-based reader in the web client) can consume the stream.
 */
export function createSseWriter(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  reply.raw.flushHeaders?.();

  // A chat stream can outlive the client that asked for it: the user stops the turn, or
  // closes the tab, and the socket is gone while the turn is still unwinding. Node reports
  // that by emitting on the response, and with nothing listening it surfaces as an uncaught
  // exception. A transport error here only ever means "nobody is reading any more" — which
  // `gone()` below already answers by going quiet — so there is nothing to escalate.
  reply.raw.on("error", () => {});

  let ended = false;

  /** Whether the response can still take a write: not ended here, and not torn down below. */
  const gone = () => ended || reply.raw.destroyed || reply.raw.writableEnded;

  return {
    send(event: ChatStreamEvent) {
      if (gone()) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      if (gone()) return;
      ended = true;
      reply.raw.end();
    },
  };
}