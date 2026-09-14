<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  widgetGroupsForScope,
  widgetsForScope,
  type WidgetId,
  type WidgetScope,
  type WidgetState,
} from "../../api/types";
import { widgetGroupHint, widgetGroupLabel, widgetHint, widgetLabel } from "../../widgets/registry";

/**
 * A scope's widgets, with an install/uninstall toggle each — plus, above its members, a
 * row per client-side widget **group** (see shared `WIDGET_GROUPS`) whose master button
 * installs or uninstalls every member in one click. A group has no row and no route: each
 * member still toggles through the ordinary `toggle` emit, so the group button is sugar
 * over the same writes.
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

const emit = defineEmits<{
  toggle: [id: WidgetId, enabled: boolean];
  toggleGroup: [groupId: string, enabled: boolean];
}>();

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

/** Groups whose members exist at this scope, with the members' rows and the master state. */
const groups = computed(() => {
  const stateOf = new Map(entries.value.map((e) => [e.id, e.enabled]));
  return widgetGroupsForScope(props.scope).map((group) => {
    const memberEntries = group.members.map((id) => ({
      id,
      enabled: stateOf.get(id) ?? false,
    }));
    return {
      id: group.id,
      entries: memberEntries,
      allEnabled: memberEntries.every((e) => e.enabled),
    };
  });
});

/** Widgets that belong to no group at this scope, listed after the group blocks. */
const restEntries = computed(() => {
  const grouped = new Set(groups.value.flatMap((g) => g.entries.map((e) => e.id)));
  return entries.value.filter((e) => !grouped.has(e.id));
});
</script>

<template>
  <div class="widget-toggle-list">
    <template v-for="group in groups" :key="group.id">
      <div class="list-row widget-group-row">
        <div>
          <div class="widget-name">{{ widgetGroupLabel(group.id, t) }}</div>
          <div class="hint">{{ widgetGroupHint(group.id, t) }}</div>
        </div>
        <button
          class="btn small"
          :class="{ primary: !group.allEnabled }"
          :aria-pressed="group.allEnabled"
          :data-testid="`${testidPrefix}-group-${group.id}`"
          @click="emit('toggleGroup', group.id, !group.allEnabled)"
        >
          {{ group.allEnabled ? t("widgets.uninstall") : t("widgets.install") }}
        </button>
      </div>

      <div
        v-for="entry in group.entries"
        :key="entry.id"
        class="list-row widget-toggle-row widget-group-member"
      >
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
    </template>

    <div v-for="entry in restEntries" :key="entry.id" class="list-row widget-toggle-row">
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
