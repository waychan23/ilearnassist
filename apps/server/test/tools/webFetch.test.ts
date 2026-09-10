import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebFetchConfig } from "../../src/config.js";

/**
 * `web_fetch` is the only place the server issues an arbitrary outbound request, so it is
 * a security boundary. The guard also makes the tool untestable against a local fixture
 * server — loopback is refused by design — so both DNS and `fetch` are stubbed here.
 */

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", () => ({ promises: { lookup: dnsMock.lookup } }));

const { assertPublicUrl, buildWebFetchTool, htmlToText, isPrivateAddress } = await import(
  "../../src/tools/webFetch.js"
);

const PUBLIC_IP = "93.184.216.34";

beforeEach(() => {
  dnsMock.lookup.mockResolvedValue([{ address: PUBLIC_IP }]);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * A response that gets the HTML treatment. The content-type must be explicit: `new
 * Response(string)` defaults to `text/plain`, which sends the tool down the
 * pass-the-body-through path instead.
 */
function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1", // multicast
    "255.255.255.255",
  ])("rejects the private IPv4 %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.255.255"])(
    "allows the public IPv4 %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );

  it.each(["::1", "::", "fe80::1", "fc00::1", "fd00::1"])("rejects the private IPv6 %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("judges an IPv4-mapped IPv6 address by the embedded IPv4", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("strips an IPv6 zone index before judging", () => {
    expect(isPrivateAddress("fe80::1%en0")).toBe(true);
  });

  it("refuses anything it cannot parse rather than guessing", () => {
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("accepts an http(s) url whose host resolves to a public address", async () => {
    await expect(assertPublicUrl("https://example.com/page")).resolves.toBeInstanceOf(URL);
  });

  it.each(["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)"])(
    "refuses the non-http scheme %s",
    async (url) => {
      await expect(assertPublicUrl(url)).rejects.toThrow(/non-http\(s\)|Not a valid URL/);
    }
  );

  it("refuses something that is not a url at all", async () => {
    await expect(assertPublicUrl("nonsense")).rejects.toThrow(/Not a valid URL/);
  });

  it("refuses a literal private address without ever resolving it", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/admin")).rejects.toThrow(/private address/);
    expect(dnsMock.lookup).not.toHaveBeenCalled();
  });

  it("refuses a hostname that resolves to a private address", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "10.0.0.5" }]);
    await expect(assertPublicUrl("https://internal.example")).rejects.toThrow(/resolves to a private address/);
  });

  it("refuses when any of several addresses is private", async () => {
    // A DNS record with a public and a private answer must not be half-trusted.
    dnsMock.lookup.mockResolvedValue([{ address: PUBLIC_IP }, { address: "192.168.0.1" }]);
    await expect(assertPublicUrl("https://sneaky.example")).rejects.toThrow(/resolves to a private address/);
  });

  it("refuses a host that does not resolve", async () => {
    dnsMock.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicUrl("https://nope.example")).rejects.toThrow(/Could not resolve host/);
  });
});

describe("htmlToText", () => {
  it("extracts the title and prefers <main> over the whole body", () => {
    const { title, text } = htmlToText(`
      <html><head><title>Doc Title</title></head>
      <body><nav>Menu</nav><main><p>Real content</p></main><footer>Footer</footer></body></html>`);
    expect(title).toBe("Doc Title");
    expect(text).toBe("Real content");
  });

  it("drops chrome, scripts and styles", () => {
    const { text } = htmlToText(`
      <body>
        <script>var x = 1;</script><style>.a{}</style><noscript>n</noscript>
        <nav>nav</nav><header>head</header><footer>foot</footer><aside>aside</aside><form>form</form>
        <p>Kept</p>
      </body>`);
    expect(text).toBe("Kept");
  });

  it("falls back to <article>, then to the whole body", () => {
    expect(htmlToText("<body><article>Article body</article></body>").text).toBe("Article body");
    expect(htmlToText("<body><div>Loose</div></body>").text).toBe("Loose");
  });

  it("collapses runs of spaces and newlines", () => {
    // Every run of whitespace-at-a-line-break collapses to a single newline, so the
    // `\n{3,}` pass downstream has nothing left to do.
    expect(htmlToText("<body><p>a   b</p>\n\n\n\n<p>c</p></body>").text).toBe("a b\nc");
    expect(htmlToText("<body>a\t\tb   c</body>").text).toBe("a b c");
  });

  it("returns an empty title when there is none", () => {
    expect(htmlToText("<body>x</body>").title).toBe("");
  });
});

