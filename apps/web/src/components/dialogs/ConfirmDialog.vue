<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";
import { confirmState, settleConfirm } from "../../composables/confirm";

const confirmBtn = ref<HTMLButtonElement | null>(null);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    settleConfirm(false);
  }
}

// A window-level listener rather than `@keydown` on the overlay: the overlay is not
// focusable, so key events never reach it.
watch(
  () => confirmState.open,
  (open) => {
    if (open) {
      window.addEventListener("keydown", onKeydown);
      // Focus the confirm button so Enter accepts without reaching for the mouse.
      nextTick(() => confirmBtn.value?.focus());
    } else {
      window.removeEventListener("keydown", onKeydown);
    }
  }
);

onUnmounted(() => window.removeEventListener("keydown", onKeydown));
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
    <div v-if="confirmState.open" class="modal-overlay" @click.self="settleConfirm(false)">
      <div class="modal sm">
        <div class="modal-head">
          <h3>{{ confirmState.title }}</h3>
          <button
          class="icon-btn"
          :title="$t('common.close')"
          :aria-label="$t('common.close')"
          @click="settleConfirm(false)"
        >✕</button>
        </div>
        <div class="modal-body">
          <p class="confirm-message">{{ confirmState.message }}</p>
          <p v-if="confirmState.detail" class="confirm-detail">{{ confirmState.detail }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="settleConfirm(false)">{{ confirmState.cancelText }}</button>
          <button
            ref="confirmBtn"
            class="btn"
            :class="confirmState.danger ? 'danger' : 'primary'"
            @click="settleConfirm(true)"
          >
            {{ confirmState.confirmText }}
          </button>
        </div>
      </div>
    </div>

  </Teleport>
</template>

<style scoped>
.confirm-message {
  margin: 0;
  word-break: break-word;
}
.confirm-detail {
  margin: var(--space-4) 0 0;
  font-size: var(--fs-3);
  color: var(--text-3);
}
</style>
