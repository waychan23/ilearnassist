import { describe, expect, it, vi } from "vitest";
import {
  fileViewerSupported,
  viewerLocale,
  viewerThemeOption,
} from "../../src/utils/fileViewer.js";

/**
 * Did anything import the viewer library?
 *
 * Set by the mocked factory, which vitest runs the first time `"@open-file-viewer/core"` is
 * imported by anything under test. `vi.mock` is hoisted above this file's imports, so the
 * answer at the end of the file is a statement about the modules under test rather than about
 * this test.
 *
 * This is the assertion that matters most in the file, and it is the reason the module boundary
 * is where it is. `FilePreviewDialog` is always mounted and imports `utils/fileViewer.ts`
 * eagerly; the library is ~25 runtime dependencies behind one entry point with no `sideEffects`
 * field and no way to shake any of them. A static import added anywhere on the eager path would
 * put all of it — `three`, `leaflet`, `xlsx`, a second mermaid — into the initial bundle, and
 * nothing else in this suite would notice.
 */
const viewerLoaded = vi.hoisted(() => ({ value: false }));

vi.mock("@open-file-viewer/core", () => {
  viewerLoaded.value = true;
  // Never called. The shape only has to be good enough that importing it would not throw.
  return { createViewer: () => ({ destroy: () => {} }), isPreviewSupported: async () => false };
});

describe("fileViewerSupported", () => {
  it("claims the formats the viewer has plugins for", () => {
    // One representative per family, because the point is the families rather than the entries:
    // images, documents, the two Office halves, archives, mail, drawings, 3D and GIS.
    for (const name of [
      "shot.png",
      "photo.heic",
      "report.pdf",
      "book.epub",
      "letter.docx",
      "sheet.xlsx",
      "deck.pptx",
      "slides.odp",
      "bundle.zip",
      "message.eml",
      "sketch.excalidraw",
      "notes.xmind",
      "model.glb",
      "map.kmz",
    ]) {
      expect(fileViewerSupported(name), name).toBe(true);
    }
  });

  it("declines what the viewer cannot draw", () => {
    // `.bin` and `.dat` are the ones the browser suite leans on: no plugin claims them, so a
    // preview must reach the unsupported panel without fetching a byte.
    for (const name of ["data.bin", "blob.dat", "program.exe", "lib.jar"]) {
      expect(fileViewerSupported(name), name).toBe(false);
    }
  });

  it("declines everything the server calls text", () => {
    /*
     * The important half of the gate, and it is not about the viewer's abilities. `svg`,
     * `geojson`, `csv` and `kml` are all formats the library can render and all valid UTF-8, so
     * the *server* sends them down the `text` path and they never reach a viewer. Claiming them
     * here would be dead weight — and a silent one, since the chunk would load and then never be
     * asked anything.
     */
    for (const name of ["drawing.svg", "map.geojson", "route.kml", "table.csv", "README.md"]) {
      expect(fileViewerSupported(name), name).toBe(false);
    }
  });

  it("needs an extension to answer", () => {
    // `Makefile` and `LICENSE` are read as text by the sniff; there is nothing here to match on.
    expect(fileViewerSupported("Makefile")).toBe(false);
    expect(fileViewerSupported("LICENSE")).toBe(false);
    // A leading dot is a dotfile, not an extension.
    expect(fileViewerSupported(".gitignore")).toBe(false);
  });

  it("is case-blind", () => {
    expect(fileViewerSupported("PHOTO.PNG")).toBe(true);
    expect(fileViewerSupported("Report.Pdf")).toBe(true);
  });
});

describe("viewerThemeOption", () => {
  it("never returns auto", () => {
    /*
     * The reason this function exists at all. `<html data-theme>` carries the *mode*, so
     * `"auto"` means "the CSS media query decides" — and a library that reads
     * `prefers-color-scheme` itself would then disagree with a user who forced the opposite.
     * The resolved theme is the only honest input, and the narrowed return type is what stops
     * the mode being passed back through.
     */
    expect(viewerThemeOption("light")).toBe("light");
    expect(viewerThemeOption("dark")).toBe("dark");
  });
});

describe("viewerLocale", () => {
  it("maps our two catalogs onto the library's two", () => {
    expect(viewerLocale("zh-CN")).toBe("zh-CN");
    expect(viewerLocale("en")).toBe("en-US");
  });
});

describe("the viewer library is not on the eager path", () => {
  it("was never evaluated by importing utils/fileViewer.ts", () => {
    // Everything above ran without touching it. If this fails, something in the eagerly imported
    // graph gained a static import of the library and the initial bundle just grew by ~826 kB.
    expect(viewerLoaded.value).toBe(false);
    // And the exports really are the pure ones — a smoke check that the assertion above is about
    // a module this file actually loaded rather than one it never reached.
    expect(typeof fileViewerSupported).toBe("function");
  });
});
