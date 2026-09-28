<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import Icon from "../Icon.vue";

/**
 * Name the branch and make it.
 *
 * One field, because it is the only thing the client contributes: the copy — every message up
 * to and including the chosen one, plus the parameters and derived records — is built by the
 * server in one transaction, and the reply opens the new conversation itself. The dialog
 * therefore has no parameters to offer and nothing to stage; a fork is not a create with a
 * different name, it is a snapshot with a name.
 *
 * Teleported to `body`, the reason `NewSessionDialog` gives: on a compact viewport the sidebar
 * is transformed, and a fixed overlay left in place would be laid out against it.
 */
const props = defineProps<{
  messageId: string;
  /** `原名 · 分支`, computed by `ChatView` where the conversation's title is in scope. */
  initialTitle: string;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const store = useAppStore();

const title = ref(props.initialTitle);
const saving = ref(false);

async function create(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    // A blank field is not an error here: the store sends no title, and the server keeps the
    // source's. The field starts filled, so this is the reader clearing it on purpose.
    const created = await store.forkSession(props.messageId, title.value);
    // Closing only on success: a refusal's sentence is in the error strip behind the overlay,
    // and a dialog that closed would hide the reason it failed.
    if (created) emit("close");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal sm" data-testid="fork-session-dialog">
        <div class="modal-head">
          <h3>{{ t("message.fork.title") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            data-testid="fork-session-close"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>{{ t("session.fork.titleLabel") }}</label>
            <input
              v-model="title"
              class="input"
              data-testid="fork-title-input"
              @keydown.enter="create"
            />
          </div>
          <div class="hint">{{ t("session.fork.hint") }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button
            class="btn primary"
            data-testid="fork-session-create"
            :disabled="saving"
            @click="create"
          >
            {{ t("message.fork.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
