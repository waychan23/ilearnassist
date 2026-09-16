import { promises as fs } from "node:fs";
import type { Attachment, Source } from "@ilearnassist/shared";
import { resolveSourceBytes } from "../sourcePaths.js";
import type { AppConfig } from "../config.js";
import { readDocumentParsing, type AppDb, type SourceRecord } from "../db.js";
import type { UserLayout } from "../paths.js";
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
import { removeParsedText, writeParsedText } from "./store.js";

/**
 * Owns everything that happens to a document *after* its bytes are stored: deciding whether
 * to parse it, running the work off the request path, and recording the outcome in the
 * source's row — which is where the prompt builder and the UI both read it from.
 *
 * Parsing is deliberately asynchronous. A cloud job routinely takes tens of seconds — five
 * minutes is the configured ceiling — and the upload endpoint has to answer immediately or
 * the composer hangs on every PDF. The trade is a small state machine the client polls.
 *
 * **Keyed by source, not by attachment.** A source belongs to the account, so the work
 * cannot be described by a conversation: two conversations can reference the same file, and
 * the parse is one job whose result both of them read. The user layout therefore arrives per
 * call rather than in the constructor — which user's tree the bytes live in is a fact about
 * the request that started the parse, not about this object.
 */

/** Bound on how many parses run at once; extraction is CPU-heavy and cloud calls bill. */
export class DocumentService {
  readonly #db: AppDb;
  readonly #config: AppConfig;

  /** Aborters for in-flight runs, keyed by source id. */
  readonly #inFlight = new Map<string, AbortController>();
  readonly #queue: { key: string; run: () => Promise<void> }[] = [];
  #running = 0;
  #closed = false;

  constructor(opts: { db: AppDb; config: AppConfig }) {
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

  /** Whether this is a document we would parse at all. */
  handles(file: Pick<Attachment, "mimeType">): boolean {
    return isDocumentMime(file.mimeType);
  }

  /**
   * Queue extraction for a source that has just been created.
   *
   * Writes `pending` before returning so a status poll issued immediately after the upload
   * response sees a real state rather than a gap between the two.
   */
  async schedule(
    user: UserLayout,
    userId: string,
    source: SourceRecord,
    workspaceRoot: string
  ): Promise<void> {
    if (!this.handles(source)) return;
    this.#db.updateSourceParse(source.id, userId, { status: "pending" });
    this.#enqueue(source.id, () => this.#execute(user, userId, source, workspaceRoot));
  }

  /**
   * Re-run extraction, for a file that failed or was parsed before the settings changed.
   *
   * Cancels any run already in flight for the same source: two writers racing for the same
   * text file is how a stale result overwrites a fresh one.
   */
  async reparse(
    user: UserLayout,
    userId: string,
    source: SourceRecord,
    workspaceRoot: string
  ): Promise<void> {
    if (!this.handles(source)) {
      throw new ParseError("unsupported_type", `${source.name} 不是可解析的文档类型。`);
    }
    this.#cancel(source.id);
    await removeParsedText(user, source.id).catch(() => undefined);
    this.#db.updateSourceParse(source.id, userId, { status: "pending" });
    this.#enqueue(source.id, () => this.#execute(user, userId, source, workspaceRoot));
  }

  /**
   * Stop whatever is running or queued for one source.
   *
   * There used to be a `cancelSession`, called when a conversation was deleted because the
   * parse would have written a sidecar back into the directory being removed. That reason is
   * gone — a source outlives the conversation — and the method went with it rather than being
   * renamed: cancelling by *session* would now abort a parse that another conversation is
   * waiting on, for a file that conversation still has.
   */
  cancelSource(sourceId: string): void {
    this.#cancel(sourceId);
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
   * One extraction run, from bytes to extracted text.
   *
   * Failures are recorded rather than thrown: this runs detached from any request, so the
   * only place a user can learn what happened is the source's row.
   */
  async #execute(
    user: UserLayout,
    userId: string,
    source: SourceRecord,
    workspaceRoot: string
  ): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(source.id, controller);

    // The stored path is ours, but read it back through the same containment check every
    // other reader uses: a row is not a trust boundary, and this one holds a filesystem path.
    const path = resolveSourceBytes(user, source, workspaceRoot);
    if (!path) {
      this.#db.updateSourceParse(source.id, userId, {
        status: "failed",
        error: "附件路径无效。",
      });
      return;
    }

    this.#db.updateSourceParse(source.id, userId, { status: "parsing" });

    try {
      const stat = await fs.stat(path).catch(() => undefined);
      if (!stat) throw new ParseError("missing_file", "Attachment bytes are missing.");

      const outcome = await parseDocument({
        path,
        name: source.name,
        mimeType: source.mimeType,
        size: stat.size,
        policy: this.policy,
        parsers: this.parsers,
        localMaxBytes: this.#config.tools.documents.localMaxBytes,
        maxTextChars: this.#config.tools.documents.maxTextChars,
        tuning: this.tuning,
        signal: controller.signal,
      });

      await writeParsedText(user, source.id, outcome.text);
      this.#db.updateSourceParse(source.id, userId, {
        status: "ready",
        parserId: outcome.parserId,
        parsedChars: outcome.text.length,
        pageCount: outcome.pageCount,
      });
    } catch (err) {
      const error = asParseError(err);
      // A cancelled run is one a reparse has already superseded — recording a failure here
      // would flash "failed" over the status the newer run is about to set.
      if (error.code === "cancelled") return;
      this.#db.updateSourceParse(source.id, userId, {
        status: "failed",
        error: describeParseError(error),
        code: error.code,
      });
    }
  }
}
