import { promises as fs } from "node:fs";
import type { Attachment } from "@ilearnassist/shared";
import { resolveStoredPath } from "../attachments.js";
import type { AppConfig } from "../config.js";
import { readDocumentParsing, type AppDb } from "../db.js";
import {
  driverFor,
  isDocumentParserKind,
  parseDocument,
  type DriverTuning,
  type ParserTarget,
  type ParsePolicy,
} from "./index.js";
import { ParseError, asParseError, describeParseError } from "./errors.js";
import { isDocumentMime } from "./formats.js";
import {
  readParseRecord,
  removeParsed,
  writeParsedText,
  writeParseRecord,
  type ParseRecord,
} from "./store.js";

/**
 * Owns everything that happens to a document attachment *after* its bytes are stored:
 * deciding whether to parse it, running the work off the request path, and recording the
 * outcome where the prompt builder and the UI can both read it.
 *
 * Parsing is deliberately asynchronous. A cloud job routinely takes tens of seconds — five
 * minutes is the configured ceiling — and the upload endpoint has to answer immediately or
 * the composer hangs on every PDF. The trade is a small state machine the client polls.
 */

/** Bound on how many parses run at once; extraction is CPU-heavy and cloud calls bill. */
export class DocumentService {
  readonly #uploadRoot: string;
  readonly #db: AppDb;
  readonly #config: AppConfig;

  /** Aborters for in-flight runs, keyed by `sessionId/attachmentId`. */
  readonly #inFlight = new Map<string, AbortController>();
  readonly #queue: { key: string; run: () => Promise<void> }[] = [];
  #running = 0;
  #closed = false;

  constructor(opts: { uploadRoot: string; db: AppDb; config: AppConfig }) {
    this.#uploadRoot = opts.uploadRoot;
    this.#db = opts.db;
    this.#config = opts.config;
  }

  get tuning(): DriverTuning {
    const d = this.#config.tools.documents;
    return {
      requestTimeoutMs: d.requestTimeoutMs,
      jobTimeoutMs: d.jobTimeoutMs,
      pollIntervalMs: d.pollIntervalMs,
    };
  }

