<script setup lang="ts">
import { useI18n } from "vue-i18n";
import StatsPanel from "../stats/StatsPanel.vue";

/**
 * The console's statistics section: the whole installation's model spend.
 *
 * A thin host, and deliberately so — everything it shows is `StatsPanel`'s, and the only thing it
 * decides is *whose* numbers those are. `scope: "platform"` is what asks `/api/admin/stats`, which
 * is the route that carries the per-account breakdown the other one omits.
 *
 * The heading and the lead are the console's own copy rather than the panel's, because they are
 * about the console's relationship to the numbers — an administrator looking at everybody — and the
 * panel has no idea which of the two it is being drawn by.
 */
const { t } = useI18n();
</script>

<template>
  <div class="stats-section" data-testid="admin-stats">
    <p class="home-sub stats-lead">{{ t("usage.platformLead") }}</p>
    <StatsPanel scope="platform" />
  </div>
</template>

<style scoped>
.stats-lead {
  margin-bottom: var(--space-6);
}
</style>
