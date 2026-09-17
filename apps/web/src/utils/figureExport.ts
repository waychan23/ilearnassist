/**
 * Taking a picture out of the app.
 *
 * The viewer offers three formats because they answer three different needs rather than being
 * three spellings of one: **SVG** is the drawing itself — lossless, scalable, and what anything
 * that can open a diagram at all will take; **PNG** is a picture to paste, with transparency kept;
 * **JPG** is the same picture for the places that will not take a PNG or a transparent one, filled
 * with a background because the format has no alpha channel.
 *
 * Everything here is either pure arithmetic or a plain DOM call. The raster path needs an
 * `<img>`, a canvas and the browser's own SVG renderer, so it cannot be exercised in jsdom — the
 * parts a test *can* hold are split out (`downloadName`, `rasterSize`) and the rest is covered by
 * the browser suite, which downloads a real file and measures it.
 */

/** What the menu offers, in the order it offers them. PNG first: it is the common case. */
export const FIGURE_FORMATS = ["png", "jpg", "svg"] as const;

export type FigureFormat = (typeof FIGURE_FORMATS)[number];

/**
 * How much bigger than the drawing a raster is.
 *
 * Two, because the whole point of exporting a diagram is that it stays legible where it lands —
 * in a slide, in a document, in a chat window on a display that is not the one it was drawn on —
 * and a 1× raster of a 300px drawing is a thumbnail the moment anything scales it up. PNG and JPG
 * are the only formats this applies to; SVG has no resolution and ignores it.
 */
export const FIGURE_RASTER_SCALE = 2;

/** The file's extension, which is the format's own name for the two raster ones. */
const EXTENSIONS: Record<FigureFormat, string> = { png: "png", jpg: "jpg", svg: "svg" };

/** The canvas's MIME type. `jpeg`, not `jpg` — the format's name and its extension differ here. */
const MIME: Record<FigureFormat, string> = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" };

/**
 * What the file will be called.
 *
 * The drawing's name, minus whatever extension it arrived with — a diagram is called
 * `auth-flow.mmd` on disk, and `auth-flow.mmd.png` is a name nobody typed. Falls back to the
 * format's own name so the download always has one, since a browser given no `download` attribute
 * invents `download` with no extension.
 *
 * The name is written into a `download` attribute rather than a path, so this does not sanitise:
 * a `/` in a name cannot escape anything, and a name that lost its characters would be a name the
 * user does not recognise. It is trimmed and capped, which is about the filesystem rather than
 * about safety.
 */
export function downloadName(name: string | undefined, format: FigureFormat): string {
  const stem = (name ?? "").replace(/\.[^./\\]+$/, "").trim().slice(0, 80);
  return `${stem || "figure"}.${EXTENSIONS[format]}`;
}

/**
 * The pixel size of a raster of `size` at `scale`.
 *
 * Rounded up, and floored at one pixel: a canvas of zero is a `SecurityError` on some browsers
 * and a blank image on the others, and a drawing whose natural width rounds to nothing is a
 * drawing with no viewBox — which the caller does not reach, but a zero here would fail in a way
 * nobody could read.
 */
export function rasterSize(
  size: { width: number; height: number },
  scale: number = FIGURE_RASTER_SCALE
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.ceil(size.width * scale)),
    height: Math.max(1, Math.ceil(size.height * scale)),
  };
}

/** The drawing itself, as a file. The SVG is passed through untouched — it *is* the drawing. */
export function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: MIME.svg });
}

/**
 * The drawing as a raster.
 *
 * `background` is only meaningful for JPG, which has no alpha: left transparent it comes out with
 * black where the page was, because the format has nothing to put there. The caller passes the
 * theme's own surface colour rather than white, since the drawing is coloured for the palette it
 * was drawn in and a dark-theme diagram on a white field is unreadable.
 *
 * Rejects when the browser cannot draw the SVG into an image — which is the honest outcome for a
 * malformed one, and the caller reports it rather than writing an empty file.
 */
export async function rasterBlob(
  svg: string,
  format: "png" | "jpg",
  size: { width: number; height: number },
  background?: string
): Promise<Blob> {
  const url = URL.createObjectURL(svgBlob(svg));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("the drawing could not be rasterised"));
      image.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this browser gave no 2d canvas context");

    if (format === "jpg" && background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.drawImage(image, 0, 0, size.width, size.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, MIME[format], 0.92)
    );
    if (!blob) throw new Error("the canvas produced no image");
    return blob;
  } finally {
    // Revoked either way: an object URL lives until the document does, and a viewer opened and
    // closed a few times would hold every drawing it ever showed.
    URL.revokeObjectURL(url);
  }
}

/** Hand a blob to the browser as a download, and let go of it. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