describe("the web_fetch tool", () => {
  const cfg: WebFetchConfig = { enabled: true, maxChars: 20_000 };

  it("returns the readable text behind a metadata header", async () => {
    stubFetch(() =>
      htmlResponse("<html><head><title>T</title></head><body><p>Body text</p></body></html>")
    );
    const result = (await buildWebFetchTool(cfg).invoke({ url: "https://example.com" })) as string;

    expect(result).toContain("URL: https://example.com");
    expect(result).toContain("Title: T");
    expect(result).toContain("Body text");
  });

  it("passes JSON through without HTML extraction", async () => {
    stubFetch(
      () => new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } })
    );
    const result = (await buildWebFetchTool(cfg).invoke({ url: "https://api.example.com" })) as string;
    expect(result).toContain('{"a":1}');
  });

  it("caps the text at maxChars and says where it stopped", async () => {
    stubFetch(() => htmlResponse(`<body>${"y".repeat(500)}</body>`));
    const result = (await buildWebFetchTool({ enabled: true, maxChars: 100 }).invoke({
      url: "https://example.com",
    })) as string;

    expect(result).toContain("[... truncated at 100 characters]");
    // The cap applies to the extracted text, not to the header above it.
    const extracted = result.slice(result.indexOf("\n\n") + 2).split("\n\n[...")[0]!;
    expect(extracted).toBe("y".repeat(100));
  });

  it("lets a call ask for less than the configured cap, but never more", async () => {
    stubFetch(() => htmlResponse(`<body>${"y".repeat(500)}</body>`));
    const tool = buildWebFetchTool({ enabled: true, maxChars: 100 });

    const smaller = (await tool.invoke({ url: "https://example.com", maxChars: 10 })) as string;
    expect(smaller).toContain("[... truncated at 10 characters]");

    const bigger = (await tool.invoke({ url: "https://example.com", maxChars: 9_999 })) as string;
    expect(bigger).toContain("[... truncated at 100 characters]");
  });

  it("reports an HTTP error status", async () => {
    stubFetch(() => new Response("gone", { status: 404 }));
    await expect(buildWebFetchTool(cfg).invoke({ url: "https://example.com" })).rejects.toThrow(/HTTP 404/);
  });

  describe("redirects", () => {
    it("follows a redirect to another public host", async () => {
      stubFetch((url) =>
        url === "https://example.com/old"
          ? new Response(null, { status: 302, headers: { location: "https://example.com/new" } })
          : htmlResponse("<body>Moved</body>")
      );
      const result = (await buildWebFetchTool(cfg).invoke({ url: "https://example.com/old" })) as string;
      expect(result).toContain("URL: https://example.com/new");
      expect(result).toContain("Moved");
    });

    it("re-validates every hop, so a public url cannot bounce the server to loopback", async () => {
      stubFetch(() =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } })
      );
      await expect(buildWebFetchTool(cfg).invoke({ url: "https://example.com/evil" })).rejects.toThrow(
        /private address/
      );
    });

    it("refuses a redirect without a Location header", async () => {
      stubFetch(() => new Response(null, { status: 302 }));
      await expect(buildWebFetchTool(cfg).invoke({ url: "https://example.com" })).rejects.toThrow(
        /redirect without a Location header/
      );
    });

    it("gives up after too many hops", async () => {
      stubFetch((url) => {
        const n = Number(new URL(url).searchParams.get("n") ?? "0");
        return new Response(null, {
          status: 302,
          headers: { location: `https://example.com/?n=${n + 1}` },
        });
      });
      await expect(buildWebFetchTool(cfg).invoke({ url: "https://example.com/" })).rejects.toThrow(
        /Too many redirects/
      );
    });

    it("refuses a redirect to a private hostname", async () => {
      dnsMock.lookup.mockImplementation(async (host: string) =>
        host === "internal.example" ? [{ address: "10.1.2.3" }] : [{ address: PUBLIC_IP }]
      );
      stubFetch(() => new Response(null, { status: 302, headers: { location: "https://internal.example/x" } }));
      await expect(buildWebFetchTool(cfg).invoke({ url: "https://example.com" })).rejects.toThrow(
        /resolves to a private address/
      );
    });
  });
});
