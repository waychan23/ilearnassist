<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, fileToBase64 } from "../../api/client";
import { useAppStore } from "../../stores/app";
import FolderPickerDialog from "./FolderPickerDialog.vue";
import Icon from "../Icon.vue";

/**
 * Adding material: **one door, a tab per kind**, and the shape is the point.
 *
 * A source can be a file or a web page, and the two were two buttons in the browser's footer
 * that each did its own thing — a file picker that fired immediately, and a prompt. That is not
 * how a knowledge base adds material: there the question is *what am I adding*, the answer picks
 * the form, and everything is filled in before anything is sent. So this is one dialog with a
 * tab per kind, the fields the kind needs, and a submit.
 *
 * What the tabs share is **where it goes** — a workspace, and (for a file) a directory inside it —
 * and that is why they are tabs rather than two dialogs. What they do not share is everything
 * else: a file has bytes and a name, a link has a URL that the server fetches.
 *
 * A **conversation is never offered**, and its absence is a rule rather than an omission: a
 * conversation's own folder is written by the agent and by the uploads made inside it, so a
 * picker here would be a way to put a file somewhere no conversation created it. The workspace is
 * the scope a person adds to.
 */

const props = defineProps<{
  /**
   * The workspace to add to, when the caller has already decided.
   *
   * Present when the browser that opened this dialog has a workspace *chosen* — which is what its
   * list is showing, so it is where the material is meant to land. The dialog then shows no
   * picker, because a control for a choice that has been made is a control that does nothing.
   * Absent when the browser is showing the whole account, where the destination is a question
   * again; it is passed the browser's live filter rather than the scope it opened on, so moving
   * the list moves this with it.
   */
  lockedWorkspaceId?: string;
}>();

const emit = defineEmits<{ close: []; added: [] }>();

const { t } = useI18n();
const store = useAppStore();

/** One tab per kind. A third kind is an entry here and a branch in the body, not a new dialog. */
const TABS = ["file", "link"] as const;
type Tab = (typeof TABS)[number];

const tab = ref<Tab>("file");
const workspaceId = ref(props.lockedWorkspaceId ?? store.workspaces[0]?.id ?? "");
const dir = ref("");
const url = ref("");
const files = ref<File[]>([]);
/** Whether the directory picker is open — see `FolderPickerDialog`. */
const pickingDir = ref(false);
/**
 * The optional field both tabs carry: what to call it.
 *
 * It lands on the **reference** rather than on the bytes (see `work_resources.title`), and the
 * hint states the default rather than the field being pre-filled: a file is called by its own name
 * and a page by the title the fetch found, so an empty field *means* "use that" instead of being a
 * title somebody has to delete first.
 */
const title = ref("");
/**
 * Whether the title applies to what is picked.
 *
 * It names **one** piece of material, and the file tab takes several files — one request each. So
 * it is shown where it can mean something (the link tab always, the file tab with exactly one file
 * chosen) and absent rather than disabled where it cannot: a control that provably cannot do
 * anything is the failure this repo names most often, and the server's per-file default is the
 * right answer then.
 */
const fieldsApply = computed(() => tab.value === "link" || files.value.length === 1);
const busy = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const urlInput = ref<HTMLInputElement | null>(null);

const locked = computed(() => !!props.lockedWorkspaceId);

/** Whether the current tab has what it needs to be submitted. */
const canSubmit = computed(() => {
  if (busy.value || !workspaceId.value) return false;
  return tab.value === "file" ? files.value.length > 0 : url.value.trim().length > 0;
});

/** The title, trimmed, with empty meaning "use the default". */
function named(): { title?: string } {
  const trimmed = title.value.trim();
  return trimmed ? { title: trimmed } : {};
}

watch(tab, async () => {
  error.value = null;
  // One material, one title: it describes *what is being added*, so a value typed for a file must
  // not arrive attached to the link the reader switched to.
  title.value = "";
  await nextTick();
  if (tab.value === "link") urlInput.value?.focus();
});