  /** The policy, read fresh — a settings change must apply to the next parse, not the next boot. */
  get policy(): ParsePolicy {
    return readDocumentParsing(this.#db, {
      localEnabled: this.#config.documentParsing.localEnabled,
      policy: this.#config.documentParsing.policy,
      fallbackEnabled: this.#config.documentParsing.fallbackEnabled,
      defaultParserId: this.#config.documentParsing.defaultParserId,
    });
  }

  /** Enabled cloud parsers, in the order they should be tried. */
  get parsers(): ParserTarget[] {
    return this.#db
      .listDocumentParsers()
      .filter((p) => p.enabled && isDocumentParserKind(p.kind))
      .map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseURL: p.baseURL,
        apiKey: p.apiKey,
      }));
  }

  /** Whether this attachment is a document we would parse at all. */
  handles(attachment: Attachment): boolean {
    return isDocumentMime(attachment.mimeType);
  }

  /**
   * Queue extraction for a freshly uploaded attachment.
   *
   * Writes `pending` before returning so a status poll issued immediately after the upload
   * response sees a real state rather than a gap between the two.
   */
  async schedule(sessionId: string, attachment: Attachment): Promise<void> {
    if (!this.handles(attachment)) return;

    await writeParseRecord(this.#uploadRoot, sessionId, attachment.id, { status: "pending" });
    this.#enqueue(`${sessionId}/${attachment.id}`, () => this.#execute(sessionId, attachment));
  }

  /**
   * Re-run extraction, for a file that failed or was parsed before the settings changed.
   *
   * Cancels any run already in flight for the same attachment: two writers racing for the
   * same sidecar is how a stale result overwrites a fresh one.
   */
  async reparse(sessionId: string, attachment: Attachment): Promise<void> {
    if (!this.handles(attachment)) {
      throw new ParseError("unsupported_type", `${attachment.name} 不是可解析的文档类型。`);
    }
    const key = `${sessionId}/${attachment.id}`;
    this.#cancel(key);
    await removeParsed(this.#uploadRoot, sessionId, attachment.id).catch(() => undefined);
    await writeParseRecord(this.#uploadRoot, sessionId, attachment.id, { status: "pending" });
    this.#enqueue(key, () => this.#execute(sessionId, attachment));
  }

  /** Drop everything queued or running for a session — used when the session is deleted. */
  cancelSession(sessionId: string): void {
    for (const key of [...this.#inFlight.keys()]) {
      if (key.startsWith(`${sessionId}/`)) this.#cancel(key);
    }
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      if (this.#queue[i]!.key.startsWith(`${sessionId}/`)) this.#queue.splice(i, 1);
    }
  }

  /** Probe a parser's endpoint and credential. Throws `ParseError` when it does not work. */
  async testParser(id: string): Promise<void> {
    const record = this.#db.getDocumentParser(id);
    if (!record) throw new ParseError("cloud_failed", "解析服务不存在。");
    if (!isDocumentParserKind(record.kind)) {
      throw new ParseError("cloud_failed", `未知的解析服务类型：${record.kind}`);
    }
    const driver = driverFor(record.kind);
    if (driver.requiresApiKey && !record.apiKey) {
      throw new ParseError("cloud_auth", "该解析服务需要一个 API Key。");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.tuning.jobTimeoutMs);
    try {
      await driver.probe(
        { id: record.id, name: record.name, baseURL: record.baseURL, apiKey: record.apiKey },
        this.tuning,
        controller.signal
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse state for one attachment, or undefined when nothing has been attempted. */
  async record(sessionId: string, attachmentId: string): Promise<ParseRecord | undefined> {
    return readParseRecord(this.#uploadRoot, sessionId, attachmentId);
  }

  /** Stop accepting work and abort whatever is running. Called on server shutdown. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const key of [...this.#inFlight.keys()]) this.#cancel(key);
    this.#queue.length = 0;
  }

  /* ------------------------------- internals ------------------------------- */

  #enqueue(key: string, run: () => Promise<void>): void {
    if (this.#closed) return;
    this.#queue.push({ key, run });
    void this.#drain();
  }

  #cancel(key: string): void {
    this.#inFlight.get(key)?.abort(new ParseError("cancelled", "Superseded by a newer run."));
    this.#inFlight.delete(key);
    const queued = this.#queue.findIndex((entry) => entry.key === key);
    if (queued !== -1) this.#queue.splice(queued, 1);
  }

  async #drain(): Promise<void> {
    const limit = this.#config.tools.documents.concurrency;
    while (this.#running < limit) {
      const entry = this.#queue.shift();
      if (!entry || this.#closed) return;

      this.#running += 1;
      void entry
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.#running -= 1;
          this.#inFlight.delete(entry.key);
          void this.#drain();
        });
    }
  }

  /**
   * One extraction run, from bytes to sidecar.
   *
   * Failures are recorded rather than thrown: this runs detached from any request, so the
   * only place a user can learn what happened is the parse record.
   */
  async #execute(sessionId: string, attachment: Attachment): Promise<void> {
    const key = `${sessionId}/${attachment.id}`;
    const controller = new AbortController();
    this.#inFlight.set(key, controller);

    const path = resolveStoredPath(this.#uploadRoot, sessionId, attachment);
    if (!path) {
      await writeParseRecord(this.#uploadRoot, sessionId, attachment.id, {
        status: "failed",
        error: "附件路径无效。",
      });
      return;
    }

    await writeParseRecord(this.#uploadRoot, sessionId, attachment.id, { status: "parsing" });

    try {
      const stat = await fs.stat(path).catch(() => undefined);
      if (!stat) throw new ParseError("missing_file", "Attachment bytes are missing.");

      const outcome = await parseDocument({
        path,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: stat.size,
        policy: this.policy,
        parsers: this.parsers,
        localMaxBytes: this.#config.tools.documents.localMaxBytes,
        maxTextChars: this.#config.tools.documents.maxTextChars,
        tuning: this.tuning,
        signal: controller.signal,
      });

      await writeParsedText(this.#uploadRoot, sessionId, attachment.id, outcome.text);
      await writeParseRecord(this.#uploadRoot, sessionId, attachment.id, {
        status: "ready",
        parserId: outcome.parserId,
        parsedChars: outcome.text.length,
        pageCount: outcome.pageCount,
      });
    } catch (err) {
      const error = asParseError(err);
      // A cancelled run belongs to a reparse that is already queued — recording a failure
      // here would flash "failed" over the status the newer run is about to set.
      if (error.code === "cancelled") return;
      await writeParseRecord(this.#uploadRoot, sessionId, attachment.id, {
        status: "failed",
        error: describeParseError(error),
        code: error.code,
      });
    }
  }
}
