<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import {
  isInteractiveTool,
  TABLE_TOOL_NAME,
  type Message,
  type ToolCall,
  type TurnReference,
} from "../api/types";
import { codeCopyClick, tableCopyClick } from "../composables/codeCopy";
import { confirm } from "../composables/confirm";
import { openNoteFromHighlight, requestNoteEditor } from "../composables/messageNotes";
import { objectNoteRequest } from "../composables/notes";
import { renderMarkdown, type TableHeading } from "../utils/markdown";
import { formatTokens } from "../utils/format";
import { applyNoteHighlights, noteIdAt, type NoteHighlightMark } from "../utils/noteAnchor";
import { groupToolCalls } from "../utils/toolCallGroups";
import { CARDLESS_TOOL_NAMES } from "../utils/toolCallCards";
import { kindLabel, referenceKey } from "../utils/turnRefs";
import ToolCallCard from "./ToolCallCard.vue";
import ToolCallGroup from "./ToolCallGroup.vue";
import AttachmentChips from "./AttachmentChips.vue";
import ReasoningBlock from "./ReasoningBlock.vue";
import Icon from "./Icon.vue";

interface StreamingState {
  active: boolean;
  content: string;
  reasoning: string;
  thinking: boolean;
  reasoningMs: number | null;
  toolCalls: ToolCall[];
  error: string | null;
}

const props = defineProps<{
  message?: Message;
  streaming?: StreamingState;
  /**
   * This is the conversation's last surviving message.
   *
   * Both tail actions hang off it, and it is passed in rather than derived here because the
   * component is also rendered for the transient streaming turn, which is in no array to be
   * the last of. `ChatView` is the one place that knows the order.
   */
  isLast?: boolean;
  /**
   * The conversation's note highlights. Passed in rather than read from the notes module:
   * this component is the message list, and the message list's side of the notes capability
   * is the bridge — it draws `data-note-id` marks and hands clicks over by id without
   * knowing what a note is.
   */
  noteMarks?: readonly NoteHighlightMark[];
}>();

/**
 * A reference in a sent message was pressed.
 *
 * The message list owns the chip and nothing else about it: what a reference *points at*, and
 * therefore what opening one means, is decided one level up — `ChatView` is the renderer of this
 * component and the only thing holding the scroll container, the figure viewer and the note
 * window. So the kind travels unchanged, exactly as a selection's button id does, and this
 * component never learns that a diagram is a file and a quiz question is a call.
 */
const emit = defineEmits<{ openRef: [reference: TurnReference] }>();

const { t } = useI18n();
const store = useAppStore();

const isUser = computed(() => props.message?.role === "user");
const isAssistant = computed(() => props.message?.role === "assistant" || !!props.streaming);

const content = computed(() =>
  props.streaming ? props.streaming.content : props.message?.content ?? ""
);
const toolCalls = computed(() =>
  props.streaming ? props.streaming.toolCalls : props.message?.toolCalls ?? []
);

/**
 * Tool cards that belong above the reply, and the questions that belong below it.
 *
 * A question is not an action the agent took on the way to answering — it is the last thing
 * in the turn, and the sentence in front of it introduces it ("请先回答下面几个问题：").
 * Rendering it above that sentence put a card demanding an answer *before* the words
 * explaining it, and while streaming it read as though the message had already ended and
 * then started talking again.
 *
 * Grouped by the shared `isInteractiveTool` rather than a name comparison each, so a third
 * question tool lands on the right side of the reply without an edit here. A *failed*
 * question call is grouped the same way and renders as an ordinary card — see
 * `ToolCallCard` — which is right because it happened in the same step as the one that
 * suspended, so it is at the end of the turn either way.
 */
const actionToolCalls = computed(() => toolCalls.value.filter((tc) => !isInteractiveTool(tc.name)));
const questionToolCalls = computed(() => toolCalls.value.filter((tc) => isInteractiveTool(tc.name)));

/**
 * The calls this message makes that render nothing at all — `ila_table`'s, whose artifact is the
 * table in the reply rather than anything a card could show.
 *
 * They are the message's **jump anchor**, and that is why they are collected rather than merely
 * skipped: the 图表 panel's 定位 emits `chat.jump` with a tool-call id, so a call with no card
 * has to be reachable some other way or that button would be a control that does nothing. The
 * message row is both the honest target — the table really is in this block — and the one that
 * always exists, since a model that recorded a table and wrote no prose still leaves a message.
 *
 * `data-tool-call-anchor` holds them space-separated, which is what lets `ChatView` match one id
 * with a CSS `~=` selector instead of splitting the list in JavaScript.
 */
