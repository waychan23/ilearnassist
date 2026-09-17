<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import AttachmentChips from "./AttachmentChips.vue";
import SourceMentionPicker from "./SourceMentionPicker.vue";
import { activeMention, insertMention, type ActiveMention } from "../utils/mention";
import type { ReferenceChoice } from "../utils/referencePicker";
import type { Source } from "../api/types";
import TokenCountPopover from "./TokenCountPopover.vue";
import ModelSelector from "./ModelSelector.vue";
import { openSessionSettings, showAdmin } from "../composables/ui";
import { autosizeTextarea } from "../utils/autosize";
import { kindLabel, referenceKey } from "../utils/turnRefs";
import Icon from "./Icon.vue";

const { t } = useI18n();
const store = useAppStore();
const text = ref("");
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);

/**
 * Whether this client may write to the conversation on screen.
 *
 * The same fact the server enforces — and the server is the one that matters, since a client can
 * only refuse itself. This is here so the button says so *before* a turn is composed and thrown
 * away: the alternative is an enabled send button whose every press returns a refusal, which
 * reads as the app being broken rather than as the conversation being somebody else's.
 */
const readOnly = computed(() => store.isActiveSessionReadOnly);

const canSend = computed(
  () =>
    !readOnly.value &&
    !store.streaming.active &&
    !store.documentsParsing &&
    (!!text.value.trim() ||
      store.pendingAttachments.length > 0 ||
      store.pendingSources.length > 0 ||
      // A staged 追问 chip is a complete question on its own: "what about this?" needs no words
      // around it, and the server's own guard agrees — see `MESSAGE_REQUIRED` in routes.ts.
      store.pendingRefs.length > 0)
);

/**
 * Take the caret when a reference is staged.
 *
 * **One rule here rather than a call at every entry point**, and that is the point: 追问 is
 * offered from the selection bar, the figure panel, the figure card, the enlarged viewer and the
 * note window, and the gesture is the same in all five — point at something, then type what you
 * want to know. A rule per call site would be five places to remember and four chances to forget,
 * and the result of forgetting is a chip that has been staged with the caret still somewhere the
 * reader has to move by hand.
 *
 * Watching the *length* rather than the array: a removal is the reader taking a chip back, and
 * pulling their caret to the composer then would be the opposite of what they asked for.
 */
watch(
  () => store.pendingRefs.length,
  (count, previous) => {
    if (count > (previous ?? 0)) textarea.value?.focus();
  }
);

/**
 * The workspaces this conversation has been opened to, as the chips draw them.
 *
 * Resolved through `store.workspaces` rather than kept as its own list, because the grant stores
 * **ids** and a chip has to show a name: a workspace renamed since it was opened would otherwise
 * be a chip carrying what it used to be called. A granted workspace that no longer exists simply
 * has no chip — it is already excluded from what the server resolves.
 */
const scopeChips = computed(() =>
  store.workspaces.filter((w) => store.scopedWorkspaceIds.includes(w.id))
);

/**
 * The `@` the caret is inside, if any — what opens the source picker.
 *
 * Read from the text and the caret rather than tracked in a flag, because the caret moves for
 * reasons no handler sees: an arrow key, a click, an undo. `utils/mention.ts` owns the rule;
 * this only asks it and hands the caret back afterwards.
 */
const mention = ref<ActiveMention | null>(null);

function refreshMention(): void {
  const el = textarea.value;
  mention.value = el ? activeMention(text.value, el.selectionStart ?? 0) : null;
}

/**
 * Put the chosen thing's name where the mention was, and put the caret after it.
 *
 * `insertMention` runs for all three kinds, because the `@` is how something is *picked* and not
 * what it means: the name goes into the sentence so it reads naturally, and what the reference
 * *means* is the chip beside the composer. A workspace's name is inserted the same way a file's
 * is, and what follows differs.
 *
 * The `switch` is exhaustive over `ReferenceChoice`, so a fourth kind of reference is a
 * `vue-tsc` error here rather than a row that inserts a name and does nothing else.
 */
function onPickReference(choice: ReferenceChoice): void {
  const el = textarea.value;
  const current = mention.value;
  if (!el || !current) return;

  const name = choice.kind === "source" ? choice.source.name : choice.name;
  const result = insertMention(text.value, current, name);
  text.value = result.text;
  mention.value = null;

  switch (choice.kind) {
    case "source":
      void store.referenceSource(choice.source);
      break;
    case "scope":
      void store.referenceScope(choice);
      break;
  }

  // After Vue has written the new value: setting `selectionStart` before the DOM updates
  // would place the caret in the old text.
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(result.caret, result.caret);
    autosize();
  });
}

