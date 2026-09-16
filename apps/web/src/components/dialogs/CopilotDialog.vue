<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
// From `shared`, not a local literal: the server filters by exactly these names, so a copy
// that drifted would offer a tool the server does not know, or hide one it does. It had
// already drifted once — the local list was missing `read_document`.
import {
  ALL_TOOL_NAMES,
  defaultWidgetEnabled,
  defaultWidgetIdsForScope,
  isWidgetBoundTool,
  widgetsForScope,
} from "../../api/types";
import type { Copilot, FileLocation, SessionSettings, WidgetId } from "../../api/types";
import type { CopilotDraft } from "../../stores/app";
import { widgetLabel } from "../../widgets/registry";
import Icon from "../Icon.vue";
import GenerationParams from "../GenerationParams.vue";
import WriteLocationField from "../WriteLocationField.vue";

const props = defineProps<{ copilot: Copilot | null }>();
const emit = defineEmits<{ close: []; save: [draft: CopilotDraft] }>();

const store = useAppStore();
const { t, te } = useI18n();

/** The tool list shares the tools.name.* namespace with the tool-call card. */
const toolLabel = (name: string): string => {
  const key = "tools.name." + name;
  return te(key) ? t(key) : name;
};

/**
 * `required`-mode tools are not checkable: a Copilot allow-list can neither enable them (the
 * widget install does) nor remove them (they bypass the list in all three states), so a box
 * here would be a control that did nothing. Today that is the quiz pair and nothing else — the
 * plan and diagram tools are `auto-install`, which means they are ordinary tools a Copilot may
 * switch like any other. The `isWidgetBoundTool` predicate is what draws that line.
 *
 * They still live in `ALL_TOOL_NAMES` so a stale allow-list naming one never errors.
 */
const pickableTools = computed(() => ALL_TOOL_NAMES.filter((name) => !isWidgetBoundTool(name)));

/**
 * The generation parameters are a child component's business now — it was the third copy of that
 * form, and this dialog keeps only what is genuinely its own.
 */
const params = ref<InstanceType<typeof GenerationParams> | null>(null);

/**
 * Where conversations started from this Copilot write their files.
 *
 * `null` means "follow the workspace", which is the level below — and the requirement's own
 * order: a Copilot overrides the workspace's default, and the conversation can override the
 * Copilot afterwards. It travels in `settings`, which `createSession` already copies onto the
 * session, so nothing reads a Copilot at turn time.
 */
const writeLocation = ref<FileLocation | null>(null);

/**
 * A Copilot installs into a **session**, so only session-scope widgets are offered here. That is
 * the whole meaning of "copilot level works through session level": this is a place to tick
 * boxes, and the ticking lands in the conversation the Copilot starts.
 */
const sessionWidgets = widgetsForScope("session");

/*
 * The widget selection is a plain checkbox list, unlike the toggles in the two settings dialogs,
 * and the difference is not styling: nothing exists to toggle here. A Copilot's selection reaches
 * a conversation only when one is created from it, so this is a *note* of what to install later
 * — the "deferred" half of the rule that a checkbox is for a choice made in advance.
 */
const widgets = ref<WidgetId[]>([]);

/** Anything other than the default set — which is what forces the section open, see below. */
const widgetsDiffer = computed(() => {
  const chosen = [...widgets.value].sort().join(",");
  /*
   * `defaultWidgetEnabled` rather than "every widget this scope offers", which is what this
   * compared against before and never was the default: the server's fallback is
   * `DEFAULT_WIDGET_IDS`, and with an empty list the two happened to agree on the only case that
   * reached here. Now that the default names two widgets, asking the shared predicate is the only
   * form of the question that cannot disagree with the install the server would have made.
   */
  const fallback = defaultWidgetIdsForScope("session").sort().join(",");
  return chosen !== fallback;
});

/** `""` means "inherit"; every numeric field uses the same convention. */
interface Draft {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
}

const draft = reactive<Draft>({
  name: "",
  description: "",
  systemPrompt: "",
  tools: [],
});

