import http from "node:http";
import { pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";

/**
 * A scriptable stand-in for a cloud document parser, speaking all three protocols the
 * server implements.
 *
 * The point is the same as `fakeLlm.ts`: the *real* driver code runs — presigned uploads,
 * job polling, ZIP extraction, Bearer auth, error mapping — against a service we control,
 * with no network and no account at any vendor. A test that stubbed the driver out would
 * prove nothing about the part most likely to be wrong.
 *
 * Used two ways:
 *   - in-process: `const parser = await startFakeParser()` from a Vitest test
 *   - standalone: `tsx test/helpers/fakeParser.ts --port 3802`, driven over HTTP via
 *     `POST /__script` — which is how you point the real UI at a mock provider when you
 *     want to click through the whole flow before wiring up a real one.
 *
 * Routes, by protocol:
 *   sync        POST <anything>              → Markdown, or a JSON envelope
 *   mineru      POST /api/v4/file-urls/batch → { data: { batch_id, file_urls } }
 *               PUT  /upload/<batchId>       → the bytes
 *               GET  /api/v4/extract-results/batch/<batchId> → state, then full_zip_url
 *               GET  /result/<batchId>.zip   → a ZIP holding full.md
 *   llamaparse  POST /api/v2/parse/upload    → { id }
 *               GET  /api/v2/parse/<id>      → { status, markdown }
 */

export interface FakeParserFailure {
  status: number;
  body?: string;
}

export interface FakeParserOptions {
  port?: number;
  /** The Markdown/text every protocol returns. */
  text?: string;
  /** How many polls an async job reports "still running" before finishing. */
  pollsBeforeDone?: number;
  /** Fail every parse request with this status. Auth is checked first. */
  failWith?: FakeParserFailure | null;
  /** When set, a request must carry `Authorization: Bearer <key>` or get a 401. */
  expectedApiKey?: string;
  /** Answer `sync` requests with a JSON envelope instead of raw Markdown. */
  jsonResponse?: boolean;
  /** Artificial latency before a parse response. */
  delayMs?: number;
}

export interface ParserRequest {
  method: string;
  url: string;
  authorization?: string;
  contentType?: string;
  /** Raw request body — multipart included, so a test can assert the file was sent. */
  body: string;
}

export interface FakeParser {
  readonly baseURL: string;
  readonly port: number;
  setText(text: string): void;
  setPolls(n: number): void;
  setFailure(failure: FakeParserFailure | null): void;
  /** Every request received, oldest first. */
  requests(): ParserRequest[];
  reset(): void;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: string, type = "application/json"): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

export async function startFakeParser(options: FakeParserOptions = {}): Promise<FakeParser> {
  let text = options.text ?? "# Fake parsed document\n\nHello from the fake parser.";
  let pollsBeforeDone = options.pollsBeforeDone ?? 0;
  let failWith = options.failWith ?? null;
  let jsonResponse = options.jsonResponse ?? false;

  /** How many times each async job has been polled. */
  const polls = new Map<string, number>();
  const seen: ParserRequest[] = [];

  let issued = 0;

  /**
   * Allocate a job id and register it, so polling it is meaningful.
   *
   * Registering at creation is what makes the "unknown id" path mean what it should: on
   * the real APIs a 404 is reserved for an id the service never issued, which is exactly
   * what a connection probe relies on.
   */
  const newJobId = (): string => {
    const id = `job-${(issued += 1)}`;
    polls.set(id, 0);
    return id;
  };

  /** Count a poll and report whether the job is done yet. */
  const tick = (jobId: string): boolean => {
    const count = polls.get(jobId) ?? 0;
    polls.set(jobId, count + 1);
    return count >= pollsBeforeDone;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      if (url.startsWith("/__script")) {
        try {
          const body = JSON.parse(raw.toString("utf8") || "{}") as {
            text?: string;
            polls?: number;
            failWith?: FakeParserFailure | null;
            jsonResponse?: boolean;
          };
          if (body.text !== undefined) text = body.text;
          if (body.polls !== undefined) pollsBeforeDone = body.polls;
          if (body.failWith !== undefined) failWith = body.failWith;
          if (body.jsonResponse !== undefined) jsonResponse = body.jsonResponse;
          send(res, 200, JSON.stringify({ ok: true }));
        } catch {
          send(res, 400, JSON.stringify({ error: "invalid script" }));
        }
        return;
      }
      if (url.startsWith("/__requests")) {
        send(res, 200, JSON.stringify(seen));
        return;
      }
      if (url === "/__reset") {
        seen.length = 0;
        polls.clear();
        send(res, 200, JSON.stringify({ ok: true }));
        return;
      }

      const authorization = req.headers.authorization;
      seen.push({
        method,
        url,
        authorization: typeof authorization === "string" ? authorization : undefined,
        contentType: req.headers["content-type"] as string | undefined,
        body: raw.toString("utf8"),
      });

      // Auth is evaluated before anything else, so a wrong key always looks like a wrong
      // key rather than a malformed request.
      if (options.expectedApiKey && authorization !== `Bearer ${options.expectedApiKey}`) {
        send(res, 401, JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (failWith) {
        send(res, failWith.status, failWith.body ?? JSON.stringify({ error: "scripted failure" }));
        return;
      }
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }

      /* ------------------------------- sync driver ------------------------------- */
      if (method === "POST" && !url.startsWith("/api/")) {
        if (jsonResponse) {
          send(res, 200, JSON.stringify({ status: "ok", document: { markdown: text } }));
        } else {
          send(res, 200, text, "text/markdown");
        }
        return;
      }

      /* ------------------------------ mineru driver ------------------------------ */
      if (url === "/api/v4/file-urls/batch" && method === "POST") {
        let payload: { files?: unknown[] } = {};
        try {
          payload = JSON.parse(raw.toString("utf8") || "{}") as { files?: unknown[] };
        } catch {
          /* handled by the emptiness check below */
        }
        // No files is the probe's deliberately-invalid call: it must be rejected on its
        // content, and *not* with a 401, which is what the probe reads as bad credentials.
        if (!Array.isArray(payload.files) || payload.files.length === 0) {
          send(res, 400, JSON.stringify({ code: 400, msg: "files is required" }));
          return;
        }
        const batchId = newJobId();
        send(
          res,
          200,
          JSON.stringify({
            code: 0,
            data: { batch_id: batchId, file_urls: [`${baseURL()}/upload/${batchId}`] },
          })
        );
        return;
      }
      if (method === "PUT" && url.startsWith("/upload/")) {
        send(res, 200, JSON.stringify({ ok: true }));
        return;
      }
      const mineruPoll = /^\/api\/v4\/extract-results\/batch\/(.+)$/.exec(url);
      if (mineruPoll) {
        const batchId = mineruPoll[1]!;
        if (!polls.has(batchId)) {
          // An unknown batch is what a wrong host/version looks like.
          send(res, 404, JSON.stringify({ code: 404, msg: "batch not found" }));
          return;
        }
        const done = tick(batchId);
        send(
          res,
          200,
          JSON.stringify({
            code: 0,
            data: {
              batch_id: batchId,
              extract_result: [
                done
                  ? { state: "done", full_zip_url: `${baseURL()}/result/${batchId}.zip` }
                  : { state: "running", extract_progress: { extracted_pages: 1 } },
              ],
            },
          })
        );
        return;
      }
      const zipResult = /^\/result\/(.+)\.zip$/.exec(url);
      if (zipResult) {
        // A real ZIP, so the driver's archive extraction runs for real.
        const archive = zipSync({ "full.md": strToU8(text) });
        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(Buffer.from(archive));
        return;
      }

      /* ---------------------------- llamaparse driver ---------------------------- */
      if (url === "/api/v2/parse/upload" && method === "POST") {
        send(res, 200, JSON.stringify({ id: newJobId() }));
        return;
      }
      const llamaPoll = /^\/api\/v2\/parse\/([^/?]+)/.exec(url);
      if (llamaPoll) {
        const jobId = llamaPoll[1]!;
        if (!polls.has(jobId)) {
          send(res, 404, JSON.stringify({ detail: "job not found" }));
          return;
        }
        const done = tick(jobId);
        send(
          res,
          200,
          JSON.stringify(
            done ? { status: "SUCCESS", markdown: text } : { status: "PENDING" }
          )
        );
        return;
      }

      send(res, 404, JSON.stringify({ error: `unexpected path ${url}` }));
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const baseURL = () => `http://127.0.0.1:${port}`;

  return {
    baseURL: baseURL(),
    port,
    setText(next) {
      text = next;
    },
    setPolls(n) {
      pollsBeforeDone = n;
    },
    setFailure(failure) {
      failWith = failure;
    },
    requests() {
      return seen;
    },
    reset() {
      seen.length = 0;
      polls.clear();
      jsonResponse = false;
      failWith = null;
      pollsBeforeDone = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

/** `tsx test/helpers/fakeParser.ts --port 3802` — a mock cloud parser for manual runs. */
async function main(): Promise<void> {
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : Number(process.env.FAKE_PARSER_PORT ?? 3802);
  const parser = await startFakeParser({ port });
  console.log(`fake document parser listening on ${parser.baseURL}`);
  console.log(`  sync       → POST ${parser.baseURL}/v1/convert/file`);
  console.log(`  mineru     → POST ${parser.baseURL}/api/v4/file-urls/batch`);
  console.log(`  llamaparse → POST ${parser.baseURL}/api/v2/parse/upload`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