/** Warn before sending an image to a model that cannot read it. */
const imageWithoutVision = computed(
  () => store.pendingAttachments.some((a) => a.kind === "image") && !store.supportsVision
);

/**
 * A document still being extracted cannot be sent yet.
 *
 * The extracted text is injected when the message is built, so sending now would produce a
 * turn where the model never saw the document — and it would not appear on a later turn
 * either, because the attachment belongs to this message. Waiting is the honest behaviour.
 */
const parsingDocuments = computed(() => store.documentsParsing);

/**
 * Why the send button cannot be used, in one place: it is both the tooltip and the name.
 *
 * No `streaming.active` branch: while a reply streams the corner holds Stop, so Send is not
 * rendered for a state to describe. `composer.thinking` is still the textarea's placeholder
 * there, which is the only place that sentence belongs.
 */
const sendLabel = computed(() =>
  parsingDocuments.value ? t("composer.parsingShort") : t("composer.send")
);

/**
 * The stop control's wording. It says so while the request is in flight, because on a slow
 * link the round trip is long enough to press Stop twice.
 */
const stopLabel = computed(() =>
  store.streaming.stopping ? t("composer.stopping") : t("composer.stop")
);

/**
 * Why the send button is inert, when it is inert for the reason that has nothing to do with what
 * has been typed.
 *
 * Read-only first: it is the state the reader cannot fix by editing the box, so a tooltip about
 * the empty textarea would send them to the wrong problem. `composer.send` otherwise, so the
 * button keeps its own name when it is simply disabled by an empty draft.
 */
const sendTitle = computed(() =>
  readOnly.value ? t("lock.other") : t("composer.send")
);

/**
 * What the box says when it is empty — and the one place a reader who never notices the dot or
 * the banner will still find out why nothing can be sent.
 *
 * The read-only sentence outranks the others because it is the only one of the three that is not
 * about the box's contents: `composer.placeholder` advertises the `@` reference, which is useless
 * in a conversation this client cannot write to, and the thinking placeholder describes a turn
 * that cannot be started.
 */
const placeholder = computed(() => {
  if (readOnly.value) return t("lock.other");
  return store.streaming.active ? t("composer.thinking") : t("composer.placeholder");
});

function stop() {
  void store.stopMessage();
}

/** Documents that failed to parse and are still staged — the model will not read them. */
const failedDocuments = computed(() =>
  store.pendingAttachments.filter((a) => a.parseStatus === "failed")
);

/**
 * Grow the textarea with its content — including shrinking it again after a send, which is
 * what the reset inside `autosizeTextarea` is for.
 */
function autosize() {
  if (textarea.value) autosizeTextarea(textarea.value);
}

watch(text, () => nextTick(autosize));

async function addFiles(files: FileList | File[] | null) {
  if (!files) return;
  const list = Array.from(files);
  if (list.length === 0) return;
  uploading.value = true;
  try {
    for (const file of list) await store.uploadAttachment(file);
  } finally {
    uploading.value = false;
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  void addFiles(input.files);
  // Reset so picking the same file again still fires a change event.
  input.value = "";
}

/** Screenshots are the common case for pasting, so intercept clipboard files. */
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  void addFiles(files);
}

function send() {
  const t = text.value.trim();
  if (!canSend.value) return;
  const attachments = [...store.pendingAttachments];
  text.value = "";
  nextTick(autosize);
  void store.sendMessage(t, attachments);
}

/**
 * The canned replies, as *label = the message that gets sent*.
 *
 * A list rather than three buttons written out, and the keys are literal `t()` calls in the
 * source rather than assembled from an id — `catalog.test.ts` reads the source for those
 * literals, and a key built from a loop index is invisible to it, which is how a dead key
 * survives a guard written to catch exactly that.
 *
 * A `computed` rather than a plain array because the labels are translated: a language switch
 * has to redraw them, and a value computed once at setup would keep the language the page
 * loaded in.
 */
const quickReplies = computed(() => [
  { id: "continue", label: t("composer.quick.continue") },
  { id: "yes", label: t("composer.quick.yes") },
  { id: "ok", label: t("composer.quick.ok") },
]);

