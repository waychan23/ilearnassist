import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DRIVERS, driverInfos, isDocumentParserKind } from "../../src/documents/drivers/index.js";
import { ParseError, isRecoverable } from "../../src/documents/errors.js";
import { describeParseError } from "../../src/documents/index.js";
import { parseDocument, type ParsePolicy, type ParserTarget } from "../../src/documents/index.js";
import { buildPdf } from "../../src/documents/sample.js";
import { startFakeParser, type FakeParser } from "../helpers/fakeParser.js";
import { buildDocx } from "../helpers/officeFixtures.js";

/**
 * The cloud drivers, driven against a fake service that speaks the real protocols.
 *
 * Nothing here is stubbed: presigned uploads, job polling, ZIP extraction, Bearer auth and
 * error mapping all execute. That matters, because the driver is exactly where a real
 * vendor integration breaks — and a test that mocked it out would pass while the product
 * did not.
 */

let parser: FakeParser;
let scratch: string;
let seq = 0;

function fixture(name: string, bytes: Buffer): string {
  const path = join(scratch, `${(seq += 1)}-${name}`);
  writeFileSync(path, bytes);
  return path;
}

const tuning = { requestTimeoutMs: 2_000, jobTimeoutMs: 5_000, pollIntervalMs: 10 };

function policy(overrides: Partial<ParsePolicy> = {}): ParsePolicy {
  return { localEnabled: true, policy: "local-first", fallbackEnabled: true, defaultParserId: null, ...overrides };
}

function target(overrides: Partial<ParserTarget> = {}): ParserTarget {
  return { id: "fake", name: "Fake", kind: "sync", baseURL: parser.baseURL, ...overrides };
}

async function run(input: {
  path: string;
  mimeType?: string;
  policy?: ParsePolicy;
  parsers?: ParserTarget[];
  signal?: AbortSignal;
}) {
  return parseDocument({
    path: input.path,
    name: "doc.pdf",
    mimeType: input.mimeType ?? "application/pdf",
    size: 10_000,
    localMaxBytes: 1_000_000,
    maxTextChars: 1_000_000,
    policy: input.policy ?? policy(),
    parsers: input.parsers ?? [],
    tuning,
    signal: input.signal ?? new AbortController().signal,
  });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "gl-drivers-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  parser = await startFakeParser({ text: "# From the cloud\n\nExtracted body." });
});

afterEach(async () => {
  await parser.close();
});

describe("driver registry", () => {
  it("exposes metadata for every kind, for the settings form", () => {
    const infos = driverInfos();
    expect(infos.map((i) => i.kind).sort()).toEqual(["llamaparse", "mineru", "sync"]);
    // The generic driver must not demand a key — that is what makes self-hosted services
    // work with nothing but a base URL.
    expect(infos.find((i) => i.kind === "sync")?.requiresApiKey).toBe(false);
    expect(infos.find((i) => i.kind === "mineru")?.requiresApiKey).toBe(true);
    expect(infos.every((i) => i.label.length > 0)).toBe(true);
  });

  it("rejects unknown kinds", () => {
    expect(isDocumentParserKind("mineru")).toBe(true);
    expect(isDocumentParserKind("nope")).toBe(false);
  });
});

