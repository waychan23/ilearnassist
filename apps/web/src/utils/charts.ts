import type { ResolvedTheme } from "../composables/theme";

/**
 * Chart.js, loaded on demand, drawn with the app's own colours.
 *
 * The shape is `utils/mermaid.ts`'s, and for the same two reasons.
 *
 * **The import is behind a memoized promise inside a function**, so importing this module costs
 * nothing: the library is fetched when a statistics page first draws a chart, and a page with four
 * charts on it shares one fetch. A static import would put it in the initial bundle for a screen
 * most sessions never open — the argument `utils/openFileViewer.ts` makes for the same move.
 *
 * **The colours are concrete, never `var(--token)` strings.** Chart.js paints to a canvas, and a
 * canvas has no cascading context: `ctx.fillStyle = "var(--accent)"` is not a colour, it is a
 * string the canvas silently ignores (leaving the previous fill, which is how a chart ends up
 * uni-coloured). This is mermaid's problem verbatim, and the answer is the same — read the computed
 * value out of the stylesheet and hand over a real colour.
 *
 * `chartTheme` takes a *reader* rather than reaching for `getComputedStyle` itself, which is what
 * makes it testable: jsdom does not apply `style.css`, so a real computed-style read returns `""`
 * in a unit test and the mapping would only ever be exercised in a browser.
 */

/** What `chartTheme` needs to know about the reader's theme, for the two things that differ. */
export interface ChartTheme {
  /** Text, axes and grid — one palette for both themes, because they are all `--text-*`. */
  text: string;
  muted: string;
  grid: string;
  /** The series colours, in order. */
  series: string[];
  /** The tooltip's own surface, which has to sit above the page. */
  tooltipBg: string;
  tooltipText: string;
}

/**
 * The palette a chart draws with.
 *
 * The series are the app's semantic colours rather than an invented palette, so a chart reads as
 * part of the interface instead of as something pasted into it — and so the light/dark rules those
 * tokens already carry apply to a canvas too.
 *
 * Four series, which is what the token breakdown needs and what a canvas can show before the
 * colours stop being tellable apart. The order is the order those figures are read in: what was
 * paid for in full, what came from the cache, what came back, and the share of it spent thinking.
 *
 * **No series uses `--text-3`**, which is the axis and grid label colour — a series the same
 * colour as the ticks beside it is one the reader has to work out. The last one is `--text-2`
 * anyway, because reasoning tokens are a *share of the output* rather than a fourth bucket, and a
 * neutral reads as the derived figure it is.
 */
export function chartTheme(read: (name: string) => string): ChartTheme {
  const value = (name: string, fallback: string): string => read(name).trim() || fallback;
  return {
    text: value("--text", "#1f2328"),
    muted: value("--text-3", "#6e7781"),
    grid: value("--border", "#d0d7de"),
    series: [
      value("--accent", "#0969da"),
      value("--success", "#1a7f37"),
      value("--warning", "#9a6700"),
      value("--text-2", "#57606a"),
    ],
    tooltipBg: value("--panel-2", "#f0f2f5"),
    tooltipText: value("--text", "#1f2328"),
  };
}

/** The reader `chartTheme` wants, over the live document. */
export function documentThemeReader(): (name: string) => string {
  return (name) => getComputedStyle(document.documentElement).getPropertyValue(name);
}

/**
 * A day key as a short axis label.
 *
 * `2026-09-17` → `09-17`, computed by slicing rather than by parsing: the string is already the
 * reader's local calendar day (the server cut it in their zone), and running it back through
 * `Date` would re-apply an offset to a value that has already been resolved once.
 *
 * The year is dropped on purpose — a range that spans a new year is rare enough that the full date
 * belongs in the tooltip, where there is room for it, rather than in every tick.
 */
export function shortDayLabel(key: string): string {
  const parts = key.split("-");
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : key;
}

/* ------------------------------- the lazy chunk ------------------------------- */

/** Chart.js, as this module uses it. Named rather than `typeof import` so the call sites read. */
export interface ChartKit {
  draw(canvas: HTMLCanvasElement, config: ChartConfig): ChartHandle;
}

/** What a caller asks for: a canvas, and the two shapes this app draws. */
export interface ChartConfig {
  kind: "line" | "bar";
  labels: string[];
  /** One entry per series, each as long as `labels`. */
  series: { label: string; data: number[] }[];
  theme: ChartTheme;
  /** Shown when the pointer rests on a point. */
  valueSuffix?: string;
}

export interface ChartHandle {
  update(config: ChartConfig): void;
  destroy(): void;
}

