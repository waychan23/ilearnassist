<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { confirm } from "../../composables/confirm";
import type { Copilot } from "../../api/types";
import type { CopilotDraft } from "../../stores/app";
import CopilotDialog from "./CopilotDialog.vue";
import Icon from "../Icon.vue";

/**
 * The account's Copilots: the ones it made, and the ones others published.
 *
 * **Its own screen rather than a corner of a settings dialog**, and the move is the permission
 * model showing through. What used to be here alongside them — providers and models, document
 * parsers, the app defaults — was installation-wide, so an ordinary account could not write any
 * of it (a screen of controls answering 403) while the account that could was deciding for
 * everybody: a provider's `baseURL` is where every conversation's prompts go. Those live in the
 * platform console now. What is left belongs to one account, and it is the same object whether it
 * is reached from the sidebar's footer inside a workspace or from the header on the front door.
 *
 * Theme and language are not here either — they are in the topbar, because a preference about the
 * app should not be behind an icon labelled for the app's records.
 */

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

const showCopilotEditor = ref(false);
const editingCopilot = ref<Copilot | null>(null);

function openNewCopilot(): void {
  editingCopilot.value = null;
  showCopilotEditor.value = true;
}

function openEditCopilot(c: Copilot): void {
  editingCopilot.value = c;
  showCopilotEditor.value = true;
}

