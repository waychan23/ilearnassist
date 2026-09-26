import type { NetworkInterfaceInfo } from "node:os";

/**
 * Finding the address a phone should open.
 *
 * The panel can show a QR code and then have it fail for a reason the user cannot see: a
 * machine has several addresses and only one of them is reachable from the device scanning
 * the code. Picking the wrong one produces a QR that scans perfectly and then times out —
 * the worst kind of bug from the far side of the screen, because nothing on either device
 * says which end is wrong.
 *
 * So this is a ranking, not a `find()`. It is also a pure function over
 * `os.networkInterfaces()`, which is what makes the awkward cases testable without a second
 * machine on the desk.
 */

export interface CandidateAddress {
  name: string;
  address: string;
}

/**
 * Interfaces that are routable to a phone in the same room.
 *
 * Preferred by name because the ranking below cannot tell a Wi-Fi address from a VPN one:
 * both are private IPv4s on an up interface, and the VPN's is the one that will not answer.
 * These are the conventional names on macOS (`en0` is usually Wi-Fi), Linux and Windows.
 */
const PREFERRED_INTERFACES = ["en0", "en1", "eth0", "wlan0", "en2", "eth1", "wi-fi", "ethernet"];

/**
 * Virtual interfaces, which are never the answer.
 *
 * A tunnel address looks exactly like a real one and is reachable only from inside the
 * tunnel; a bridge or a container network is reachable only from this machine. Excluding
 * them by name is approximate, but the alternative — probing each address for reachability —
 * needs a second device to probe from.
 */
const VIRTUAL_INTERFACE = /^(utun|ipsec|tun|tap|bridge|docker|vboxnet|vmnet|llw|awdl|ap\d|anpi)/i;

/** `169.254.x.x`: self-assigned when DHCP failed. On an interface, on the wire, nowhere else. */
function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.");
}

/** RFC 1918. Not required — a café can hand out public addresses — but preferred. */
function isPrivate(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b !== undefined && b >= 16 && b <= 31;
}

/**
 * The addresses worth offering, best first.
 *
 * Ordering is total and deterministic so the panel cannot show a different address on two
 * launches of the same machine — a QR code that changes for no reason is one a user stops
 * trusting.
 */
export function rankLanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): CandidateAddress[] {
  const candidates: CandidateAddress[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of entries) {
      // Node reports `family` as a string on modern versions and as a number on old ones;
      // accepting both costs nothing and a silently-skipped interface costs a QR code.
      const isIpv4 = entry.family === "IPv4" || (entry.family as unknown as number) === 4;
      if (!isIpv4 || entry.internal) continue;
      if (isLinkLocal(entry.address)) continue;
      candidates.push({ name, address: entry.address });
    }
  }

  const rank = (candidate: CandidateAddress): number => {
    const nameIndex = PREFERRED_INTERFACES.indexOf(candidate.name.toLowerCase());
    const nameRank = nameIndex === -1 ? PREFERRED_INTERFACES.length : nameIndex;
    return (isPrivate(candidate.address) ? 0 : 100) + nameRank;
  };

  return candidates.sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address)
  );
}

/**
 * The single best address, or null when there is none to offer.
 *
 * Null is a real answer, not a failure: a machine with only loopback and a VPN has no
 * address a phone in the same room can reach, and the panel says so rather than showing a
 * code that cannot work.
 */
export function findLanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  return rankLanAddresses(interfaces)[0]?.address ?? null;
}

/**
 * Rewrite a loopback URL so another device can open it.
 *
 * Returns null rather than a guess when there is no address: a QR code encoding
 * `http://127.0.0.1:10471` scans fine and then loads the *phone's* own loopback, which is the
 * single most confusing possible outcome — so the panel shows nothing instead.
 */
export function lanUrlFor(url: string | null, address: string | null): string | null {
  if (!url || !address) return null;
  try {
    const parsed = new URL(url);
    parsed.hostname = address;
    // `URL` normalises a bare authority to a path of `/`, which the server's own URL does
    // not have. The panel prints this string, so the added slash is noise the user has to
    // read past — and it is not the URL the server reported.
    const result = parsed.toString();
    return url.endsWith("/") ? result : result.replace(/\/$/, "");
  } catch {
    return null;
  }
}