let kit: Promise<ChartKit> | undefined;

/**
 * Load Chart.js once, and adapt it to the two shapes here.
 *
 * The adapter is deliberately thin — a line for a time series and a horizontal bar for a
 * breakdown — because that is all this app draws, and every extra option would be width this
 * module maintains for a chart nothing asks for.
 */
export function chartKit(): Promise<ChartKit> {
  kit ??= import("chart.js").then(({ Chart, registerables }) => {
    // Registered wholesale rather than one controller at a time: the two shapes share scales, and
    // a hand-picked list is a list to get wrong the day a third is added.
    Chart.register(...registerables);
    return {
      draw(canvas, config) {
        const chart = new Chart(canvas, configurationOf(config));
        return {
          update(next) {
            chart.data = dataOf(next);
            chart.options = optionsOf(next);
            chart.update();
          },
          destroy() {
            chart.destroy();
          },
        };
      },
    };
  });
  return kit;
}

/** For the tests: forget the loaded module, so the next call re-imports. */
export function resetChartKit(): void {
  kit = undefined;
}

/* ---------------------------------- the config ---------------------------------- */

/**
 * These are Chart.js's own option objects.
 *
 * Typed with the library's exported types rather than `any`, and imported with `import type` so the
 * erasure leaves nothing behind — a value import here would pull Chart.js into the eager bundle and
 * undo the whole point of the lazy chunk above. The app-owned shape a caller passes is
 * `ChartConfig`; this is only the translation into Chart.js's vocabulary.
 */
/** The three halves Chart.js wants, assembled from the one shape this app passes around. */
function configurationOf(config: ChartConfig): ChartConfiguration {
  return { type: config.kind, data: dataOf(config), options: optionsOf(config) };
}

function dataOf(config: ChartConfig): ChartData {
  return {
    labels: config.labels,
    datasets: config.series.map((series, at) => {
      const colour = config.theme.series[at % config.theme.series.length] ?? config.theme.text;
      return {
        label: series.label,
        data: series.data,
        backgroundColor: config.kind === "bar" ? colour : "transparent",
        borderColor: colour,
        borderWidth: config.kind === "bar" ? 0 : 2,
        // A line over 30 days is 30 points, and the dots would be the whole picture.
        pointRadius: config.labels.length > 20 ? 0 : 2,
        tension: 0.2,
        fill: false,
      };
    }),
  };
}

function optionsOf(config: ChartConfig): ChartOptions {
  const { theme } = config;
  return {
    /*
     * The canvas is sized by its container, and `maintainAspectRatio: false` means it takes
     * exactly that box. A responsive chart that also kept its own ratio would fight the layout it
     * sits in — and the two charts on these pages are deliberately different heights.
     */
    responsive: true,
    maintainAspectRatio: false,
    /*
     * No animation, deliberately. A statistics page redraws on every date-range change, and a
     * tween between two datasets is a second of reading a shape that is not the answer yet. It is
     * also what keeps a theme flip from leaving a half-faded colour on the canvas.
     */
    animation: false,
    plugins: {
      legend: {
        // One series needs no key: the title above it already says what is plotted.
        display: config.series.length > 1,
        labels: { color: theme.text, boxWidth: 12, boxHeight: 12, usePointStyle: true },
      },
      tooltip: {
        backgroundColor: theme.tooltipBg,
        titleColor: theme.text,
        bodyColor: theme.text,
        borderColor: theme.grid,
        borderWidth: 1,
        callbacks: {
          // The full day, which the axis label truncates — this is where the year stays legible,
          // and where a token count gets its unit.
          label: (item) =>
            `${item.dataset.label ?? ""}: ${item.parsed.y}${config.valueSuffix ?? ""}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        // The labels are already short dates; rotating them spends height on nothing.
        ticks: { color: theme.muted, maxRotation: 0, autoSkipPadding: 12 },
      },
      y: {
        // Always from zero: a truncated axis makes a two-percent difference look like a doubling.
        beginAtZero: true,
        grid: { color: theme.grid },
        // Tokens are whole numbers, so a fractional tick is a number that cannot be spent.
        ticks: { color: theme.muted, precision: 0 },
      },
    },
  };
}

/**
 * `chart.js`'s types, on the erase side of the import.
 *
 * Named at the bottom rather than the top so the two functions above read first — and because a
 * reader wondering "is this lazy?" should meet the `import()` before the first `import type`.
 */
import type { ChartConfiguration, ChartData, ChartOptions } from "chart.js";
