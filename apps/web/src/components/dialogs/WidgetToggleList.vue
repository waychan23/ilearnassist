<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { widgetsForScope, type WidgetId, type WidgetScope, type WidgetState } from "../../api/types";
import { widgetHint, widgetLabel } from "../../widgets/registry";

/**
 * A scope's widgets, with an install/uninstall toggle each.
 *
 * The control is a button whose **label is the action** and whose state rides on `aria-pressed`,
 * which is the shape `sidebar.collapse`/`expand` already uses: a button that described its state
 * instead would need a second string for it and would read as a label rather than a thing to
 * press. `.primary` sits on the install side, because that is the action with something to do.
 *
 * ### Rows in, toggle out
 *
 * The list is a **prop** rather than read from the store, because the two callers get it from
 * different places and one of them must not be the store's: the workspace settings dialog can be
 * opened for a workspace the user has not entered, and making it the active one to borrow the
 * store's list would tear down whatever conversation is on screen. So this renders what it is
 * given and reports what was pressed; the caller owns where the rows came from and what to do.
 */
const props = defineProps<{
  scope: WidgetScope;
  /** The rows the caller already has. A widget this build knows but nothing listed is added. */
  rows: WidgetState[];
  /** The `data-testid` prefix, so each surface's controls are addressed apart. */
  testidPrefix: string;
}>();

const emit = defineEmits<{ toggle: [id: WidgetId, enabled: boolean] }>();

const { t } = useI18n();

/**
 * One entry per widget this build has at this level, in registry order — so the list is complete
 * even before anything has been decided, which is the state a fresh workspace is in.
 */
const entries = computed(() => {
  const known = new Map(props.rows.map((r) => [r.id, r.enabled]));
  return widgetsForScope(props.scope).map((def) => ({
    id: def.id,
    enabled: known.get(def.id) ?? false,
  }));
});
</script>

<template>
  <div class="widget-toggle-list">
    <div v-for="entry in entries" :key="entry.id" class="list-row widget-toggle-row">
      <div>
        <div class="widget-name">{{ widgetLabel(entry.id, t) }}</div>
        <div class="hint">{{ widgetHint(entry.id, t) }}</div>
      </div>
      <button
        class="btn small"
        :class="{ primary: !entry.enabled }"
        :aria-pressed="entry.enabled"
        :data-testid="`${testidPrefix}-toggle-${entry.id}`"
        @click="emit('toggle', entry.id, !entry.enabled)"
      >
        {{ entry.enabled ? t("widgets.uninstall") : t("widgets.install") }}
      </button>
    </div>
  </div>
</template>