const anchorToolCallIds = computed(() =>
  toolCalls.value.filter((tc) => CARDLESS_TOOL_NAMES.has(tc.name)).map((tc) => tc.id)
);

/**
 * The actions, with runs of consecutive calls collapsed into one entry each.
 *
 * Grouping happens *here*, after `toolCalls` has already chosen between the live stream and
 * the persisted message, so the collapsed view is identical during a turn and after it — a
 * reader who saw three calls fold into one line does not watch it unfold when the turn ends.
 * The arithmetic itself is in `utils/toolCallGroups`. A run of one is a `single` and renders
 * exactly as it did before there was any grouping.
 */
const actionRuns = computed(() => groupToolCalls(actionToolCalls.value));
const error = computed(() => props.streaming?.error ?? null);
/**
 * Whether the user cut this reply short.
 *
 * Only a persisted message can carry this — the live stream has no equivalent state, and
 * stopping is not an error, so it deliberately does not reuse `error`.
 */
const stopped = computed(() => props.message?.stopped === true);
/**
 * Submitted attachments, with the live parse state overlaid.
 *
 * The message carries the state the server recorded when it was sent, which is correct on
 * a fresh load but stale as soon as the user re-parses from the chip — the message row
 * itself never changes after the fact.
 */
/**
 * What the turn pointed at, as it was shown when it was sent.
 *
 * Read straight off the message with no overlay, unlike `attachments` beside it: a reference
 * carries no parse state and nothing about it is re-read live. The chip is a record of what was
 * pointed at, and the message is the snapshot — the live state is whatever the agent fetches
 * when it looks the object up, which is not this row's business.
 */
const refs = computed(() => props.message?.refs ?? []);

const attachments = computed(() =>
  (props.message?.attachments ?? []).map((a) => {
    // The message's own snapshot is an `Attachment` the server reassembled when the turn was
    // sent, and the live overlay is the *reference* it was reassembled from, later. Looked up by
    // `resourceId` and never by `id`: the parse is recorded on the reference, and the file id
    // would find nothing — see `Attachment` in the shared package.
    const live = store.resourceParseStatus[a.resourceId];
    if (!live) return a;
    return {
      ...a,
      parseStatus: live.parseStatus,
      parseError: live.parseError,
      parserId: live.parserId,
      parsedChars: live.parsedChars,
      pageCount: live.pageCount,
    };
  })
);

/**
 * Chain of thought. Live while streaming (with the timer), or from the persisted
 * message once the turn is done — the duration is only known while streaming, since it
 * is measured client-side rather than stored.
 */
const reasoning = computed(() =>
  props.streaming ? props.streaming.reasoning : props.message?.reasoning ?? ""
);
const reasoningThinking = computed(() => props.streaming?.thinking ?? false);
const reasoningMs = computed(() => (props.streaming ? props.streaming.reasoningMs : null));

/** The words `renderMarkdown` bakes into a code block's copy control — see `utils/markdown.ts`. */
const markdownLabels = computed(() => ({
  copy: t("common.copy"),
  copied: t("common.copied"),
}));

/**
 * The tables this reply recorded, in the order the model wrote them.
 *
 * Read off the `ila_table` **calls**, which is the only place in this message that knows a table's
 * canonical name — the row it was saved to lives in `session_tables` and nothing joins the two.
 * `renderMarkdown` pairs them positionally and gives up when the counts disagree, so a malformed
 * argument here costs a title rather than a wrong one; a call whose JSON will not parse is one
 * that never reached the save path either, and is skipped for the same reason.
 */
const tableHeadings = computed(() => {
  const headings: TableHeading[] = [];
  for (const call of props.message?.toolCalls ?? []) {
    if (call.name !== TABLE_TOOL_NAME) continue;
    try {
      const args = JSON.parse(call.input) as { name?: unknown; summary?: unknown };
      if (typeof args.name === "string" && args.name) {
        headings.push({
          name: args.name,
          ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
        });
      }
    } catch {
      /* a call with unparseable arguments recorded nothing to title */
    }
  }
  return headings;
});

