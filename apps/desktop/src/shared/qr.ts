import qrcode from "qrcode-generator";

/**
 * Encoding the LAN address as a QR code.
 *
 * Split in two on purpose. `qrModules` is the code itself — a square of booleans, which is
 * the form an *independent* decoder can be handed in a test, so correctness is not a matter
 * of reading this file back to itself. `qrRuns` is presentation: the same square, merged
 * into horizontal runs, which is what keeps the rendered SVG to a handful of elements
 * instead of one per dark module.
 *
 * The renderer draws it as SVG rather than through the library's own `createSvgTag` or a
 * canvas: an SVG scales to whatever the window is on a Retina screen, is a single
 * `{ ... }` object to theme, and does not put a base64 blob in the DOM for the CSP to have
 * an opinion about.
 */

/** Error correction `M`: the conventional default, and forgiving of a photo taken at an angle. */
const ERROR_CORRECTION = "M";

export interface QrModule {
  row: number;
  start: number;
  length: number;
}

/**
 * The QR code for `text` as a square of dark/light modules.
 *
 * Type number 0 asks the library to pick the smallest version the payload fits in, which is
 * what keeps `http://192.168.1.100:54321` — 29 characters — from becoming a code too dense
 * for a phone camera at arm's length.
 */
export function qrModules(text: string): boolean[][] {
  const code = qrcode(0, ERROR_CORRECTION);
  code.addData(text);
  code.make();

  const size = code.getModuleCount();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let column = 0; column < size; column += 1) line.push(code.isDark(row, column));
    modules.push(line);
  }
  return modules;
}

/**
 * Merge each row's dark modules into runs, for drawing.
 *
 * A 33×33 code is up to 545 dark modules; as runs it is closer to 150 `<rect>`s, and a row
 * of contiguous dark modules is one rectangle rather than a stripe of them with hairlines
 * between.
 */
export function qrRuns(modules: boolean[][]): QrModule[] {
  const runs: QrModule[] = [];

  modules.forEach((line, row) => {
    let start = -1;
    for (let column = 0; column <= line.length; column += 1) {
      const dark = column < line.length && line[column] === true;
      if (dark && start === -1) start = column;
      if (!dark && start !== -1) {
        runs.push({ row, start, length: column - start });
        start = -1;
      }
    }
  });

  return runs;
}
