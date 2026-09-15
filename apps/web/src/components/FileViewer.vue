<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useLocale } from "../composables/locale";
import { useTheme } from "../composables/theme";
import Icon from "./Icon.vue";
import { fileViewerSupported, viewerLocale, viewerThemeOption } from "../utils/fileViewer";
import { loadFileViewer } from "../utils/openFileViewer";

/**
 * A binary file, drawn by the viewer library.
 *
 * `MermaidDiagram`'s twin, and for the same reasons: the library is async, its instances own
 * resources that outlive a detached node — object URLs, listeners, a canvas, a WebGL context —
 * and it has to be destroyed rather than left behind. So this owns a lifecycle instead of being
 * a step in the dialog's template.
 *
 * It owns **both gates**, which is why the dialog's exhaustive switch can stay a pure function
 * of `kind`. `fileViewerSupported` is ours and is answered from the file name, so a `.bin`
 * never fetches a byte and never loads the chunk; `isPreviewSupported` is the library's, and it
 * is the authority once the chunk is in hand — it is a *second* opinion rather than a copy of
 * the library's format list, which is the whole reason the server stopped guessing.
 *
 * `data-render-state` is not decoration: it is what makes an async third-party render
 * assertable. A spec that waited for an `<img>` could not tell "still loading" from "loaded
 * nothing". See `e2e/diagram.spec.ts` for the argument in full — this is the second renderer to
 * inherit it.
 *
 * **But `ready` means less here than it does for mermaid, and the difference is the library's.**
 * `onLoad` fires when the viewer has taken the file, not when a plugin drew it: a PNG whose
 * bytes do not decode still reaches `ready`, because the image plugin handles that itself by
 * replacing its stage with its own failure panel. There is no callback for it, so this attribute
 * cannot be made to mean "it worked". A spec must therefore assert on the *content* — a
 * `naturalWidth`, a canvas with pixels — and `ready` is only the thing to wait for first. This
 * was not obvious: the first version of the image spec passed on `ready` while the picture was
 * an error panel.
 */

const props = defineProps<{
  /** The bytes, or null when the file failed our own gate and was never fetched. */
  file: File | null;
  /** The file's name. Load-bearing: the viewer matches its plugins by name, not by type. */
  name: string;
}>();

const { t } = useI18n();
const theme = useTheme();
const { locale } = useLocale();

type State = "rendering" | "ready" | "failed" | "unsupported";

const state = ref<State>("rendering");
/** The library's own message: dynamic English with no code to key on, like mermaid's. */
const detail = ref("");
const host = ref<HTMLElement | null>(null);

/** Which run is allowed to write the state; bumped by every run, so a late resolve is dropped. */
let token = 0;
/** Set on unmount: the refs outlive the DOM, so there is nothing left to write into. */
let disposed = false;
let viewer: { destroy(): void } | null = null;

async function run(): Promise<void> {
  const mine = ++token;

  // The half that is easy to forget and the half that fails quietly — a viewer left alive keeps
  // its canvas, its workers and every object URL it made for the life of the page.
  viewer?.destroy();
  viewer = null;

  // Our gate first, and it is what keeps the chunk off the wire for a file nothing can draw.
  if (!props.file || !fileViewerSupported(props.name)) {
    state.value = "unsupported";
    detail.value = "";
    return;
  }

  state.value = "rendering";
  detail.value = "";
  try {
    const { module: mod, plugins } = await loadFileViewer();
    if (mine !== token || disposed || !host.value) return;

    if (!(await mod.isPreviewSupported(props.file, plugins, { fileName: props.name }))) {
      if (mine !== token || disposed) return;
      state.value = "unsupported";
      return;
    }
    // Checked again: the support probe is async, so the host may have gone or a newer run may
    // have started while it was in flight.
    if (mine !== token || disposed || !host.value) return;

    viewer = mod.createViewer({
      container: host.value,
      file: props.file,
      fileName: props.name,
      // "100%" rather than a pixel size: the host is a flex child, and the library measures its
      // container. A container with no height renders nothing and says nothing about why.
      width: "100%",
      height: "100%",
      theme: viewerThemeOption(theme.resolved.value),
      locale: viewerLocale(locale.value),
      plugins,
      toolbar: true,
      onLoad: () => {
        if (mine === token && !disposed) state.value = "ready";
      },
      onError: (error: Error) => {
        if (mine !== token || disposed) return;
        detail.value = error?.message ?? String(error);
        state.value = "failed";
      },
      onUnsupported: () => {
        if (mine === token && !disposed) state.value = "unsupported";
      },
    });
  } catch (err) {
    if (mine !== token || disposed) return;
    detail.value = err instanceof Error ? err.message : String(err);
    state.value = "failed";
  }
}