/**
 * The words a table's bar needs, or `null` where a table should be left alone.
 *
 * Null in a **streaming** message: the calls arrive as the turn runs, so a table drawn before its
 * `ila_table` call has landed would be titling against a moving set — and the count guard would
 * flip a bar on and off as the turn went. The bar appears with the message, which is when its
 * headings are settled.
 */
const tableWords = computed(() =>
  props.streaming
    ? null
    : { headings: tableHeadings.value, labels: { untitled: t("table.untitled"), annotate: t("notes.annotate") } }
);

const rendered = computed(() => {
  if (!content.value) return "";
  const html = renderMarkdown(content.value, markdownLabels.value, tableWords.value ?? undefined);
  return props.streaming ? html + '<span class="streaming-cursor"></span>' : html;
});

/* ---------------------------------- notes ---------------------------------- */

/**
 * The element a note's anchor is measured against — the message's own content, in whichever
 * of the two shapes this message renders as.
 *
 * One ref for two elements is fine because the branches are exclusive. What matters is that
 * it is on the *content* and not on the whole `.msg`: the anchor's offsets are counted over
 * this element's visible text, so a region including the avatar, the reasoning block or a
 * tool card would make them mean something different at capture time than at draw time.
 */
const noteRoot = ref<HTMLElement | null>(null);

/** This message's marks. Filtered here because a message only draws its own. */
const myNoteMarks = computed(() =>
  (props.noteMarks ?? []).filter((mark) => mark.messageId === props.message?.id)
);

/**
 * Draw the marks, after the DOM has the content they were measured against.
 *
 * `flush: "post"` is not optional: a default `watch` runs *before* Vue writes the new
 * `v-html`, so on the render where the content changes the marks would be applied to the old
 * DOM and then thrown away with it. The common case never re-renders at all — a persisted
 * message's markdown is byte-identical each time — which is also why there is no attempt to
 * keep marks across a re-render other than redrawing them.
 */
function drawNoteMarks(): void {
  const root = noteRoot.value;
  const messageId = props.message?.id;
  if (!root || !messageId) return;
  // Nothing to draw and nothing drawn: leave the DOM alone rather than re-walking it. This is
  // every message but one or two, on every note the reader adds.
  if (myNoteMarks.value.length === 0 && !root.querySelector("mark[data-note-id]")) return;
  applyNoteHighlights(root, messageId, myNoteMarks.value);
}

watch([rendered, myNoteMarks], () => void nextTick(drawNoteMarks), { flush: "post" });
onMounted(() => void nextTick(drawNoteMarks));

/**
 * A click on a highlight opens its note.
 *
 * Routed by id through the bridge rather than resolved here: this component knows a mark
 * carries a `data-note-id` and nothing about what one points at. A click anywhere else in the
 * message — including on a link — is left alone.
 */
function onContentClick(event: MouseEvent): void {
  // The rendered controls first, and each reports whether it took the event: the behaviours are
  // distinguished by what was pressed, not by which ran first.
  if (codeCopyClick(event)) return;
  if (tableCopyClick(event)) return;
  if (noteTable(event)) return;
  const noteId = noteIdAt(event.target as Element | null);
  if (noteId) openNoteFromHighlight(noteId);
}

/**
 * A table's 标注/笔记 button, which is chrome rather than anything worth copying.
 *
 * The name and summary ride on the button's own attributes, put there by `renderMarkdown` from the
 * `ila_table` call — so this reads what the bar already says rather than looking anything up. The
 * handle is the model's spelling of the name, which is deliberate: the server normalises it with
 * `tableName`, the same function the writer used, so the spelling that reaches the note is
 * canonical either way and this side never has to know which of the two it is holding.
 */
function noteTable(event: MouseEvent): boolean {
  const button = (event.target as Element | null)?.closest<HTMLElement>("[data-table-note]");
  if (!button) return false;
  event.stopPropagation();
  event.preventDefault();

  const name = button.dataset.tableName ?? "";
  if (!name) return true;
  const request = objectNoteRequest({
    kind: "table",
    ref: name,
    label: name,
    summary: button.dataset.tableSummary || undefined,
  });
  if (request) requestNoteEditor(request);
  return true;
}

/** Token accounting for a finished assistant turn, when the provider reported it. */
/* ------------------------------- copy action ------------------------------- */
const copied = ref(false);