/** Publishing is opt-in, so a Copilot is private unless the box is ticked. */
const isPublic = ref(false);

/**
 * Whether every tool is available. Authoritative over `tools`: the two controls below are one
 * setting seen twice, and the server stores whichever the flag names.
 *
 * A new Copilot starts with every tool, which is what an untouched Copilot has always meant —
 * the flag exists to make the *other* state reachable, not to change this one.
 */
const allTools = ref(true);

/**
 * Whether the collapsed defaults section is open.
 *
 * `paramsDirty` is a ref the child cannot set for us, so the section is opened on mount when the
 * Copilot's stored settings already say something: a section that collapsed itself over a
 * selection someone had made would hide it on the next edit. A **widgets** selection that differs
 * from the default counts for the same reason.
 */
const showDefaults = ref(false);

watch(
  () => props.copilot,
  (c) => {
    draft.name = c?.name ?? "";
    draft.description = c?.description ?? "";
    draft.systemPrompt = c?.systemPrompt ?? "";
    draft.tools = [...(c?.tools ?? [])];
    /*
     * A new Copilot starts at the defaults — the boxes are pre-ticked so the choice is visible
     * before the thing exists, which is what "a checkbox is for a choice made in advance" means
     * here. An existing Copilot's own list wins, including an empty one: that is a decision, and
     * `?? []` would erase it.
     */
    widgets.value = [...(c?.widgets ?? defaultWidgetIdsForScope("session"))];
    isPublic.value = c?.visibility === "public";
    allTools.value = c?.allTools ?? true;
    params.value?.load(c?.settings ?? {});
    writeLocation.value = c?.settings?.writeLocation ?? null;
    showDefaults.value = c ? hasAnySetting(c.settings) || widgetsDiffer.value : false;
  },
  { immediate: true, flush: "post" }
);

/** Whether a stored settings object says anything at all. */
function hasAnySetting(s: SessionSettings): boolean {
  return Object.values(s).some((v) => v != null);
}

function toggleWidget(id: WidgetId) {
  const i = widgets.value.indexOf(id);
  if (i === -1) widgets.value.push(id);
  else widgets.value.splice(i, 1);
}

/** A tool reads as selected while the flag is on, whatever the list happens to hold. */
function isToolChecked(name: string): boolean {
  return allTools.value || draft.tools.includes(name);
}

function toggleTool(name: string) {
  if (allTools.value) {
    // Unchecking one box under "all" is how "everything except this" is said, and it is the
    // only way to narrow from the flag without starting over from nothing. The list becomes
    // the rest of the names, so what is on screen is what gets saved.
    allTools.value = false;
    draft.tools = ALL_TOOL_NAMES.filter((n) => n !== name);
    return;
  }
  const i = draft.tools.indexOf(name);
  if (i === -1) draft.tools.push(name);
  else draft.tools.splice(i, 1);
}

/**
 * Turn "every tool" off.
 *
 * The list is left empty rather than pre-filled: unchecking the flag is a statement that the
 * selection is about to be made by hand, and the saved state has to be the one on screen.
 */
function disableAllTools() {
  draft.tools = [];
}

function save() {
  if (!draft.name.trim()) return;
  emit("save", {
    id: props.copilot?.id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt,
    allTools: allTools.value,
    // Sent as given even when the flag overrides it; the server is the side that decides the
    // flag wins, so a client cannot leave a row asserting both.
    tools: [...draft.tools],
    settings: { ...(params.value?.commit() ?? {}), writeLocation: writeLocation.value },
    widgets: [...widgets.value],
    visibility: isPublic.value ? "public" : "private",
  });
}
</script>