/*
 * `onMounted` rather than a `watch` with `immediate`, which is where this departs from
 * `MermaidDiagram`: that one draws into a string, and this one needs a real element with real
 * dimensions, so it cannot run before the template exists.
 *
 * The theme and the locale are dependencies because the library takes both at **create** time.
 * The vendor stylesheet maps onto our tokens, so the chrome repaints itself through CSS on a
 * theme flip — but the plugins that paint into a canvas do not, and the toolbar's words are
 * fixed when it is built. Re-creating is the honest answer for both, and it only ever happens
 * while someone is looking at a preview.
 */
onMounted(run);
watch([() => props.file, () => props.name, theme.resolved, locale], run);

onBeforeUnmount(() => {
  disposed = true;
  viewer?.destroy();
  viewer = null;
});
</script>

<template>
  <div
    class="file-viewer"
    data-testid="file-viewer"
    :data-render-state="state"
    :aria-busy="state === 'rendering'"
  >
    <p v-if="state === 'rendering'" class="note" data-testid="file-viewer-rendering">
      {{ t("files.preview.loading") }}
    </p>

    <!--
      Our own panel, rather than the library's. It is reached from two directions — a file the
      viewer has no plugin for, and one that failed while drawing it — and the first is a fact
      about the library that the reader should meet as an ordinary answer rather than as an
      error. The testid is the one the dialog used before this existed, so the browser suite's
      assertion on an unpreviewable file keeps its meaning.
    -->
    <div v-else-if="state === 'unsupported'" class="note" data-testid="file-preview-unsupported">
      <Icon name="file" />
      <p class="reason">{{ t("files.preview.unsupported") }}</p>
      <p class="hint">{{ t("files.preview.unsupportedHint") }}</p>
    </div>

    <div v-else-if="state === 'failed'" class="note" data-testid="file-viewer-failed">
      <p class="reason error">{{ t("files.preview.viewerFailed") }}</p>
      <!-- The library's sentence, untranslated on purpose: dynamic vendor text with no code to
           key on, the same treatment a provider's raw failure gets. It is what says *where* it
           broke, so it earns its untranslated line. -->
      <code v-if="detail" class="detail">{{ detail }}</code>
    </div>

    <!--
      Always in the DOM, never `v-if`. The library measures and writes into this element, so it
      has to exist before the viewer is created and has to survive a re-render; `v-if` would
      hand `createViewer` a null on the frame it matters and would tear the element out from
      under a viewer that is still alive. Hidden rather than empty while a panel above is
      showing, so its zero-height measurement cannot confuse anything.
    -->
    <div ref="host" class="host" :class="{ 'host-hidden': state !== 'ready' }"></div>
  </div>
</template>

<style scoped>
.file-viewer {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.host {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.host-hidden {
  visibility: hidden;
  position: absolute;
  inset: 0;
}
.note {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-2);
  text-align: center;
}
.reason {
  margin: 0;
}
.reason.error {
  color: var(--danger-text);
}
.hint {
  margin: 0;
  color: var(--text-3);
}
.detail {
  color: var(--text-3);
  font-size: var(--fs-2);
  word-break: break-word;
}
</style>
