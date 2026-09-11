import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { qrModules, qrRuns } from "../src/shared/qr.js";

/**
 * The QR code, checked by decoding it.
 *
 * A test that read the modules back with the same library that wrote them would only prove
 * that the library is self-consistent — and a QR code is not read back by its own encoder,
 * it is read by a phone camera. So this encodes through `qrModules`, rasterises the way the
 * panel does, and hands the pixels to `jsQR`, a completely separate implementation. What it
 * asserts is the only thing that matters: a decoder gets the URL out.
 */

/** A QR code needs a quiet zone to be found at all; four modules is the spec's minimum. */
const QUIET_ZONE = 4;
const SCALE = 4;

/**
 * Turn the module square into the RGBA buffer a decoder expects.
 *
 * This mirrors what the SVG in the panel draws — one unit per module, plus a margin — which
 * is why `qrRuns` is exercised through it rather than being compared to `qrModules` directly.
 */
function rasterise(modules: boolean[][], scale = SCALE, quiet = QUIET_ZONE) {
  const size = modules.length;
  const pixels = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(pixels * pixels * 4).fill(255);

  for (const run of qrRuns(modules)) {
    for (let dx = 0; dx < run.length; dx += 1) {
      for (let dy = 0; dy < scale; dy += 1) {
        const x = (run.start + dx + quiet) * scale;
        const y = (run.row + quiet) * scale + dy;
        for (let step = 0; step < scale; step += 1) {
          const offset = (y * pixels + x + step) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }

  return { data, width: pixels, height: pixels };
}

function roundTrip(text: string): string | null {
  const image = rasterise(qrModules(text));
  return jsQR(image.data, image.width, image.height)?.data ?? null;
}

describe("qrModules", () => {
  it("encodes a LAN address so a decoder reads it back", () => {
    expect(roundTrip("http://192.168.1.100:54321")).toBe("http://192.168.1.100:54321");
  });

  it("handles the addresses a real network hands out", () => {
    // A 10.x address with a five-digit port is the longest shape this app produces, and the
    // one most likely to overflow into a denser symbol than the layout expects.
    for (const url of [
      "http://10.0.0.7:3720",
      "http://172.16.31.254:65535",
      "http://192.168.0.1:8080",
      "http://my-macbook.local:54321",
    ]) {
      expect(roundTrip(url), url).toBe(url);
    }
  });

  it("produces a square of the size it reports", () => {
    const modules = qrModules("http://192.168.1.100:54321");
    expect(modules.length).toBeGreaterThan(20);
    for (const row of modules) expect(row).toHaveLength(modules.length);
  });

  it("is deterministic", () => {
    // The panel re-encodes on every state push; a code that changed shape between renders
    // would flicker under the camera that is trying to read it.
    expect(qrModules("http://10.0.0.7:3720")).toEqual(qrModules("http://10.0.0.7:3720"));
  });
});

describe("qrRuns", () => {
  it("covers every dark module exactly once", () => {
    const modules = qrModules("http://192.168.1.100:54321");
    const covered = modules.map((row) => row.map(() => 0));

    for (const run of qrRuns(modules)) {
      const row = covered[run.row]!;
      for (let i = 0; i < run.length; i += 1) row[run.start + i] = (row[run.start + i] ?? 0) + 1;
    }

    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        // A dark module drawn twice is a rectangle drawn twice; a light one drawn at all is
        // a hole in the code.
        expect(covered[y]?.[x], `module ${y},${x}`).toBe(dark ? 1 : 0);
      });
    });
  });

  it("merges a horizontal line into one run rather than one run per module", () => {
    const modules = [
      [true, true, true, false, true],
      [false, true, false, false, false],
    ];
    expect(qrRuns(modules)).toEqual([
      { row: 0, start: 0, length: 3 },
      { row: 0, start: 4, length: 1 },
      { row: 1, start: 1, length: 1 },
    ]);
  });

  it("copes with a code that is dark at both ends of a row", () => {
    // The run-merging loop only closes a run when it meets a light module, so a row ending
    // dark has to be closed by the loop bound rather than by a finding.
    expect(qrRuns([[true, false, true]])).toEqual([
      { row: 0, start: 0, length: 1 },
      { row: 0, start: 2, length: 1 },
    ]);
  });
});