<template>
  <!--
    Teleported to `body`, and this is load-bearing rather than tidiness. On a compact
    viewport the sidebar is `position: fixed` inside a `transform`, and a fixed-position
    element whose ancestor is transformed is positioned against *that ancestor* — so a
    `.modal-overlay` left in place here would be laid out inside the off-canvas drawer and
    render off-screen. The palette still applies: the theme lives on `<html>` and custom
    properties cascade from there.
  -->
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ props.copilot ? t("copilot.edit") : t("copilot.create") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>{{ t("common.name") }}</label>
            <input v-model="draft.name" class="input" :placeholder="t('copilot.namePlaceholder')" />
          </div>
          <div class="field">
            <label>{{ t("copilot.description") }}</label>
            <input v-model="draft.description" class="input" :placeholder="t('copilot.descriptionPlaceholder')" />
          </div>
          <div class="field">
            <label>{{ t("copilot.systemPrompt") }}</label>
            <textarea
              v-model="draft.systemPrompt"
              class="textarea"
              :placeholder="t('copilot.systemPromptPlaceholder')"
            ></textarea>
            <div class="hint">{{ t("copilot.systemPromptHint") }}</div>
          </div>

          <div class="field">
            <label>{{ t("copilot.tools") }}</label>
            <!-- The flag writes the state the boxes show; leaving them in step by hand is what
                 keeps "all tools" from meaning "the list happened to hold everything". -->
            <label class="check-row">
              <input
                v-model="allTools"
                type="checkbox"
                data-testid="copilot-all-tools"
                @change="allTools || disableAllTools()"
              />
              {{ t("copilot.allTools") }}
            </label>
            <div class="form-grid tool-checks">
              <label
                v-for="name in pickableTools"
                :key="name"
                class="check-row"
                :data-testid="`tool-check-${name}`"
              >
                <input
                  type="checkbox"
                  :checked="isToolChecked(name)"
                  @change="toggleTool(name)"
                />
                {{ toolLabel(name) }}
              </label>
            </div>
            <div class="hint">
              {{ allTools ? t("copilot.allToolsHint") : t("copilot.toolsHint") }}
            </div>
            <div class="hint">{{ t("copilot.boundToolsHint") }}</div>
          </div>

          <!-- Unticked by default. Publishing puts this wording in front of every account,
               so it is a decision rather than something to discover after the fact. -->
          <div class="field">
            <label class="check-row">
              <input v-model="isPublic" type="checkbox" data-testid="copilot-public" />
              {{ t("copilot.public") }}
            </label>
            <div class="hint">{{ t("copilot.publicHint") }}</div>
          </div>

          <details class="defaults" :open="showDefaults">
            <summary>{{ t("copilot.defaults") }}</summary>

            <GenerationParams ref="params" />

            <!--
              The write location, beside the other defaults: a Copilot is a *template*, so this
              is a note about conversations that do not exist yet, exactly like the widget boxes
              below it and unlike the same control in the two settings dialogs.
            -->
            <WriteLocationField
              v-model="writeLocation"
              :inherit-label="t('settings.writeLocation.inheritWorkspace')"
              testid="copilot-write-location"
            />

            <!--
              Widgets, at the end of the same section, and as checkboxes rather than the toggles
              the two settings dialogs use. Nothing exists to toggle: a Copilot's selection
              reaches a conversation only when one is started from it, so this is a note of what
              to install later — the "deferred" half of that rule.
            -->
            <div class="field widget-checks">
              <label>{{ t("copilot.widgets") }}</label>
              <div class="form-grid tool-checks">
                <label
                  v-for="w in sessionWidgets"
                  :key="w.id"
                  class="check-row"
                  :data-testid="`copilot-widget-check-${w.id}`"
                >
                  <input
                    type="checkbox"
                    :checked="widgets.includes(w.id)"
                    @change="toggleWidget(w.id)"
                  />
                  {{ widgetLabel(w.id, t) }}
                </label>
              </div>
              <div class="hint">{{ t("copilot.widgetsHint") }}</div>
            </div>
          </details>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button
            class="btn primary"
            data-testid="save-copilot"
            :disabled="!draft.name.trim()"
            @click="save"
          >
            {{ t("common.save") }}
          </button>
        </div>
      </div>
    </div>

  </Teleport>
</template>

<!--
  No scoped block: `.defaults` moved to `style.css` when the new-session dialog needed the same
  disclosure. Two files defining one class name with the same rules is the duplication the design
  system's naming rules exist to prevent, and the promotion threshold is the second copy.
-->

