import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * Draw the icon set: `assets/icon.icns` for macOS, `assets/icon.ico` for Windows, and the
 * PNGs the Linux targets use.
 *
 * Committed as a script rather than as binaries so the mark is reviewable and changeable:
 * an `.icns` in the repository is a file nobody can read, and the next person who wants the
 * accent colour to move cannot tell whether it did. Run `pnpm --filter
 * @ilearnassist/desktop icon` after editing anything below, and commit the result — the
 * build does not depend on this script, only the icons do.
 *
 * Rasterised with signed distance fields rather than through a drawing library, so the
 * output has real anti-aliasing at 16px (where a hard-edged rasteriser turns the mark into
 * a blob) with no dependency to install. The shapes are a rounded-rectangle "squircle" tile
 * with a chat bubble on it, which is what the product is: a conversation.
 *
 * **Everything is drawn at the size it is used at, never scaled down.** Geometry is derived
 * from `size` rather than written in pixels, because a 1024px raster reduced to 16 turns the
 * bubble's tail into a smudge — which is the same reason the tray mark has proportions of
 * its own. The fractions reproduce the original 1024px numbers exactly, so `icon.png` and
 * `icon.icns` are unchanged by the parameterisation.
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
 * The mark: a speech bubble with a tail at its lower left, as fractions of the canvas.
 *
 * The tail is a separate triangle that overlaps the body on purpose — unioning two shapes
 * that merely touch leaves a hairline seam where their anti-aliased edges both come up
 * short of full cover.
 *
 * Written as fractions rather than pixels because the icon is drawn at 1024 for macOS and at
 * 16, 32, 48 and 256 for a Windows `.ico`, and a reduction of the big one is a smudge. Each
 * fraction is the original pixel value over 1024, so at 1024 the geometry below is identical
 * to the numbers this started as — which is what keeps the committed `.icns` unchanged.
 */
const BUBBLE = { x0: 286 / 1024, y0: 332 / 1024, x1: 738 / 1024, y1: 636 / 1024, radius: 84 / 1024 };
const TAIL = [
  [356 / 1024, 588 / 1024],
  [500 / 1024, 588 / 1024],
  [366 / 1024, 754 / 1024],
];

/** The mark, drawn on its tile at `size`×`size`. */
function render(size = SIZE) {
  const tileA = (INSET / SIZE) * size;
  const tileB = size - tileA;
  const tileRadius = (TILE_RADIUS / SIZE) * size;

  const bubble = {
    x0: BUBBLE.x0 * size,
    y0: BUBBLE.y0 * size,
    x1: BUBBLE.x1 * size,
    y1: BUBBLE.y1 * size,
    radius: BUBBLE.radius * size,
  };
  const tail = TAIL.map(([x, y]) => [x * size, y * size]);
  const tailSign = polygonCentreSign(tail);
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Sample at pixel centres, so the tile lands symmetrically in the canvas.
      const px = x + 0.5;
      const py = y + 0.5;

      const tile = coverage(roundedBox(px, py, tileA, tileA, tileB, tileB, tileRadius));
      if (tile <= 0) continue;

      const mix = (py - tileA) / (tileB - tileA);
      const background = [
        GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * mix,
        GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * mix,
        GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * mix,
      ];

      // No extra softening at small sizes: the coverage ramp is one *pixel in the drawing's
      // own units*, which is what makes a 16px render crisp rather than a reduction of the
      // 1024px one. Blurring the distance instead — the obvious-looking fix — drives every
      // distance toward zero and paints the whole tile half white.
      const body = coverage(
        roundedBox(px, py, bubble.x0, bubble.y0, bubble.x1, bubble.y1, bubble.radius)
      );
      const tailCover = coverage(convexPolygon(px, py, tail, tailSign));
      // Union: the nearer surface wins.
      const markCover = Math.max(body, tailCover);

      const offset = (y * size + x) * 4;
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

/**
 * The menu-bar / tray mark: the same speech bubble, without the macOS icon-grid tile.
 *
 * `rgb` is `null` for macOS and a colour for everywhere else, and that is the whole reason
 * this takes an argument. **macOS wants a template image**: shape only, black pixels with an
 * alpha channel, which it draws in whatever colour the menu bar currently needs — inverting
 * it for dark mode and dimming it when the app is not frontmost. Any hue written into those
 * channels is discarded. **Windows and Linux have no such convention**, so a template image
 * there is a black glyph on a dark taskbar, which is indistinguishable from a missing icon.
 * They get the accent colour, which is visible on either background.
 *
 * Drawn at each size rather than scaled down from the app icon, because a 16px reduction of
 * the 1024px artwork turns the bubble's tail into a smudge. The proportions are restated for
 * the small canvas instead: a wider margin, a shallower tail, and a thicker body.
 */
function renderTray(size, rgb) {
  const margin = size * 0.08;
  const body = {
    x0: margin,
    y0: size * 0.14,
    x1: size - margin,
    y1: size * 0.66,
    radius: size * 0.17,
  };
  const tail = [
    [size * 0.28, size * 0.6],
    [size * 0.52, size * 0.6],
    [size * 0.3, size * 0.9],
  ];
  const tailSign = polygonCentreSign(tail);
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const cover = Math.max(
        coverage(roundedBox(px, py, body.x0, body.y0, body.x1, body.y1, body.radius)),
        coverage(convexPolygon(px, py, tail, tailSign))
      );
      const offset = (y * size + x) * 4;
      if (rgb) {
        for (let channel = 0; channel < 3; channel += 1) rgba[offset + channel] = rgb[channel];
      }
      // For a template image RGB stays zero: the channels are ignored for drawing, and
      // leaving them white would make this file look like a white square in any viewer.
      rgba[offset + 3] = Math.round(cover * 255);
    }
  }

  return rgba;
}