/** Copy the message's visible text (never the reasoning — that is a separate action). */
async function copyMessage() {
  if (!content.value) return;
  try {
    await navigator.clipboard.writeText(content.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be denied; the text stays selectable by hand.
  }
}

/**
 * Whether this reply is one the model can be asked to write again.
 *
 * A reply still waiting on an answer is not: the question card below it owns that state, and
 * regenerating would discard the very question the user is in the middle of answering. The
 * server refuses the same case, so this is the button agreeing with the route.
 */
const awaitingAnswer = computed(() =>
  (props.message?.toolCalls ?? []).some((tc) => isInteractiveTool(tc.name) && tc.status === "awaiting")
);

const canRegenerate = computed(
  () =>
    !!props.message &&
    props.isLast === true &&
    props.message.role === "assistant" &&
    !props.streaming &&
    !store.streaming.active &&
    !awaitingAnswer.value
);

/**
 * Whether the delete control belongs on this message.
 *
 * Both roles, last message only — deleting the tail and then the tail that emerges is the one
 * deletion that cannot leave a reply hanging over a question that is gone. A middle message
 * would be exactly that, so nothing is offered there rather than offered and refused.
 */
const canDelete = computed(
  () => !!props.message && props.isLast === true && !props.streaming && !store.streaming.active
);

async function deleteMessage(): Promise<void> {
  const message = props.message;
  if (!message) return;
  const ok = await confirm({
    title: t("message.delete.title"),
    message: t("message.delete.message"),
    detail: t("message.delete.detail"),
    confirmText: t("message.delete.action"),
    danger: true,
  });
  if (ok) await store.deleteMessage(message.id);
}

async function regenerate(): Promise<void> {
  const ok = await confirm({
    title: t("message.regenerate.title"),
    message: t("message.regenerate.message"),
    detail: t("message.regenerate.detail"),
    confirmText: t("message.regenerate.action"),
    danger: true,
  });
  if (ok) await store.regenerateLastMessage();
}

const usage = computed(() => props.message?.usage ?? null);

/**
 * Which model wrote this reply, when it was recorded.
 *
 * A model is a generation parameter the user can change mid-conversation, so a transcript can hold
 * two of them — and a message that does not say which produced it makes the token figures beside it
 * unattributable. Absent on every message written before the column existed, and on user messages,
 * which is why this renders nothing rather than a placeholder.
 */
const modelName = computed(() => props.message?.model?.modelName ?? "");

const usageText = computed(() => {
  const u = usage.value;
  if (!u) return "";
  const parts: string[] = [];
  // Labels, not plurals — the number is formatted by formatTokens, not by i18n.
  if (u.inputTokens) parts.push(t("message.usage.input") + " " + formatTokens(u.inputTokens));
  if (u.outputTokens) parts.push(t("message.usage.output") + " " + formatTokens(u.outputTokens));
  if (u.totalTokens) parts.push(t("message.usage.total") + " " + formatTokens(u.totalTokens));
  if (u.cachedInputTokens) {
    parts.push(t("message.usage.cached") + " " + formatTokens(u.cachedInputTokens));
  }
  return parts.join(" · ");
});
</script>

<template>
  <div v-if="isUser" class="msg user" data-testid="message-user" :data-message-id="props.message?.id">
    <div class="user-stack">
      <AttachmentChips
        v-if="attachments.length"
        :attachments="attachments"
      />

      <!--
        What this turn was about, above the question — the shape a quoted message takes
        everywhere it exists, and the reason the passage is rendered rather than named: a reader
        checking whether the model answered the right question needs to see the words, not a
        label saying which words they were.

        **Each chip is a control**, because a reference is a pointer that outlives the gesture
        that made it: the reader comes back a week later, reads the answer, and wants the figure
        it was about. Which is the one thing the chip could not do while it was a `div` — it
        named the object and left the reader to go and find it. The kinds differ in where they
        open, never in whether they can, so the *button* is drawn for every kind and the
        decision is handed up; a kind that has since gone is reported there rather than drawn
        dead here, which this component could not know anyway (a table's row is not in the
        message).

        A **sibling** of `data-note-root`, exactly as the chips above are. The anchor arithmetic
        counts a note's offsets over the message's visible text, so a block inside the bubble
        would shift every passage by its own height the moment a reference was added — the same
        reason an avatar may not live in there.
      -->
      <div v-if="refs.length" class="msg-refs" data-testid="message-refs">
        <button
          v-for="ref in refs"
          :key="referenceKey(ref)"
          type="button"
          class="msg-ref"
          data-testid="message-ref"
          :title="t('turnRef.open')"
          @click="emit('openRef', ref)"
        >
          <span class="msg-ref-kind">{{ kindLabel(ref.kind) }}</span>
          <!-- A passage shows its words; a named object shows what it was called, because the
               agent looks the content up and a copy here would be a copy that can go stale. -->
          <span v-if="ref.kind === 'message'" class="msg-ref-quote">{{ ref.quote }}</span>
          <span v-else class="msg-ref-name">{{ ref.label }}</span>
        </button>
      </div>
      <!-- `data-note-root` marks the element an annotation is measured against: the anchor's
           offsets are counted over this element's visible text, so it has to be the content
           and not the whole message (an avatar or a tool card would silently change what
           "the 4th character" means). The one message whose id is absent — the streaming
           bubble — is also the one that cannot be annotated, so the attribute is harmless. -->
      <div v-if="content" ref="noteRoot" class="bubble" data-note-root @click="onContentClick">
        {{ content }}
      </div>
      <div v-if="content && !props.streaming" class="actions">
        <button class="icon-btn act" :title="copied ? t('common.copied') : t('common.copy')" @click="copyMessage">
          <Icon :name="copied ? 'check' : 'copy'" /> {{ copied ? t("common.copied") : t("common.copy") }}
        </button>
        <button
          v-if="canDelete"
          class="icon-btn act danger"
          data-testid="message-delete"
          :title="t('message.delete.action')"
          :aria-label="t('message.delete.action')"
          @click="deleteMessage"
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  </div>

  <div
    v-else-if="isAssistant"
    class="msg assistant"
    data-testid="message-assistant"
    :data-message-id="props.message?.id"
    :data-tool-call-anchor="anchorToolCallIds.join(' ') || undefined"
  >
    <div class="avatar"><Icon name="robot" /></div>
    <div class="body">
      <div v-if="error" class="error-banner">{{ error }}</div>
      <ReasoningBlock
        :content="reasoning"
        :thinking="reasoningThinking"
        :duration-ms="reasoningMs"
      />
      <!--
        A run of two or more actions is one card; a lone call is the card it always was. The
        `v-if`/`v-else` is written out rather than folded into the `v-for`, because it is what
        narrows the union for `vue-tsc` — `run.calls` does not exist on the `single` arm.
      -->
      <template v-for="run in actionRuns" :key="run.kind === 'group' ? run.calls[0]!.id : run.call.id">
        <ToolCallGroup v-if="run.kind === 'group'" :calls="run.calls" />
        <ToolCallCard v-else :tool-call="run.call" />
      </template>
      <div
        v-if="rendered"
        ref="noteRoot"
        class="markdown"
        data-note-root
        data-testid="message-content"
        @click="onContentClick"
        v-html="rendered"
      ></div>
      <!-- Outside the content block above: a stop pressed before any text arrived leaves
           an empty reply, and that one still needs to say why it is empty. -->
      <div v-if="stopped" class="stopped-note" data-testid="message-stopped">
        {{ t("message.stopped") }}
      </div>
      <ToolCallCard v-for="tc in questionToolCalls" :key="tc.id" :tool-call="tc" />
      <div v-if="!props.streaming" class="actions">
        <button
          v-if="content"
          class="icon-btn act"
          :title="copied ? t('common.copied') : t('message.copyReply')"
          @click="copyMessage"
        >
          <Icon :name="copied ? 'check' : 'copy'" /> {{ copied ? t("common.copied") : t("common.copy") }}
        </button>
        <button
          v-if="canRegenerate"
          class="icon-btn act"
          data-testid="message-regenerate"
          :title="t('message.regenerate.action')"
          :aria-label="t('message.regenerate.action')"
          @click="regenerate"
        >
          <Icon name="retry" />
        </button>
        <button
          v-if="canDelete"
          class="icon-btn act danger"
          data-testid="message-delete"
          :title="t('message.delete.action')"
          :aria-label="t('message.delete.action')"
          @click="deleteMessage"
        >
          <Icon name="trash" />
        </button>
        <!--
          The model first, then the figures: the numbers mean nothing without knowing which model
          produced them, and a conversation that switched models is exactly when a reader looks at
          this line. Two spans rather than one joined string so the model keeps its own testid.
        -->
        <span
          v-if="modelName"
          class="model-line"
          data-testid="message-model"
          :title="props.message?.model?.providerName ?? ''"
        >
          {{ modelName }}
        </span>
        <span v-if="usageText" class="usage-line" :title="t('message.contextTokens', { count: formatTokens(usage?.contextTokens ?? 0) })">
          {{ usageText }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.user-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-3);
  max-width: 78%;
}
.user-stack .bubble {
  max-width: 100%;
}
/*
 * What the turn was about, drawn as a quote rather than as a chip: the reader is checking
 * whether the answer is about the passage they meant, and that question is answered by the words.
 * Right-aligned with the bubble it sits above, so the pair reads as one utterance — the user
 * quoting something and then asking.
 */
