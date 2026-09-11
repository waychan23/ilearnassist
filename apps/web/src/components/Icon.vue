<script setup lang="ts">
import { computed } from "vue";
import { ICON_PATHS, type IconName } from "../utils/icons";

/**
 * One icon from the shared set. See `utils/icons.ts` for the style the paths follow.
 *
 * The default size is `1em` rather than a pixel value, so an icon is sized by the
 * `font-size` already in force where it is placed — which is how every glyph it
 * replaced was sized too. `.icon-btn` and `.tool-card .tool-head .icon` therefore keep
 * working unchanged, and an icon in running text tracks that text.
 *
 * The root carries `class="icon"` for the alignment rule in `style.css`. A `class` given
 * by the caller is merged onto the same element by Vue, which is what lets
 * `ToolCallCard` keep switching `.icon.run` / `.icon.ok` on it.
 */
const props = withDefaults(
  defineProps<{
    name: IconName;
    /** Any CSS length. Defaults to `1em`, i.e. the surrounding text size. */
    size?: string;
  }>(),
  { size: "1em" },
);

const paths = computed(() => ICON_PATHS[props.name] as readonly string[]);
</script>

<template>
  <!--
    Decorative by contract: the accessible name belongs to the control around it, via
    `title` and `aria-label` from the catalog. A name invented here would be a second,
    untranslated one — and `no-hardcoded-text.test.ts` only detects CJK, so an English
    one would slip past it.
  -->
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>
