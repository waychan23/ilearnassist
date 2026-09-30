import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody, Session, WorkResource, Workspace } from "@ilearnassist/shared";
import {
  keylessProvider,
  newSession,
  newWorkspace,
  startTestServer,
  type TestEnv,
} from "./helpers/tempEnv.js";

/**
 * Keeping a fetched page from its `web_fetch` card — the user's half.
 *
 * The card is drawn on a call that succeeded, and what it presses is this route. The operation
 * behind it is `captureWebPage`, which `webCapture.test.ts` already covers for every caller; what
 * is only reachable here is the route's own contract: the page is owned by the **conversation**
 * (so it lists in that conversation's sources panel), the fetch goes through the SSRF guard, and
 * a write to a conversation holds its lock.
 *
 * The guard refuses loopback by design, so the happy fetch is driven with DNS and `fetch`
 * stubbed — the same seam `tools/webFetch.test.ts` uses, and for the same reason.
 */

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", () => ({ promises: { lookup: dnsMock.lookup } }));

const PUBLIC_IP = "93.184.216.34";
const URL = "https://flink.apache.org/downloads/";

const HTML =
  "<html><head><title>Downloads | Apache Flink</title></head><body><main>" +
  "<p>Apache Flink 2.3.0 is the latest stable release.</p></main></body></html>";

let env: TestEnv;
let workspace: Workspace;
let session: Session;

beforeAll(async () => {
  env = await startTestServer({ providers: [keylessProvider("test")] });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  dnsMock.lookup.mockResolvedValue([{ address: PUBLIC_IP }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
    )
  );
  workspace = await newWorkspace(env);
  session = await newSession(env, workspace.id);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The keep request, as some client. `null` is the body with no `url` field at all. */
function keep(client: TestEnv["inject"], url: string | null = URL) {
  return client({
    method: "POST",
    url: `/api/sessions/${session.id}/resources/pages`,
    payload: url === null ? {} : { url },
  });
}

describe("POST /api/sessions/:id/resources/pages", () => {
  it("keeps the page as the conversation's source, and it lists there", async () => {
    const res = await keep(env.inject);
    expect(res.statusCode).toBe(201);

    const kept = res.json<WorkResource>();
    expect(kept.resourceType).toBe("web_page");
    expect(kept.ownerType).toBe("session");
    expect(kept.ownerId).toBe(session.id);
    // The page's own title is what an owner who typed nothing calls it.
    expect(kept.title).toBe("Downloads | Apache Flink");
    // No model summary is invented for a page a person kept — the browser shows the title.
    expect(kept.summary).toBeUndefined();
    expect((kept.resource as { url: string }).url).toBe(URL);

    /*
     * Asserted through the panel's own read rather than on the row alone: "the page is kept" and
     * "the conversation sees it" are two claims, and the second is the feature.
     */
    const listed = await env.inject({
      method: "GET",
      url: `/api/resources?sessionId=${session.id}`,
    });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json<WorkResource[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(kept.id);
  });

  it("keeps one reference when the same page is kept twice", async () => {
    // The card's second press is honest rather than destructive: the reading's hash identifies
    // the page and the reference's place is unique, so this refreshes instead of duplicating.
    expect((await keep(env.inject)).statusCode).toBe(201);
    expect((await keep(env.inject)).statusCode).toBe(201);

    const listed = await env.inject({
      method: "GET",
      url: `/api/resources?sessionId=${session.id}`,
    });
    expect(listed.json<WorkResource[]>()).toHaveLength(1);
  });

  it("refuses a private address with the guard's own sentence", async () => {
    // The same refusal the library's add-link reports, because it is the same guard — and the
    // sentence names the reason, which is what the toast shows.
    const res = await keep(env.inject, "http://127.0.0.1:9/nope");
    expect(res.statusCode).toBe(400);
    const body = res.json<ApiErrorBody>();
    expect(body.error.code).toBe("PAGE_FETCH_FAILED");
    expect(body.error.params?.detail).toContain("127.0.0.1");
  });

  it("requires a URL and a conversation", async () => {
    const missing = await keep(env.inject, null);
    expect(missing.statusCode).toBe(400);
    expect(missing.json<ApiErrorBody>().error.code).toBe("DATA_REQUIRED");

    const gone = await env.inject({
      method: "POST",
      url: "/api/sessions/no-such-session/resources/pages",
      payload: { url: URL },
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json<ApiErrorBody>().error.code).toBe("SESSION_NOT_FOUND");
  });

  it("is a write to the conversation, so a client without its lock is refused", async () => {
    const first = env.asClient("keep-alpha");
    const second = env.asClient("keep-beta");
    expect(
      (await first({ method: "POST", url: `/api/sessions/${session.id}/lock` })).statusCode
    ).toBe(200);

    const res = await keep(second);
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiErrorBody>().error.code).toBe("SESSION_LOCKED");
  });
});