/** The colour a non-macOS tray icon is drawn in: the accent ramp's middle, legible on light or dark. */
const TRAY_RGB = [78, 140, 245];

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

// ---- a minimal ICO encoder -------------------------------------------------

/**
 * The sizes a Windows `.ico` carries, and where each is actually seen: 16 in the title bar and
 * the small taskbar, 32 in the taskbar and Alt-Tab, 48 in Explorer's default (medium) view,
 * 256 for the large-thumbnails view. Shipping only one size is what makes an app look blurry in
 * Explorer and fine everywhere else, which is a bug nobody traces back to its icon.
 */
const ICO_SIZES = [16, 32, 48, 256];

/**
 * An `.ico` holding PNG-compressed entries.
 *
 * The format allows either a BMP or a PNG payload per entry, and every Windows this app runs on
 * reads the PNG form (Vista and later) — which is why there is no BMP encoder here, and why the
 * entries above can be the same PNG encoder the other platforms use.
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved, always 0
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  // The payloads start after the directory, in the order they are listed.
  let offset = header.length + directory.length;

  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    // 0 means 256 in these two fields — the only way 256 fits in a byte, and the reason a
    // 256px-only icon written as 255 looks nearly right and is wrong.
    const dimension = size >= 256 ? 0 : size;
    directory[at] = dimension;
    directory[at + 1] = dimension;
    directory[at + 2] = 0; // palette size: 0 for a true-colour image
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
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
    // `iconutil` and `sips` are macOS tooling, so the `.icns` cannot be rebuilt here. Every
    // other artefact can, and the `.icns` is committed — so this is a note rather than a
    // failure, and the Windows and Linux icons are still refreshed.
    console.warn("[icon] not on macOS: skipping assets/icon.icns (macOS tooling)");
  }

  mkdirSync(assetsDir, { recursive: true });

  // Linux wants a plain PNG, and electron-builder reads it at whatever size it needs. 512 is
  // the size freedesktop.org's icon themes top out at for an application icon.
  for (const [size, name] of [
    [SIZE, "icon.png"],
    [512, "icon-512.png"],
  ]) {
    writeFileSync(join(assetsDir, name), encodePng(render(size), size));
    console.log(`[icon] assets/${name} (${size}×${size})`);
  }

  writeFileSync(
    join(assetsDir, "icon.ico"),
    encodeIco(ICO_SIZES.map((size) => ({ size, png: encodePng(render(size), size) })))
  );
  console.log(`[icon] assets/icon.ico (${ICO_SIZES.join(", ")})`);

  /*
   * Two tray marks per size, and the pair is not redundancy.
   *
   * `trayTemplate` is the macOS one: the `Template` suffix is what tells macOS to recolour it,
   * and the `@2x` sibling is what keeps it sharp on a Retina menu bar — both names are
   * load-bearing. `tray` is the coloured one Windows and Linux get, because they have no
   * template-image convention and would draw the black glyph as a near-invisible smudge on a
   * dark taskbar. `main.ts` picks by platform; whichever file it asks for must exist.
   */
  for (const [size, suffix] of [
    [16, ""],
    [32, "@2x"],
  ]) {
    writeFileSync(
      join(assetsDir, `trayTemplate${suffix}.png`),
      encodePng(renderTray(size, null), size)
    );
    writeFileSync(
      join(assetsDir, `tray${suffix}.png`),
      encodePng(renderTray(size, TRAY_RGB), size)
    );
    console.log(`[icon] assets/tray*${suffix}.png (${size}×${size})`);
  }

  if (process.platform !== "darwin") return;

  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  // `sips` resamples the committed 1024px PNG rather than the script re-rendering each size:
  // the `.icns` is a macOS artefact and its sizes are all large enough that a downsample of
  // the master is what Apple's own tooling expects.
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
