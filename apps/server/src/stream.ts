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

  let ended = false;
  return {
    send(event: ChatStreamEvent) {
      if (ended) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      if (ended) return;
      ended = true;
      reply.raw.end();
    },
  };
}