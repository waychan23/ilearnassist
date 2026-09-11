import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * Draw `assets/icon.icns`.
 *
 * Committed as a script rather than as a binary so the mark is reviewable and changeable:
 * a `.icns` in the repository is a file nobody can read, and the next person who wants the
 * accent colour to move cannot tell whether it did. Run `pnpm --filter
 * @guided-learning/desktop icon` after editing anything below, and commit the result — the
 * build does not depend on this script, only the icon does.
 *
 * Rasterised with signed distance fields rather than through a drawing library, so the
 * output has real anti-aliasing at 16px (where a hard-edged rasteriser turns the mark into
 * a blob) with no dependency to install. The shapes are a rounded-rectangle "squircle" tile
 * with a chat bubble on it, which is what the product is: a conversation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const assetsDir = join(desktopRoot, "assets");
const iconsetDir = join(assetsDir, "icon.iconset");

const SIZE = 1024;
/** Apple's macOS icon grid: the art is inset so it lines up with the system's own icons. */
const INSET = 100;
const TILE_RADIUS = 186;

/** Accent ramp, top to bottom. The same blues as `--accent` in the app's dark palette. */
const GRADIENT_TOP = [110, 168, 255];
const GRADIENT_BOTTOM = [47, 111, 235];
const MARK = [255, 255, 255];

/**
 * Signed distance to a rounded box. Negative inside, positive outside, and in pixels — the
 * unit matters because the anti-aliasing ramp below is one pixel wide.
 */
function roundedBox(px, py, x0, y0, x1, y1, radius) {
  const dx = Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - radius);
  const dy = Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to the line through `a`–`b`, positive on one side and negative on the other. */
function lineSide(px, py, a, b) {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  return (ex * (py - a[1]) - ey * (px - a[0])) / Math.hypot(ex, ey);
}

/**
 * Signed distance to a convex polygon, by taking the furthest of its edge half-planes.
 *
 * The winding is discovered rather than assumed: the sign is sampled at the centroid, which
 * is inside for any convex polygon, and flipped if the edges came out facing the other way.
 * That saves getting the y-down handedness right by hand, which is the kind of thing that
 * silently produces an inside-out shape.
 */
function convexPolygon(px, py, points, centreSign) {
  let furthest = -Infinity;
  for (let i = 0; i < points.length; i += 1) {
    // The sign has to be applied to each half-plane *before* the max. Negating the max
    // instead inverts the answer wherever the edges disagree — which is everywhere outside
    // the polygon, so the tail came out filled across the whole tile.
    const value = centreSign * lineSide(px, py, points[i], points[(i + 1) % points.length]);
    if (value > furthest) furthest = value;
  }
  return furthest;
}

function polygonCentreSign(points) {
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  let furthest = -Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const value = lineSide(cx, cy, points[i], points[(i + 1) % points.length]);
    if (value > furthest) furthest = value;
  }
  return furthest > 0 ? -1 : 1;
}

/** Cover of a pixel, from its distance: fully inside, fully outside, or one pixel of ramp. */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/**
 * The mark: a speech bubble with a tail at its lower left.
 *
 * The tail is a separate triangle that overlaps the body on purpose — unioning two shapes
 * that merely touch leaves a hairline seam where their anti-aliased edges both come up
 * short of full cover.
 */
const BUBBLE = { x0: 286, y0: 332, x1: 738, y1: 636, radius: 84 };
const TAIL = [
  [356, 588],
  [500, 588],
  [366, 754],
];

function render() {
  const tileA = INSET;
  const tileB = SIZE - INSET;
  const tailSign = polygonCentreSign(TAIL);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      // Sample at pixel centres, so the tile lands symmetrically in the canvas.
      const px = x + 0.5;
      const py = y + 0.5;

      const tile = coverage(roundedBox(px, py, tileA, tileA, tileB, tileB, TILE_RADIUS));
      if (tile <= 0) continue;

      const mix = (py - tileA) / (tileB - tileA);
      const background = [
        GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * mix,
        GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * mix,
        GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * mix,
      ];

      const body = coverage(roundedBox(px, py, BUBBLE.x0, BUBBLE.y0, BUBBLE.x1, BUBBLE.y1, BUBBLE.radius));
      const tail = coverage(convexPolygon(px, py, TAIL, tailSign));
      // Union: the nearer surface wins.
      const markCover = Math.max(body, tail);

      const offset = (y * SIZE + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = Math.round(
          background[channel] * (1 - markCover) + MARK[channel] * markCover
        );
      }
      rgba[offset + 3] = Math.round(tile * 255);
    }
  }

  return rgba;
}

// ---- a minimal PNG encoder -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10–12 stay zero: deflate, adaptive filtering, no interlace.

  // PNG scanlines each carry a filter byte; 0 means "none", which costs a little size and
  // saves the encoder needing a heuristic per row.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The set of sizes `iconutil` requires. The `@2x` entries are the same pixels as the next step up. */
const ICONSET = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

function main() {
  if (process.platform !== "darwin") {
    // `iconutil` and `sips` are macOS tooling. The `.png` is still written, which is what
    // the Windows and Linux builders will want when they are added.
    console.warn("[icon] not on macOS: writing assets/icon.png only, no .icns");
  }

  mkdirSync(assetsDir, { recursive: true });
  const png = encodePng(render(), SIZE);
  writeFileSync(join(assetsDir, "icon.png"), png);
  console.log(`[icon] assets/icon.png (${SIZE}×${SIZE})`);

  if (process.platform !== "darwin") return;

  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  for (const [size, name] of ICONSET) {
    execFileSync("sips", ["-z", String(size), String(size), join(assetsDir, "icon.png"), "--out", join(iconsetDir, name)], {
      stdio: "ignore",
    });
  }
  execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", join(assetsDir, "icon.icns")]);
  rmSync(iconsetDir, { recursive: true, force: true });
  console.log("[icon] assets/icon.icns");
}

main();