describe("sync driver", () => {
  it("posts multipart and returns the raw Markdown", async () => {
    const outcome = await run({
      path: fixture("a.pdf", buildPdf(["ignored"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [target()],
    });

    expect(outcome.text).toContain("Extracted body.");
    expect(outcome.parserId).toBe("fake");

    const upload = parser.requests()[0]!;
    expect(upload.method).toBe("POST");
    expect(upload.contentType).toContain("multipart/form-data");
  });

  it("finds the text inside a JSON envelope", async () => {
    await parser.close();
    parser = await startFakeParser({ text: "Enveloped markdown", jsonResponse: true });

    const outcome = await run({
      path: fixture("b.pdf", buildPdf(["ignored"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [target()],
    });
    expect(outcome.text).toBe("Enveloped markdown");
  });

  it("passes the key as a Bearer token when one is set", async () => {
    await parser.close();
    parser = await startFakeParser({ text: "authed", expectedApiKey: "secret" });

    const outcome = await run({
      path: fixture("c.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [target({ apiKey: "secret" })],
    });

    expect(outcome.text).toBe("authed");
    expect(parser.requests()[0]!.authorization).toBe("Bearer secret");
  });

  it("maps a rejected key onto cloud_auth", async () => {
    await parser.close();
    parser = await startFakeParser({ expectedApiKey: "right" });

    const err = (await run({
      path: fixture("d.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [target({ apiKey: "wrong" })],
    }).catch((e: unknown) => e)) as ParseError;

    expect(err.code).toBe("cloud_auth");
  });

  it("reports an empty body rather than succeeding with nothing", async () => {
    await parser.close();
    parser = await startFakeParser({ text: "   " });

    const err = (await run({
      path: fixture("e.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [target()],
    }).catch((e: unknown) => e)) as ParseError;

    expect(err.code).toBe("cloud_failed");
  });

  it("probes by actually sending a document", async () => {
    await DRIVERS.sync.probe({ id: "p", name: "P", baseURL: parser.baseURL }, tuning, new AbortController().signal);
    expect(parser.requests()).toHaveLength(1);

    // A reachable endpoint that returns nothing is a misconfigured URL, not a success.
    await parser.close();
    parser = await startFakeParser({ text: "" });
    await expect(
      DRIVERS.sync.probe({ id: "p", name: "P", baseURL: parser.baseURL }, tuning, new AbortController().signal)
    ).rejects.toMatchObject({ code: "cloud_failed" });
  });
});

describe("mineru driver", () => {
  // Mirrors the real config, where baseURL carries the API version segment
  // (`https://mineru.net/api/v4`) and the driver appends `/file-urls/batch`.
  const mineru = (): ParserTarget =>
    target({ kind: "mineru", apiKey: "test-key", baseURL: `${parser.baseURL}/api/v4` });

  it("runs the presigned upload, polls, and unpacks the result archive", async () => {
    parser.setPolls(2);

    const outcome = await run({
      path: fixture("m.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [mineru()],
    });

    expect(outcome.text).toContain("Extracted body.");

    const urls = parser.requests().map((r) => `${r.method} ${r.url}`);
    expect(urls.some((u) => u.startsWith("POST /api/v4/file-urls/batch"))).toBe(true);
    expect(urls.some((u) => u.startsWith("PUT /upload/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("GET /api/v4/extract-results/batch/"))).toBe(true);
    // The ZIP actually had to be downloaded and unpacked — the text lives in neither the
    // submit nor the poll response.
    expect(urls.some((u) => u.startsWith("GET /result/"))).toBe(true);
  });

  it("keeps polling while the job reports running", async () => {
    parser.setPolls(3);
    const outcome = await run({
      path: fixture("m2.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [mineru()],
    });
    expect(outcome.text).toContain("Extracted body.");
    const polls = parser.requests().filter((r) => r.url.includes("/extract-results/"));
    expect(polls.length).toBeGreaterThanOrEqual(4); // 3 running + 1 done
  });

  it("gives up when the job never finishes", async () => {
    parser.setPolls(1000);
    const err = (await parseDocument({
      path: fixture("m3.pdf", buildPdf(["x"])),
      name: "doc.pdf",
      mimeType: "application/pdf",
      size: 10_000,
      localMaxBytes: 1_000_000,
      maxTextChars: 1_000_000,
      policy: policy({ policy: "cloud-only" }),
      parsers: [mineru()],
      tuning: { ...tuning, jobTimeoutMs: 120 },
      signal: new AbortController().signal,
    }).catch((e: unknown) => e)) as ParseError;

    expect(err.code).toBe("timeout");
    // A timeout is worth another tier's attempt, unlike an auth failure.
    expect(isRecoverable(err)).toBe(true);
  });

  it("probes without needing a parse: a 401 is a bad key, a 400 is not", async () => {
    await parser.close();
    parser = await startFakeParser({ expectedApiKey: "right" });

    await expect(
      DRIVERS.mineru.probe(
        { id: "p", name: "P", baseURL: `${parser.baseURL}/api/v4`, apiKey: "wrong" },
        tuning,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "cloud_auth" });

    // The probe posts an empty file list on purpose; the 400 that earns proves the request
    // was authenticated and rejected on content, which is the success condition.
    await expect(
      DRIVERS.mineru.probe(
        { id: "p", name: "P", baseURL: `${parser.baseURL}/api/v4`, apiKey: "right" },
        tuning,
        new AbortController().signal
      )
    ).resolves.toBeUndefined();
  });
});

describe("llamaparse driver", () => {
  const llama = (): ParserTarget => target({ kind: "llamaparse", apiKey: "test-key" });

  it("uploads then polls the markdown out of the job response", async () => {
    parser.setPolls(1);

    const outcome = await run({
      path: fixture("l.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [llama()],
    });

    expect(outcome.text).toContain("Extracted body.");
    const urls = parser.requests().map((r) => r.url);
    expect(urls[0]).toContain("/api/v2/parse/upload");
    expect(urls.some((u) => u.includes("expand=markdown"))).toBe(true);
  });

  it("treats an unknown job id as a healthy probe", async () => {
    await parser.close();
    parser = await startFakeParser({ expectedApiKey: "right" });
    // 404 for an id the fake has never seen — the same shape as a real service.
    await expect(
      DRIVERS.llamaparse.probe(
        { id: "p", name: "P", baseURL: parser.baseURL, apiKey: "right" },
        tuning,
        new AbortController().signal
      )
    ).resolves.toBeUndefined();
  });
});

describe("parse policy", () => {
  it("falls back to the cloud when local extraction finds no text", async () => {
    // A page with no text layer is what a scanned PDF looks like. It must reach the cloud
    // parser — this is the single most valuable fallback in the whole feature.
    const outcome = await run({
      path: fixture("scan.pdf", buildPdf([""])),
      policy: policy({ policy: "local-first" }),
      parsers: [target()],
    });

    expect(outcome.text).toContain("Extracted body.");
    expect(outcome.parserId).toBe("fake");
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]!.parserId).toBe("local");
  });

  it("prefers the cloud under cloud-first, even when local would have worked", async () => {
    const outcome = await run({
      path: fixture("both.pdf", buildPdf(["local text"])),
      policy: policy({ policy: "cloud-first" }),
      parsers: [target()],
    });

    expect(outcome.parserId).toBe("fake");
    expect(outcome.text).toContain("Extracted body.");
    expect(parser.requests().length).toBeGreaterThan(0);
  });

  it("falls back to local under cloud-first when the cloud fails", async () => {
    await parser.close();
    parser = await startFakeParser({ failWith: { status: 500 } });

    const outcome = await run({
      path: fixture("cb.pdf", buildPdf(["local text here"])),
      policy: policy({ policy: "cloud-first" }),
      parsers: [target()],
    });

    expect(outcome.parserId).toBe("local");
    expect(outcome.text).toContain("local text here");
  });

  it("stops at the first tier when fallback is switched off", async () => {
    await parser.close();
    parser = await startFakeParser({ failWith: { status: 500 } });

    const err = (await run({
      path: fixture("nofb.pdf", buildPdf(["local text here"])),
      policy: policy({ policy: "cloud-first", fallbackEnabled: false }),
      parsers: [target()],
    }).catch((e: unknown) => e)) as ParseError;

    expect(err).toBeInstanceOf(ParseError);
    expect(err.attempts.map((a) => a.parserId)).toEqual(["cloud"]);
  });

  it("explains that nothing is configured when cloud-only has no parsers", async () => {
    const err = (await run({
      path: fixture("nc.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [],
    }).catch((e: unknown) => e)) as ParseError;

    // Here nothing else was tried, so the configuration problem *is* the diagnosis.
    expect(err.code).toBe("no_cloud_parser");
    expect(describeParseError(err)).toContain("云解析服务");
  });

  it("tries the next parser when the first one fails", async () => {
    await parser.close();
    parser = await startFakeParser({ text: "second parser answered", expectedApiKey: "good" });

    const outcome = await run({
      path: fixture("failover.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only" }),
      parsers: [
        target({ id: "broken", apiKey: "bad" }),
        target({ id: "working", apiKey: "good" }),
      ],
    });

    expect(outcome.parserId).toBe("working");
    expect(outcome.text).toBe("second parser answered");
  });

  it("honours a pinned parser over the configured order", async () => {
    await parser.close();
    parser = await startFakeParser({ expectedApiKey: "second" });

    const outcome = await run({
      path: fixture("pinned.pdf", buildPdf(["x"])),
      policy: policy({ policy: "cloud-only", defaultParserId: "second" }),
      parsers: [
        // First in list order, but the wrong key — only the pin saves this run.
        target({ id: "first", kind: "llamaparse", apiKey: "first" }),
        target({ id: "second", kind: "llamaparse", apiKey: "second" }),
      ],
    });

    expect(outcome.parserId).toBe("second");
  });

  it("does not reach for the cloud when local is switched off and cloud is first anyway", async () => {
    const outcome = await run({
      path: fixture("off.pdf", buildPdf(["local only"])),
      policy: policy({ policy: "local-only", localEnabled: true }),
      parsers: [target()],
    });
    expect(outcome.parserId).toBe("local");
    expect(parser.requests()).toHaveLength(0);
  });

  it("classifies failures the way the policy reads them", () => {
    // These two encode the design decision this feature makes: a scan and an oversized
    // file are the *most* likely to succeed elsewhere, so they must not block a fallback.
    expect(isRecoverable(new ParseError("no_text_layer", ""))).toBe(true);
    expect(isRecoverable(new ParseError("too_large", ""))).toBe(true);
    expect(isRecoverable(new ParseError("corrupt", ""))).toBe(true);
    // These cannot be read by anyone, so another round trip would be pure waste.
    expect(isRecoverable(new ParseError("password_protected", ""))).toBe(false);
    expect(isRecoverable(new ParseError("unsupported_type", ""))).toBe(false);
    expect(isRecoverable(new ParseError("cancelled", ""))).toBe(false);
  });

  it("extracts a Word document locally under a local-only policy", async () => {
    const outcome = await run({
      path: fixture("doc.docx", buildDocx(["Contract clause one."])),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      policy: policy({ policy: "local-only" }),
      parsers: [],
    });

    expect(outcome.text).toContain("Contract clause one.");
    expect(outcome.parserId).toBe("local");
  });
});