.msg-refs {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
}
/*
 * A button that reads as a quote block, so the reset is the point rather than the styling: the
 * chrome a `<button>` arrives with (its own font, its centred text, its borders, its
 * `buttontext` colour) is everything this must not look like. What is left is the block it always
 * was, plus the two things that say it can be pressed — a pointer, and a tint on hover that the
 * kind label colours in.
 */
.msg-ref {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2) var(--space-4);
  border: none;
  background: var(--panel-2);
  /* The bubble's own corner in reverse: this is the user speaking, so the flat corner is the
     one nearest them. */
  border-radius: var(--radius-lg) var(--radius-2xs) var(--radius-lg) var(--radius-lg);
  font: inherit;
  font-size: var(--fs-3);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast);
}
.msg-ref:hover {
  background: var(--accent-bg);
}
.msg-ref-kind {
  font-size: var(--fs-1);
  color: var(--text-3);
  transition: color var(--dur-fast);
}
.msg-ref:hover .msg-ref-kind {
  color: var(--accent);
}
.msg-ref-quote {
  color: var(--text-2);
  border-left: 2px solid var(--border);
  padding-left: var(--space-4);
  /* A long passage is the reader's own selection, so it is worth reading — but it is context for
     the question below, not the question, and it must not push the bubble off the screen. */
  max-height: 7.5em;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
.msg-ref-name {
  color: var(--text);
  overflow-wrap: anywhere;
}
/* Actions stay out of the way until the message is hovered, as in chatbox. */
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  margin-top: var(--space-2);
  min-height: 20px;
  opacity: 0;
  transition: opacity var(--dur-fast);
}
.msg:hover .actions,
.actions:focus-within {
  opacity: 1;
}