/**
 * The row is there once there is something to reply to, and not while a reply is arriving.
 *
 * An empty conversation has nothing to continue, and the welcome screen is where a first
 * message is composed rather than picked. A streaming turn is the other half, and it is not
 * merely tidy: sending is refused while a turn runs, so a chip on screen then would be a
 * control that looks live and does nothing.
 *
 * Read-only joins those for the same reason, since a chip *is* a send: leaving the row up would
 * offer three buttons that each come back with a refusal.
 */
const showQuickReplies = computed(
  () => !readOnly.value && !store.streaming.active && store.messages.length > 0
);

/**
 * Send one of them.
 *
 * Deliberately not `send()` with an argument: there is nothing in the textarea to clear and
 * nothing staged to attach, and a half-written draft is the user's — a chip that wiped it would
 * be a one-click way to lose a paragraph. The chip sends its own words and leaves the box alone.
 */
function sendQuick(message: string) {
  if (readOnly.value || store.streaming.active || store.documentsParsing) return;
  void store.sendMessage(message, []);
}

function onKeydown(e: KeyboardEvent) {
  // The picker gets first refusal on the keys it navigates with, and says so by consuming
  // them: Enter with it open must choose a source rather than send the message.
  if (picker.value?.handleKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

const picker = ref<InstanceType<typeof SourceMentionPicker> | null>(null);

function onInput() {
  refreshMention();
  autosize();
}
</script>

<template>
  <div class="composer">
    <div class="inner-wrap">
      <div v-if="parsingDocuments" class="parse-notice" data-testid="composer-parsing">
        {{ t("composer.parsing") }}
      </div>

      <div v-else-if="failedDocuments.length" class="vision-warning" data-testid="composer-parse-failed">
        {{ t("composer.parseFailed", { count: failedDocuments.length }, failedDocuments.length) }}
      </div>

      <div v-if="imageWithoutVision" class="vision-warning">
        {{ t("composer.visionWarning", { model: store.effectiveModel?.name ?? "" }) }}
      </div>

      <!--
        The canned replies, above the input and centred: the assistant asks a question at the
        end of a turn, and these are the three answers to it that cost no typing. Directly above
        the surface rather than above the notices, so the row that acts on the input sits
        against it and the status lines stay where they were.
      -->
      <div v-if="showQuickReplies" class="quick-row" data-testid="composer-quick">
        <!--
          A name for the row rather than a fourth chip: it is not something the user can send,
          and it is drawn in the muted text colour so it does not read as one. First in the DOM
          rather than `aria-label` on the row, so a screen reader announces it in the same breath
          as the chips — and so the words are on screen, where a reader who has never seen the
          chips answer anything can read what they are for.
        -->
        <span class="quick-label" data-testid="composer-quick-label">
          {{ t("composer.quick.label") }}
        </span>
        <button
          v-for="reply in quickReplies"
          :key="reply.id"
          type="button"
          class="pill quick-pill"
          :data-testid="`quick-${reply.id}`"
          @click="sendQuick(reply.label)"
        >
          {{ reply.label }}
        </button>
      </div>

      <!-- One surface owns the input, the attachments and the toolbar (chatbox's
           InputBox layout), so the composer reads as a single control. -->
      <div class="surface">
        <SourceMentionPicker ref="picker" :mention="mention" @pick="onPickReference" />
        <div class="input-row">
          <textarea
            ref="textarea"
            v-model="text"
            data-testid="composer-input"
            rows="1"
            :placeholder="placeholder"
            @input="onInput"
            @keydown="onKeydown"
            @keyup="refreshMention"
            @click="refreshMention"
            @paste="onPaste"
            @blur="mention = null"
          ></textarea>

          <!--
            The same corner holds Stop for as long as a reply is streaming, which is also
            what chatbox does. Swapping the control rather than adding a second one keeps
            the composer from growing a toolbar while the user is watching it answer.
          -->
          <button
            v-if="store.streaming.active"
            class="send-btn stop-btn"
            data-testid="composer-stop"
            :disabled="store.streaming.stopping"
            :title="stopLabel"
            :aria-label="stopLabel"
            @click="stop"
          >
            <Icon name="stop" />
          </button>
          <button
            v-else
            class="send-btn"
            data-testid="composer-send"
            :disabled="!canSend"
            :title="sendTitle"
            :aria-label="sendLabel"
            @click="send"
          >
            <Icon name="send" />
          </button>
        </div>

        <div v-if="store.pendingAttachments.length" data-testid="composer-attachments">
          <AttachmentChips
            :attachments="store.pendingAttachments"
            removable
            @remove="store.removePendingAttachment"
            @reparse="store.reparseAttachment"
          />
        </div>

        <!--
          The referenced sources, as chips of their own. A `Source` is an `Attachment` in every
          field the chip reads, so the same component draws both — and drawing them as two rows
          rather than one is what says which was uploaded for this turn and which was pointed at.
        -->
        <div v-if="store.pendingSources.length" data-testid="composer-sources">
          <AttachmentChips
            :attachments="store.pendingSources"
            removable
            @remove="store.removePendingSource"
            @reparse="(source) => store.referenceSource(source as Source)"
          />
        </div>

        <!--
          What this turn is *about* — the follow-up chips. Their own row, and not `AttachmentChips`:
          a `TurnReference` has no bytes, no size and no parse state, so it is not an attachment
          in any field that component reads. Forcing it into that shape would be the "never coerce
          a request field" rule broken in the UI, where the coercion is a chip claiming a parse
          state that does not exist.
        -->
        <div v-if="store.pendingRefs.length" class="composer-refs" data-testid="composer-refs">
          <span v-for="ref in store.pendingRefs" :key="referenceKey(ref)" class="ref-chip">
            <span class="ref-kind">{{ kindLabel(ref.kind) }}</span>
            <span class="ref-label truncate">{{ ref.label }}</span>
            <button
              type="button"
              class="ref-remove"
              data-testid="composer-ref-remove"
              :title="t('turnRef.remove')"
              :aria-label="t('turnRef.remove')"
              @click="store.removePendingReference(referenceKey(ref))"
            >
              <Icon name="close" />
            </button>
          </span>
        </div>

        <!--
          The workspaces this conversation has been opened to. A row of its own rather than
          `AttachmentChips`, and the reason is that a scope is not an `Attachment`: it has no
          size, no parse state and no bytes, so forcing it into that shape would be a lie the
          chip component would then have to render around.

          It is a *grant made visible*, which is the whole point of putting it here: a
          conversation that reads every workspace without saying so is the failure this row
          exists to prevent.
        -->
        <div v-if="scopeChips.length || store.scopeIsAll" class="scope-chips" data-testid="composer-scope">
          <button
            v-if="store.scopeIsAll"
            class="scope-chip"
            type="button"
            data-testid="scope-chip-all"
            :title="t('composer.scopeRemove', { name: t('composer.allWorkspaces') })"
            @click="store.clearWorkspaceScope()"
          >
            <Icon name="list-tree" />
            <span class="truncate">{{ t("composer.allWorkspaces") }}</span>
            <Icon name="close" />
          </button>
          <button
            v-for="workspace in scopeChips"
            :key="workspace.id"
            class="scope-chip"
            type="button"
            data-testid="scope-chip"
            :title="t('composer.scopeRemove', { name: workspace.name })"
            @click="store.removeScopeWorkspace(workspace.id)"
          >
            <Icon name="folder" />
            <span class="truncate">{{ workspace.name }}</span>
            <Icon name="close" />
          </button>
        </div>

        <div class="toolbar">
          <div class="toolbar-left">
            <!--
              Read-only is in the disabled set for the same reason it is in `canSend`: attaching is
              a write into this conversation (`POST /sessions/:id/sources` is gated), so a live
              button here would stage a file whose upload the server then refuses. The title says
              which of the reasons it is, like the send button's does.
            -->
            <button
              class="icon-btn attach-btn"
              :title="readOnly ? t('lock.other') : t('composer.attach')"
              :disabled="readOnly || uploading || store.streaming.active || parsingDocuments"
              @click="fileInput?.click()"
            >
              <Icon v-if="!uploading" name="attach" /><template v-else>…</template>
            </button>
            <button
              class="icon-btn params-btn"
              data-testid="open-session-settings"
              :title="t('sessionSettings.open')"
              :aria-label="t('sessionSettings.open')"
              @click="openSessionSettings()"
            >
              <Icon name="sliders" />
            </button>
            <span
              v-if="store.activeCopilotName"
              class="pill copilot-tag truncate"
              data-testid="copilot-tag"
              :title="store.activeSystemPrompt"
            >
              <Icon name="diamond" /> {{ store.activeCopilotName }}
            </span>
          </div>

          <div class="toolbar-right">
            <TokenCountPopover :pending-text="text" />
            <!-- "Manage models…" is a platform administrator's screen, so it opens the console
                 on the model services rather than the dialog that used to hold them. -->
            <ModelSelector @manage="showAdmin('providers')" />
          </div>
        </div>

        <input
          ref="fileInput"
          class="hidden-input"
          data-testid="composer-file-input"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,text/csv,text/html,text/css,text/xml,application/xml,application/json,application/javascript,application/typescript,application/pdf,.md,.txt,.json,.csv"
          @change="onPick"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hidden-input {
  display: none;
}
.vision-warning {
  font-size: var(--fs-2);
  color: var(--warning);
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-5);
}
/* Informational, not a warning: extraction is simply still running. */
.parse-notice {
  font-size: var(--fs-2);
  color: var(--text-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-5);
}
/*
 * `min-width` is what makes the ellipsis reachable. A flex item defaults to `min-width:
 * auto`, which refuses to shrink below its content — so `max-width` and `text-overflow`
 * were both inert and a long Copilot name pushed the toolbar's other controls off the row
 * instead of truncating.
 */
/*
 * The canned replies. Centred rather than stretched: three short answers are a set of choices,
 * and a row that filled the width would read as a segmented control the user has to pick from
 * rather than as three things they may say.
 *
 * The label is *inside* the row and the row is what centres, so the group stays on the
 * composer's axis with the chips a little right of it — the alternative, a label hung outside
 * a centred row, puts the whole group off-centre instead.
 */
.quick-row {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-4);
  /*
   * Pulled up by the wrap's gap, so the row sits against the input it fills: `.inner-wrap`'s
   * `gap` already spaces it from the surface, and two gaps between the chips and the box they
   * belong to reads as a separate control. The extra space above is what keeps it from colliding
   * with the notices.
   */
  margin-bottom: calc(-1 * var(--space-2));
}
/*
 * The row's name. Muted and unboxed, which is the whole of how it says "not a chip": it carries
 * the same size as the chips so the row reads as one line, and none of their affordances — no
 * border, no fill, no cursor — so nothing about it invites a click.
 */
