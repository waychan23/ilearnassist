import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { findLanAddress, lanUrlFor, rankLanAddresses } from "../src/main/lan.js";

/**
 * Which address goes into the QR code.
 *
 * Every case here is one that produces a QR a phone scans perfectly and then times out on,
 * which is the failure this module exists to avoid — and the one that is hardest to
 * diagnose from the far side of the room, because neither device says which end is wrong.
 */

function ipv4(address: string, overrides: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  const base = {
    address,
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  };
  // The cast is the point of the helper: a genuinely IPv6 entry has a different member of
  // the `NetworkInterfaceInfo` union, and the module under test is required to survive one
  // arriving on an interface it was about to choose.
  return { ...base, ...overrides } as NetworkInterfaceInfo;
}

describe("findLanAddress", () => {
  it("finds the Wi-Fi address", () => {
    expect(findLanAddress({ en0: [ipv4("192.168.1.42")] })).toBe("192.168.1.42");
  });

  it("ignores loopback", () => {
    const interfaces = {
      lo0: [ipv4("127.0.0.1", { internal: true })],
      en0: [ipv4("192.168.1.42")],
    };
    expect(findLanAddress(interfaces)).toBe("192.168.1.42");
  });

  it("ignores IPv6", () => {
    const interfaces = { en0: [ipv4("fe80::1", { family: "IPv6" }), ipv4("192.168.1.42")] };
    expect(findLanAddress(interfaces)).toBe("192.168.1.42");
  });

  it("ignores a self-assigned address", () => {
    // 169.254.x.x is what an interface gives itself when DHCP failed. It is a real address
    // on the interface and there is nothing at the other end of it.
    const interfaces = {
      en0: [ipv4("169.254.13.7")],
      en1: [ipv4("192.168.1.42")],
    };
    expect(findLanAddress(interfaces)).toBe("192.168.1.42");
  });

  it("prefers a real interface over a tunnel", () => {
    // A VPN's address is a private IPv4 on an up interface, and unreachable from a phone on
    // the sofa. This is the case the ranking exists for.
    const interfaces = {
      utun3: [ipv4("10.8.0.6")],
      en0: [ipv4("192.168.1.42")],
    };
    expect(findLanAddress(interfaces)).toBe("192.168.1.42");
  });

  it("prefers a real interface over a container network", () => {
    const interfaces = {
      docker0: [ipv4("172.17.0.1")],
      bridge100: [ipv4("192.168.64.1")],
      en0: [ipv4("192.168.1.42")],
    };
    expect(findLanAddress(interfaces)).toBe("192.168.1.42");
  });

  it("offers nothing rather than a tunnel address, when a tunnel is all there is", () => {
    // The deliberate consequence of the exclusion above. A VPN address is reachable from a
    // phone only if the phone is on the same VPN, which for the person about to scan a code
    // in the same room it is not — so offering it trades a clear "no network address" for a
    // code that scans and then times out, and neither device says which end is wrong.
    expect(findLanAddress({ utun3: [ipv4("10.8.0.6")] })).toBe(null);
  });

  it("prefers a private address when an interface has both", () => {
    const interfaces = { en0: [ipv4("203.0.113.9"), ipv4("192.168.1.42")] };
    expect(findLanAddress(interfaces)).toBe("192.168.1.42");
  });

  it("returns null when there is no network at all", () => {
    expect(findLanAddress({ lo0: [ipv4("127.0.0.1", { internal: true })] })).toBe(null);
    expect(findLanAddress({})).toBe(null);
  });

  it("is stable across calls, so the code does not change shape between renders", () => {
    const interfaces = {
      en1: [ipv4("192.168.1.43")],
      en0: [ipv4("192.168.1.42")],
      eth0: [ipv4("192.168.1.44")],
    };
    expect(rankLanAddresses(interfaces).map((c) => c.address)).toEqual([
      "192.168.1.42",
      "192.168.1.43",
      "192.168.1.44",
    ]);
  });
});

describe("lanUrlFor", () => {
  it("swaps the loopback host for the network one", () => {
    expect(lanUrlFor("http://127.0.0.1:54321", "192.168.1.42")).toBe("http://192.168.1.42:54321");
  });

  it("keeps the port, which is the part that is hard to retype", () => {
    expect(lanUrlFor("http://127.0.0.1:62731", "10.0.0.7")).toContain("62731");
  });

  it("returns null rather than a code that cannot work", () => {
    // Encoding 127.0.0.1 would make the phone load its *own* loopback — a page that either
    // fails or, worse, succeeds against something else entirely.
    expect(lanUrlFor("http://127.0.0.1:10471", null)).toBe(null);
    expect(lanUrlFor(null, "192.168.1.42")).toBe(null);
  });

  it("returns null for a URL it cannot parse rather than throwing at the panel", () => {
    expect(lanUrlFor("not a url", "192.168.1.42")).toBe(null);
  });
});
