<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import StatsPanel from "./stats/StatsPanel.vue";
import TopbarControls from "./TopbarControls.vue";
import Icon from "./Icon.vue";

/**
 * The account's own usage: what its conversations and its background passes have cost.
 *
 * A page of its own rather than a card on the account page, because it is a place with an address
 * — a range somebody is looking at can be linked to, and reloading comes back to it. The account
 * page is where a fact about *you* lives; this is a screen you read.
 *
 * It reads the account's own ledger. An administrator sees the same screen scoped to themselves
 * here, and everybody's spend in the console — two pages over one component, because "my usage" and
 * "the installation's usage" are different questions that happen to share a table.
 */
const { t } = useI18n();
const router = useRouter();
</script>

<template>
  <div class="workspace-home" data-testid="usage-page">
    <header class="home-head">
      <button
        class="icon-btn"
        data-testid="usage-back"
        :title="t('common.back')"
        :aria-label="t('common.back')"
        @click="router.push({ name: 'home' })"
      >
        <Icon name="arrow-left" />
      </button>
      <span class="home-brand">{{ t("usage.title") }}</span>
      <TopbarControls />
    </header>

    <div class="home-scroll">
      <div class="usage-body">
        <p class="home-sub usage-lead">{{ t("usage.selfLead") }}</p>
        <StatsPanel scope="self" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.usage-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  /* Wider than the account page's column: these are tables and charts, and a stats table in a
     640px column wraps its headers. */
  max-width: 960px;
}

.usage-lead {
  margin: 0;
}
</style>