.quick-label {
  font-size: var(--fs-2);
  color: var(--text-3);
}
/*
 * `.pill` in the stylesheet gives the shape — the border and the radius. What a *clickable* pill
 * needs on top is a cursor, a colour that responds, and a font size of its own, since the shared
 * class is sized for static tags.
 */
.quick-pill {
  font-size: var(--fs-2);
  color: var(--text-2);
  background: var(--panel);
  padding: var(--space-2) var(--space-6);
  cursor: pointer;
  transition:
    background var(--dur-fast),
    color var(--dur-fast),
    border-color var(--dur-fast);
}
.quick-pill:hover {
  background: var(--panel-2);
  color: var(--text);
}

.copilot-tag {
  font-size: var(--fs-1);
  color: var(--text-3);
  padding: var(--space-1) var(--space-5);
  min-width: 0;
  flex: 0 1 auto;
  max-width: 240px;
}

/*
 * What this conversation may read across, as chips.
 *
 * Accent-tinted rather than neutral, and that is the point of the row: a grant is not material
 * being sent, it is access being held, and it should read as a standing decision rather than as
 * one more thing attached to this turn. The whole chip is the button, because removing is the
 * only thing it does.
 */
.scope-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.scope-chip {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: 240px;
  padding: var(--space-1) var(--space-4);
  background: var(--accent-bg);
  border: 1px solid var(--accent);
  border-radius: var(--radius-lg);
  color: var(--text);
  font-family: inherit;
  font-size: var(--fs-2);
  cursor: pointer;
}
.scope-chip:hover {
  color: var(--text-2);
}

/*
 * The 追问 chips, drawn as the persistent-decision shape rather than the attachment shape: a
 * reference is what this turn is *about*, and the reader is looking at it while they type the
 * question. So the chip carries the kind as a label and the subject as the content, the way a
 * quoted passage does, rather than a thumbnail and a parse state it has not got.
 *
 * `--panel-2` rather than the accent tint the scope chips use, so the two rows are not mistaken
 * for each other: the scope chips are a decision the reader made about *access* and stay until
 * changed, while these are about *this message* and go with it.
 */
.composer-refs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.ref-chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 280px;
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  font-size: var(--fs-2);
  color: var(--text);
}
/* The kind is the one thing that must not be truncated away — "a diagram" and "a passage" are
   different claims about the same words, so it keeps its width while the subject gives. */
.ref-kind {
  flex: none;
  color: var(--text-3);
}
.ref-label {
  min-width: 0;
}
.ref-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: var(--space-1);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-size: var(--fs-1);
  cursor: pointer;
}
.ref-remove:hover {
  color: var(--danger);
  background: var(--panel);
}
</style>