/*
 * A device with no hover never fires the rule above, so the actions would be permanently
 * invisible — including the copy button, which is the only way to get a reply's text out.
 *
 * Keyed on the pointer rather than on a width. A 1024px tablet has no narrow-layout problem
 * and cannot hover either, so a `max-width` query here would leave it broken.
 *
 * No layout shift when this fires: `.actions` already reserves `min-height`, so only the
 * opacity changes.
 */
@media (hover: none) {
  .actions {
    opacity: 1;
  }
}

/* A finger is not a mouse pointer, so the target grows where it is the only input. 32px is
   deliberately between WCAG 2.5.8's 24px and iOS's 44px — a 44px copy button under every
   message is visually heavy, and the primary actions get the larger target. */
@media (pointer: coarse) {
  .act {
    min-height: 32px;
    padding: var(--space-3) var(--space-4);
  }
}

.user-stack .actions {
  justify-content: flex-end;
}
.act {
  font-size: var(--fs-1);
  padding: var(--space-1) var(--space-3);
  color: var(--text-3);
}
/* The model's own line, quieter than the figures beside it: a reader looking at this row is
 * usually reading the tokens, and the name is what makes them attributable. `cursor: default`
 * for the same reason as the line below — it is a label, not a control, and the tooltip on each
 * is the pointer's only reward. */
.model-line {
  font-size: var(--fs-1);
  color: var(--text-3);
  cursor: default;
}

/* A separator between the two, drawn rather than typed: a `·` in the markup would be content the
 * note-anchor walk counts, and the two spans are conditional so a hard-coded one would dangle. */
.model-line + .usage-line::before {
  content: "·";
  margin-right: var(--space-2);
}

.usage-line {
  font-size: var(--fs-1);
  color: var(--text-3);
  cursor: default;
}
</style>