async function onSaveCopilot(draft: CopilotDraft): Promise<void> {
  try {
    await store.saveCopilot(draft);
    showCopilotEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDeleteCopilot(c: Copilot): Promise<void> {
  const ok = await confirm({
    title: t("copilot.delete.title"),
    message: t("copilot.delete.message", { name: c.name }),
    detail: t("copilot.delete.detail"),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteCopilot(c.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The list, split the way the API splits it: another account's published Copilots, which this
 * one may use and copy, and its own, which it may also edit and delete. Empty groups drop out
 * rather than leaving a heading over nothing.
 *
 * The group is a flag rather than a translation key, and the label is chosen in the template —
 * a key held in data is invisible to `i18n/catalog.test.ts`'s dead-key scan.
 */
const copilotGroups = computed(() =>
  [
    { key: "public", items: store.publicCopilots },
    { key: "mine", items: store.myCopilots },
  ].filter((g) => g.items.length > 0)
);

async function onCopyCopilot(c: Copilot): Promise<void> {
  try {
    await store.copyCopilotToMine(c.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/** One-line digest of what a Copilot changes, shown under its name. */
function copilotSummary(c: Copilot): string {
  const bits: string[] = [];
  if (c.settings.modelId) bits.push(c.settings.modelId);
  if (c.settings.temperature != null) bits.push(`temperature ${c.settings.temperature}`);
  if (c.settings.maxSteps != null) {
    bits.push(t("copilot.summarySteps", { count: c.settings.maxSteps }));
  }
  if (c.settings.maxContextMessages != null) {
    bits.push(
      t("copilot.summaryHistory", { count: c.settings.maxContextMessages }, c.settings.maxContextMessages)
    );
  }
  // Three states, and the empty list is now the narrowest rather than the widest — reporting it
  // as "all tools" would describe exactly the Copilot it is not.
  bits.push(
    c.allTools
      ? t("copilot.summaryAllTools")
      : c.tools.length
        ? t("copilot.summaryTools", { count: c.tools.length }, c.tools.length)
        : t("copilot.summaryNoTools")
  );
  return bits.join(" · ");
}
</script>

<template>
  <!--
    Teleported to `body`, and this is load-bearing rather than tidiness. On a compact viewport
    the sidebar is `position: fixed` inside a `transform`, and a fixed-position element whose
    ancestor is transformed is positioned against *that ancestor* — so a `.modal-overlay` left in
    place here would be laid out inside the off-canvas drawer and render off-screen. The palette
    still applies: the theme lives on `<html>` and custom properties cascade from there.
  -->
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal lg">
        <div class="modal-head">
          <h3>{{ t("copilots.title") }}</h3>
          <button
            class="icon-btn"
            data-testid="close-copilots"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body">
          <div class="config-tip">
            {{ t("copilot.introBefore") }}<strong>{{ t("copilot.introCopied") }}</strong
            >{{ t("copilot.introAfter") }}
          </div>

          <div class="list-head">
            <span>{{
              t("copilot.countConfigured", { count: store.myCopilots.length }, store.myCopilots.length)
            }}</span>
            <button class="btn small" data-testid="new-copilot" @click="openNewCopilot">
              <Icon name="plus" /> {{ t("copilot.add") }}
            </button>
          </div>

          <template v-for="group in copilotGroups" :key="group.key">
            <div class="group-label">
              {{ group.key === "public" ? t("copilot.groupPublic") : t("copilot.groupMine") }}
            </div>

            <div
              v-for="c in group.items"
              :key="c.id"
              class="list-row copilot-row"
              :data-testid="`copilot-row-${c.name}`"
            >
              <div class="info">
                <div class="name">
                  <span class="status-dot"></span>
                  {{ c.name }}
                  <span v-if="c.ownerName && group.key === 'public'" class="badge muted">
                    {{ t("copilot.byAuthor", { name: c.ownerName }) }}
                  </span>
                  <span v-if="c.visibility === 'public'" class="badge">
                    {{ t("copilot.published") }}
                  </span>
                  <span v-if="c.id === store.activeCopilotId" class="badge">
                    {{ t("copilot.inUse") }}
                  </span>
                </div>
                <div v-if="c.description" class="desc">{{ c.description }}</div>
                <div class="meta">{{ copilotSummary(c) }}</div>

                <!-- Someone else's wording has to be readable before it is chosen, so the
                     prompt is disclosed here rather than only inside an editor that refuses
                     to open for it. -->
                <details v-if="group.key === 'public'" class="prompt-preview">
                  <summary>{{ t("copilot.viewPrompt") }}</summary>
                  <pre v-if="c.systemPrompt">{{ c.systemPrompt }}</pre>
                  <div v-else class="hint">{{ t("copilot.promptNone") }}</div>
                </details>
              </div>

              <div class="row-actions">
                <template v-if="group.key === 'mine'">
                  <button class="btn small" data-testid="edit-copilot" @click="openEditCopilot(c)">
                    {{ t("common.edit") }}
                  </button>
                  <button
                    class="icon-btn danger"
                    :title="t('common.delete')"
                    @click="onDeleteCopilot(c)"
                  >
                    <Icon name="trash" />
                  </button>
                </template>
                <button
                  v-else
                  class="btn small"
                  :data-testid="`copy-copilot-${c.name}`"
                  @click="onCopyCopilot(c)"
                >
                  <Icon name="copy" /> {{ t("copilot.copyToMine") }}
                </button>
              </div>
            </div>
          </template>

          <div v-if="store.copilots.length === 0" class="empty">
            {{ t("copilot.empty") }}
          </div>
        </div>

        <div class="modal-foot">
          <button class="btn primary" @click="emit('close')">{{ t("common.close") }}</button>
        </div>
      </div>

      <CopilotDialog
        v-if="showCopilotEditor"
        :copilot="editingCopilot"
        @close="showCopilotEditor = false"
        @save="onSaveCopilot"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-2);
  font-size: var(--fs-3);
  margin-bottom: var(--space-5);
}
/* A single-line row, so its contents centre rather than aligning to the top. */
.copilot-row {
  align-items: center;
  padding: var(--space-5) var(--space-6);
}
.copilot-row .info {
  flex: 1;
  min-width: 0;
}
.copilot-row .name {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-weight: 500;
}
.copilot-row .desc {
  color: var(--text-2);
  font-size: var(--fs-3);
  margin-top: var(--space-1);
}
.copilot-row .meta {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin-top: var(--space-2);
}
.group-label {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin: var(--space-6) 0 var(--space-2);
}
.prompt-preview {
  margin-top: var(--space-3);
  font-size: var(--fs-2);
  color: var(--text-3);
}
.prompt-preview summary {
  cursor: pointer;
}
.prompt-preview pre {
  margin: var(--space-2) 0 0;
  padding: var(--space-4) var(--space-5);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}
.empty {
  color: var(--text-3);
  font-size: var(--fs-3);
  padding: var(--space-6) 0;
}
.console-pointer {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin: var(--space-8) 0 0;
  padding-top: var(--space-6);
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: var(--fs-2);
}
.console-pointer button {
  flex-shrink: 0;
}
</style>
