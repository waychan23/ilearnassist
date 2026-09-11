import { describe, expect, it } from "vitest";
import { sourceFiles } from "../helpers/catalog";

/**
 * The guard that keeps the catalog current.
 *
 * Everything else in `test/i18n/` checks the catalogs against each other. This checks the
 * *source*: a user-facing string added straight into a template or a script would render
 * fine in Chinese and be invisible to every other test — which is exactly how a UI drifts
 * back to one language a string at a time.
 *
 * A deliberate exception carries a `// i18n-exempt: <reason>` line comment; the marker is
 * greppable on purpose, so `grep -rn "i18n-exempt" apps/web/src` showing more than the
 * handful below is a review signal rather than a nuisance.
 */

/**
 * CJK ideographs plus the punctuation that travels with them.
 *
 * The fullwidth-forms block (U+FF00-FFEF) is deliberately excluded: it is mostly
 * width-variant glyphs rather than words, and the fullwidth plus is used here as an icon
 * on the "new workspace" button. Any real Chinese sentence contains ideographs and is
 * still caught, so dropping that block costs no real detection.
 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** The catalogs are where this text is *supposed* to live. */
const isCatalog = (path: string): boolean => path.includes("/locales/");

/**
 * Whether the marker excuses a line. It may sit on the line itself or on the one directly
 * above it — a trailing comment would make an already dense regex line unreadable.
 */
const isExempt = (lines: string[], index: number): boolean =>
  (lines[index] ?? "").includes("i18n-exempt:") ||
  (lines[index - 1] ?? "").includes("i18n-exempt:");

interface Offence {
  file: string;
  line: number;
  text: string;
}

/**
 * Strip comments **one line at a time**, so line numbers survive.
 *
 * The shared `stripComments` collapses a block comment to nothing, which shifts every line
 * after it — and this test reports line numbers, and reads the exemption marker off the
 * raw line above a hit. A `//` not preceded by `:` is treated as a comment, so a URL in a
 * string is not truncated.
 */
function strippedLines(raw: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of raw.split("\n")) {
    let s = line;
    if (inBlock) {
      const end = s.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      s = s.slice(end + 2);
      inBlock = false;
    }
    s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    const blockStart = s.indexOf("/*");
    if (blockStart !== -1) {
      s = s.slice(0, blockStart);
      inBlock = true;
    }
    s = s.replace(/(^|[^:])\/\/.*$/, "$1");
    out.push(s);
  }
  return out;
}

function offences(): Offence[] {
  const found: Offence[] = [];
  for (const [file, raw] of Object.entries(sourceFiles())) {
    if (isCatalog(file)) continue;

    // Comments are stripped first: a Chinese example in a doc comment is documentation,
    // and rewriting the codebase's prose into English is not what this is for.
    const rawLines = raw.split("\n");
    strippedLines(raw).forEach((text, index) => {
      if (CJK.test(text) && !isExempt(rawLines, index)) {
        found.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}

describe("no hardcoded user-facing text", () => {
  it("has no CJK outside the catalogs", () => {
    const found = offences().map((o) => `${o.file}:${o.line}  ${o.text}`);
    expect(found).toEqual([]);
  });

  it("keeps the exemption list down to the ones that are genuinely not copy", () => {
    // A budget, not a count: the point is that growing this number is a decision someone
    // has to make deliberately, not something that happens one hurried commit at a time.
    const exempt = Object.entries(sourceFiles())
      .filter(([file]) => !isCatalog(file))
      .flatMap(([file, raw]) => raw.split("\n").map((l) => ({ file, l })))
      .filter(({ l }) => l.includes("i18n-exempt:"));

    const files = new Set(exempt.map((e) => e.file));
    expect(files.size).toBeLessThanOrEqual(2);
  });
});
