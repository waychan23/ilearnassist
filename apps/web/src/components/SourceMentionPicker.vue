<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type { Source } from "../api/types";
import Icon from "./Icon.vue";
import type { ActiveMention } from "../utils/mention";

/**
 * The `@` picker: the account's sources, narrowed by what has been typed.
 *
 * It asks the **server** for its options on every keystroke, debounced, rather than filtering a
 * list it already has. That is the same decision the browser makes and for a stronger reason
 * here: the composer opens on every page, and the account's whole library is not something to
 * hold in memory for a control most turns never touch. The query is a name substring, which the
 * route matches literally.
 *
 * The parent owns the query and the caret; this owns the keyboard, because the keys it needs —
 * ArrowUp/Down/Enter/Escape — are the ones the composer would otherwise act on. `handleKey` is
 * how the composer asks "do you want this one", and it answers by consuming it.
 */

const props = defineProps<{
  /** The mention being typed, or `null` when there is none. */
  mention: ActiveMention | null;
}>();

const emit = defineEmits<{ pick: [source: Source] }>();

const { t } = useI18n();

const options = ref<Source[]>([]);
const active = ref(0);
const open = ref(false);
/** The request in flight is ignored if a newer query has been typed since. */
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long typing must pause before the options are fetched.
 *
 * Two reasons, and the second is not a preference. A fetch per keystroke is one request per
 * letter for a menu that will be replaced a moment later; and the replacement *detaches the
 * rows*, so a click aimed at one lands on a node that no longer exists — which is how this was
 * found, by a browser spec timing out while waiting for a moving option to hold still.
 */
const DEBOUNCE_MS = 150;

async function load(query: string): Promise<void> {
  const mine = ++seq;
  try {
    const found = await api.listSources({ name: query });
    if (mine !== seq) return;
    // A short list: the picker sits above a textarea, and a menu taller than the composer
    // is one the user has to scroll rather than glance at.
    options.value = found.slice(0, 8);
    active.value = 0;
  } catch {
    // A picker that cannot load its options simply does not render them: the `@` the user
    // typed stays in the message, and the failure has no better home than here.
    options.value = [];
  }
}

watch(
  () => props.mention?.query ?? null,
  (query) => {
    if (timer !== null) clearTimeout(timer);

    // Closing is immediate: the picker is gone the moment the mention is, and waiting to hide
    // it would leave a menu over a sentence the user has already moved on from.
    if (query === null || props.mention === null) {
      open.value = false;
      options.value = [];
      return;
    }

    // Opening is immediate too, so `@` alone shows the picker straight away and the fetch
    // fills it in. Only the fetch waits.
    open.value = true;
    timer = setTimeout(() => void load(query), DEBOUNCE_MS);
  },
  { immediate: true }
);

/** Whether this component consumed the key. */
function handleKey(event: KeyboardEvent): boolean {
  if (!open.value || options.value.length === 0) return false;

  switch (event.key) {
    case "ArrowDown":
      active.value = (active.value + 1) % options.value.length;
      break;
    case "ArrowUp":
      active.value = (active.value - 1 + options.value.length) % options.value.length;
      break;
    case "Enter":
    case "Tab":
      choose(options.value[active.value]!);
      break;
    case "Escape":
      // Closes the picker and *not* the composer: the `@` stays, and the user carries on
      // typing a name for a source the picker could not find.
      open.value = false;
      break;
    default:
      return false;
  }

  event.preventDefault();
  return true;
}

function choose(source: Source): void {
  open.value = false;
  emit("pick", source);
}

defineExpose({ handleKey });
</script>

<template>
  <div v-if="open && options.length > 0" class="mention-picker" data-testid="mention-picker">
    <button
      v-for="(option, i) in options"
      :key="option.id"
      class="mention-option"
      :class="{ active: i === active }"
      data-testid="mention-option"
      :aria-selected="i === active"
      @mousedown.prevent="choose(option)"
    >
      <Icon :name="option.kind === 'image' ? 'image' : option.category === 'diagram' ? 'diagram' : 'file'" />
      <span class="label truncate">{{ option.name }}</span>
      <span class="where truncate">{{ option.workspaceName ?? "" }}</span>
    </button>
  </div>

  <!--
    Nothing found, said out loud. Silence would read as "still looking" for a query the server
    has already answered — and the user's next move differs: keep typing, or open the browser.
  -->
  <div v-else-if="open" class="mention-picker mention-empty" data-testid="mention-empty">
    {{ props.mention?.query ? t("composer.noSourceMatch") : t("composer.noSources") }}
  </div>
</template>

<style scoped>
/*
 * Above the composer rather than below it: the composer sits at the bottom of the window, and a
 * menu below the textarea would be off-screen. Absolute inside the surface, which is where the
 * caret is.
 */
.mention-picker {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: var(--space-4);
  right: var(--space-4);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  max-height: 40vh;
  overflow: auto;
  padding: var(--space-2);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.mention-option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-3);
  text-align: left;
  cursor: pointer;
}
.mention-option.active,
.mention-option:hover {
  background: var(--panel-2);
  color: var(--text);
}
.mention-option .label {
  min-width: 0;
  flex: 1;
}
.mention-option .where {
  color: var(--text-3);
  font-size: var(--fs-2);
  max-width: 12ch;
}
.mention-empty {
  padding: var(--space-4);
  color: var(--text-3);
  font-size: var(--fs-2);
}
</style>