watch(
  () => props.lockedWorkspaceId,
  (id) => {
    if (id) workspaceId.value = id;
  },
  { immediate: true }
);

/**
 * A directory belongs to the workspace it was picked in.
 *
 * The path is relative, so carrying `notes/2026` into another workspace would not error — the
 * upload would *create* that folder there, which is the wrong thing done quietly. So changing the
 * workspace clears the choice back to the root, which is the only destination that means the same
 * thing in both.
 */
watch(workspaceId, () => {
  dir.value = "";
});

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  files.value = Array.from(input.files ?? []);
  // Reset so picking the *same* file twice in a row is a change the input reports.
  input.value = "";
  error.value = null;
}

function removeFile(at: number): void {
  files.value = files.value.filter((_, i) => i !== at);
}

/**
 * Submit whichever tab is showing.
 *
 * A file tab with several files sends one request each: the route takes one file, and a partial
 * failure has to be reported as *which* file failed rather than as one failure for the batch. The
 * successful ones stay — with `busy` gating the button, a retry resends only what is left.
 */
async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = null;

  try {
    if (tab.value === "link") {
      await api.addResourcePage({
        url: url.value.trim(),
        workspaceId: workspaceId.value,
        ...named(),
      });
    } else {
      const pending = [...files.value];
      for (const file of pending) {
        /*
         * Checked here as well as on the server, and the *order* is the point: a limit an
         * administrator has raised to 60 MB is one a user should be able to use, and a file past
         * it should be refused without being sent. Same sentence as the composer's, since it is
         * the same rule.
         */
        const limit = store.uploadLimitBytes();
        if (file.size > limit) {
          error.value = `${file.name}: ${t("attachments.tooLarge", {
            name: file.name,
            limitMb: Math.round(limit / 1024 / 1024),
          })}`;
          return;
        }
        try {
          await api.uploadWorkspaceFile(workspaceId.value, {
            dir: dir.value.trim().replace(/^\.?\/+|\/+$/g, ""),
            name: file.name,
            mimeType: file.type || undefined,
            data: await fileToBase64(file),
            // Only when the title describes *this* file: with two picked, one title for both
            // would be a claim about neither. See `titleApplies`.
            ...(fieldsApply.value ? named() : {}),
          });
          removeFile(files.value.indexOf(file));
        } catch (e) {
          // Named, because a batch that fails as "something went wrong" leaves the user
          // guessing which of five files to try again.
          error.value = `${file.name}: ${e instanceof Error ? e.message : String(e)}`;
          return;
        }
      }
    }
    emit("added");
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal add-source" role="dialog" aria-modal="true" data-testid="add-source-dialog">
        <div class="modal-head">
          <h3>{{ t("sources.add") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            data-testid="add-source-cancel"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body">
          <!--
            The kind, first, because it decides the rest of the form — and as a tab strip rather
            than a pair of buttons, so what is being chosen is *which form*, not *which action*.
          -->
          <div class="segmented add-tabs" role="tablist" :aria-label="t('sources.addKind')">
            <button
              v-for="kind in TABS"
              :key="kind"
              class="segment"
              role="tab"
              :data-testid="`add-source-tab-${kind}`"
              :aria-selected="tab === kind"
              @click="tab = kind"
            >
              {{ kind === "file" ? t("sources.tabFile") : t("sources.tabLink") }}
            </button>
          </div>

          <!--
            Where it goes, for both kinds: the one thing the tabs share, and the reason they are
            tabs of one dialog rather than two.
          -->
          <label v-if="!locked" class="field">
            <span>{{ t("sources.filterWorkspace") }}</span>
            <select v-model="workspaceId" class="input" data-testid="add-source-workspace">
              <option v-for="w in store.workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
          </label>

          <!--
            The two optional fields, after *where it goes* and before the kind's own fields: they
            describe what is being added rather than where it lands, and both kinds have them.
          -->
          <template v-if="fieldsApply">
            <label class="field">
              <span>{{ t("sources.addTitle") }}</span>
              <input
                v-model="title"
                class="input"
                data-testid="add-source-title"
                :placeholder="
                  tab === 'link' ? t('sources.addTitleLinkHint') : t('sources.addTitleFileHint')
                "
              />
            </label>

          </template>

          <template v-if="tab === 'file'">
            <!--
              Where it goes, as a *choice* rather than a path to type: the picker browses this
              workspace's tree one level at a time and can make a folder. It used to be a text
              field with a datalist of directories that happened to be listed already, which asked
              a person to spell a path to do what a file manager lets them point at.
            -->
            <div class="field">
              <span>{{ t("sources.addDir") }}</span>
              <button
                class="btn dir-choice"
                type="button"
                data-testid="add-source-dir"
                :title="dir || t('sources.dirRoot')"
                @click="pickingDir = true"
              >
                <Icon name="folder" />
                <span class="truncate">{{ dir || t("sources.dirRoot") }}</span>
              </button>
            </div>

            <div class="field">
              <span>{{ t("sources.addFiles") }}</span>
              <button class="btn" data-testid="add-source-pick" @click="fileInput?.click()">
                <Icon name="upload" />
                {{ t("sources.pickFiles") }}
              </button>
              <input
                ref="fileInput"
                type="file"
                multiple
                class="hidden-input"
                data-testid="add-source-input"
                @change="onPick"
              />
              <ul v-if="files.length > 0" class="picked" data-testid="add-source-picked">
                <li v-for="(file, i) in files" :key="`${file.name}-${i}`">
                  <span class="truncate">{{ file.name }}</span>
                  <button
                    class="icon-btn danger"
                    :title="t('attachments.remove')"
                    :aria-label="t('attachments.remove')"
                    data-testid="add-source-unpick"
                    @click="removeFile(i)"
                  >
                    <Icon name="close" />
                  </button>
                </li>
              </ul>
            </div>
          </template>

          <template v-else>
            <label class="field">
              <span>{{ t("sources.addLinkLabel") }}</span>
              <input
                ref="urlInput"
                v-model="url"
                class="input"
                data-testid="add-source-url"
                placeholder="https://"
                @keydown.enter.prevent="submit"
              />
              <span class="hint">{{ t("sources.addLinkHint") }}</span>
            </label>
          </template>

          <p v-if="error" class="add-error" role="alert" data-testid="add-source-error">
            {{ error }}
          </p>
        </div>

        <div class="modal-foot">
          <button class="btn" data-testid="add-source-cancel-foot" @click="emit('close')">
            {{ t("common.cancel") }}
          </button>
          <button
            class="btn primary"
            :disabled="!canSubmit"
            data-testid="add-source-submit"
            @click="submit"
          >
            {{ busy ? t("common.loading") : t("common.add") }}
          </button>
        </div>
      </div>
    </div>

    <FolderPickerDialog
      v-if="pickingDir"
      :workspace-id="workspaceId"
      :initial="dir"
      @close="pickingDir = false"
      @pick="
        (path) => {
          dir = path;
          pickingDir = false;
        }
      "
    />
  </Teleport>
</template>

<style scoped>
.add-source {
  width: var(--modal-md);
}
.add-tabs {
  align-self: flex-start;
}
/* The chosen directory, on a button: it reads as the field's value (a bordered box that fills the
   column, left-aligned text) and behaves as the control that changes it. */
.dir-choice {
  justify-content: flex-start;
  gap: var(--space-3);
  font-weight: 400;
  color: var(--text);
}
.dir-choice .icon {
  flex: none;
  color: var(--text-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--fs-3);
  color: var(--text-2);
}
.field .hint {
  color: var(--text-3);
  font-size: var(--fs-2);
}
/* The chosen files, each with a way to take it back off the list before submitting. */
.picked {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--fs-2);
  color: var(--text-3);
}
.picked li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.picked .truncate {
  min-width: 0;
}
.add-error {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--fs-2);
}
.hidden-input {
  display: none;
}
</style>
