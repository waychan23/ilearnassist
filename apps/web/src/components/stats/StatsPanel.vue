<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../api/client";
import { chartTheme, documentThemeReader, shortDayLabel, type ChartConfig } from "../../utils/charts";
import { useTheme } from "../../composables/theme";
import { formatTokens } from "../../utils/format";
import type {
  UsageBucket,
  UsageQuery,
  UsageSessionRow,
  UsageStats,
  UsageTotals,
} from "../../api/types";
import Icon from "../Icon.vue";
import UsageChart from "./UsageChart.vue";

/**
 * The statistics pages, one component.
 *
 * Rendered by two hosts that differ only in **scope**: the account's own page, which reads
 * `/api/stats`, and the console's section, which reads `/api/admin/stats`. Both draw the same
 * tables and the same charts from the same shape, and that is the reason this is one component
 * rather than two — a second implementation would be a second set of decisions about what a figure
 * means, and the two would drift the first time one gained a column.
 *
 * It reads the API directly rather than through the store, which is what the console's own section
 * does (`AdminConsole.vue`): this is a page's own load, nothing else in the app reads it, and a
 * store action would be a cache nobody consults.
 *
 * Two things are deliberate about how it reads:
 *
 * - **Every figure is a sum over calls, and the page says so.** An average appears where it answers
 *   a question (`ms/次`) and nowhere else: a sum and an average side by side with no labels is the
 *   fastest way to misread a table.
 * - **The date range is the *reader's* range.** The zone travels with the query and the server cuts
 *   the days in it, so a token spent at 23:30 local is on the day the reader had.
 */

const props = defineProps<{
  /**
   * Which ledger to read.
   *
   * A prop rather than a route check: the *page* decides whose numbers these are, and this
   * component cannot be wrong about it — it asks for exactly one of the two endpoints.
   */
  scope: "self" | "platform";
}>();

const { t, locale } = useI18n();
const theme = useTheme();

const stats = ref<UsageStats | null>(null);
const sessions = ref<UsageSessionRow[]>([]);
const loading = ref(false);
const failure = ref<string | null>(null);

/** The range as the two inputs hold it. Empty means unbounded, which is what the server reads. */
const from = ref("");
const to = ref("");
/** Which preset is lit, or null once the inputs are typed in. */
const preset = ref<number | null>(null);

function localDay(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function applyPreset(days: number | null): void {
  preset.value = days;
  if (days === null) {
    from.value = "";
    to.value = "";
    return;
  }
  // Local dates from the browser's own clock. `toISOString` would answer in UTC, which puts
  // "today" on the wrong day for anybody east or west of Greenwich — and "today" is the one range
  // a reader is most sure about.
  const day = (back: number): string => {
    const at = new Date();
    at.setDate(at.getDate() - back);
    return localDay(at);
  };
  from.value = day(days - 1);
  to.value = day(0);
}

function query(): UsageQuery {
  const q: UsageQuery = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (from.value) q.from = from.value;
  if (to.value) q.to = to.value;
  return q;
}

async function load(): Promise<void> {
  loading.value = true;
  failure.value = null;
  try {
    const q = query();
    stats.value = props.scope === "platform" ? await api.adminUsage(q) : await api.usage(q);
    sessions.value = (await api.usageSessions(q)).sessions;
  } catch (e) {
    // Already a sentence: `utils/apiError.ts` is the one place a server code becomes wording.
    failure.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
// One watcher on the pair rather than a call in each handler: a preset sets *both* bounds, and two
// call sites is how the range and the request drift apart.
watch([from, to], load);

/* ---------------------------------- the figures ---------------------------------- */

const totals = computed<UsageTotals | null>(() => stats.value?.totals ?? null);

/**
 * Whether this deployment has ever counted anything.
 *
 * Deliberately not "this range is empty", which is a different statement with a different remedy:
 * the first is a ledger with no rows, the second a range that happens to contain none.
 */
const everCounted = computed(() => !!stats.value?.since);

/**
 * When the first row was written, said as a fact rather than implied.
 *
 * The ledger is forward-only, so a page reporting zeroes for last month is telling the truth about
 * its *own* window — and a reader not told that will read it as a month in which nothing was spent.
 */
const sinceLabel = computed(() => {
  const since = stats.value?.since;
  return since ? new Date(since).toLocaleString(locale.value) : "";
});

/** The server's name for a workspace, provider or model; the key when it has none. */
function label(bucket: UsageBucket): string {
  return bucket.label ?? bucket.key;
}

/**
 * A purpose id as wording.
 *
 * From the catalog, because a purpose is a *kind of thing* rather than a name the server holds —
 * unlike a workspace or a model, whose names arrive with the row. An unrecognised id (a newer
 * server) shows itself rather than a blank, which is the same rule `label` follows.
 */
function purposeLabel(key: string): string {
  const known = ["chat", "title", "thread", "insight", "summary.media"];
  return known.includes(key) ? t(`usage.purpose.${key}`) : key;
}

/**
 * The mean wall-clock time per call, or an em dash when nobody measured any.
 *
 * The distinction the ledger stores: `duration_ms` is NULL for a call nobody timed, which sums to
 * zero — so a row showing `0` would claim every call came back instantly, and a reader comparing
 * two purposes would conclude the cheap one was the fast one. Dividing by the calls that *were*
 * timed would be better still, and the ledger does not carry that count, so an unmeasured row says
 * so instead of guessing.
 */
function averageMs(row: UsageTotals): string {
  if (row.calls === 0 || row.durationMs === 0) return "—";
  return formatTokens(Math.round(row.durationMs / row.calls));
}

/* ---------------------------------- the charts ---------------------------------- */

/**
 * The palette, re-read on every theme flip.
 *
 * Reading `theme.resolved` here is what subscribes this computed to the theme, so a flip produces
 * a new config object — which is the one cause `UsageChart` watches. A second signal for the same
 * effect is how a canvas ends up drawn in the previous theme's colours.
 */
const palette = computed(() => {
  void theme.resolved.value;
  return chartTheme(documentThemeReader());
});

/**
 * The time series: one line per token kind, over the days the range covers.
 *
 * Three series rather than four, and that is arithmetic rather than taste: cache-miss input and
 * cached input *are* the input, so plotting both halves beside it would draw the input twice and
 * read as more spend than there was.
 */
const dayChart = computed<ChartConfig>(() => {
  const days = stats.value?.byDay ?? [];
  return {
    kind: "line",
    labels: days.map((d) => shortDayLabel(d.key)),
    series: [
      { label: t("usage.field.cacheMiss"), data: days.map((d) => d.cacheMissInputTokens) },
      { label: t("usage.field.cached"), data: days.map((d) => d.cachedInputTokens) },
      { label: t("usage.field.output"), data: days.map((d) => d.outputTokens) },
    ],
    theme: palette.value,
  };
});

/** The purpose breakdown, as bars: six categories compared by size rather than over time. */
const purposeChart = computed<ChartConfig>(() => {
  const rows = stats.value?.byPurpose ?? [];
  return {
    kind: "bar",
    labels: rows.map((b) => purposeLabel(b.key)),
    series: [
      { label: t("usage.field.input"), data: rows.map((b) => b.inputTokens) },
      { label: t("usage.field.output"), data: rows.map((b) => b.outputTokens) },
    ],
    theme: palette.value,
  };
});
</script>

<template>
  <div class="stats" :data-testid="`stats-${props.scope}`">
    <!-- The range, and the presets that set it. -->
    <div class="stats-range" data-testid="stats-range">
      <!--
        Labels are literal `t()` calls in the list rather than keys built from an id: the catalog's
        dead-key scan reads literals, and a `usage.range.${id}` would have to be declared as a
        dynamic prefix — which is where a typo hides. See the allowlist's own note.
      -->
      <button
        v-for="option in [
          { days: 1, key: 'today', label: t('usage.range.today') },
          { days: 7, key: 'week', label: t('usage.range.week') },
          { days: 30, key: 'month', label: t('usage.range.month') },
          { days: null, key: 'all', label: t('usage.range.all') },
        ]"
        :key="option.key"
        type="button"
        class="btn ghost small"
        :class="{ active: preset === option.days }"
        :data-testid="`stats-preset-${option.key}`"
        @click="applyPreset(option.days)"
      >
        {{ option.label }}
      </button>

      <label class="range-field">
        <span>{{ t("usage.range.from") }}</span>
        <input v-model="from" class="input" type="date" data-testid="stats-from" @input="preset = null" />
      </label>
      <label class="range-field">
        <span>{{ t("usage.range.to") }}</span>
        <input v-model="to" class="input" type="date" data-testid="stats-to" @input="preset = null" />
      </label>

      <span v-if="loading" class="stats-loading" data-testid="stats-loading">
        {{ t("usage.loading") }}
      </span>
    </div>

    <p v-if="failure" class="form-error" data-testid="stats-error" role="alert">
      <Icon name="warning" />
      <span>{{ failure }}</span>
    </p>

    <p v-else-if="stats && !everCounted" class="stats-empty" data-testid="stats-empty">
      {{ t("usage.empty") }}
    </p>

    <template v-else-if="stats">
      <!--
        When counting began. Stated rather than implied: the ledger is forward-only, so a page
        reporting zeroes for last month is telling the truth about its *own* window, and a reader
        who is not told that will read it as a month in which nothing was spent.
      -->
      <p class="stats-since" data-testid="stats-since">
        {{ t("usage.since", { when: sinceLabel }) }}
      </p>

      <!-- The headline figures. -->
      <div class="stats-tiles" data-testid="stats-totals">
        <div
          v-for="tile in [
            { key: 'total', label: t('usage.tile.total'), value: formatTokens(totals!.totalTokens) },
            { key: 'input', label: t('usage.tile.input'), value: formatTokens(totals!.inputTokens) },
            { key: 'cached', label: t('usage.tile.cached'), value: formatTokens(totals!.cachedInputTokens) },
            { key: 'output', label: t('usage.tile.output'), value: formatTokens(totals!.outputTokens) },
            { key: 'calls', label: t('usage.tile.calls'), value: formatTokens(totals!.calls) },
          ]"
          :key="tile.key"
          class="stats-tile"
          :data-testid="`stats-tile-${tile.key}`"
        >
          <span class="tile-value">{{ tile.value }}</span>
          <span class="tile-label">{{ tile.label }}</span>
        </div>
      </div>

      <section v-if="stats.byDay.length > 1" class="stats-block">
        <h3 class="home-title">{{ t("usage.chart.overTime") }}</h3>
        <div class="chart-box">
          <UsageChart :config="dayChart" testid="stats-chart-days" />
        </div>
      </section>

      <section v-if="stats.byPurpose.length > 0" class="stats-block">
        <h3 class="home-title">{{ t("usage.chart.byPurpose") }}</h3>
        <div class="chart-box">
          <UsageChart :config="purposeChart" testid="stats-chart-purpose" />
        </div>
      </section>

      <!--
        The tables. One per breakdown, each with the same columns, so a reader comparing two of
        them is comparing like with like.
      -->
      <section
        v-for="table in [
          { key: 'purpose', label: t('usage.table.purpose'), rows: stats.byPurpose, byPurpose: true },
          { key: 'provider', label: t('usage.table.provider'), rows: stats.byProvider, byPurpose: false },
          { key: 'model', label: t('usage.table.model'), rows: stats.byModel, byPurpose: false },
          { key: 'workspace', label: t('usage.table.workspace'), rows: stats.byWorkspace, byPurpose: false },
          { key: 'user', label: t('usage.table.user'), rows: stats.byUser ?? [], byPurpose: false },
        ]"
        v-show="table.rows.length > 0"
        :key="table.key"
        class="stats-block"
      >
        <h3 class="home-title">{{ table.label }}</h3>
        <table class="stats-table" :data-testid="`stats-table-${table.key}`">
          <thead>
            <tr>
              <th>{{ table.label }}</th>
              <th>{{ t("usage.field.calls") }}</th>
              <th>{{ t("usage.field.input") }}</th>
              <th>{{ t("usage.field.cached") }}</th>
              <th>{{ t("usage.field.output") }}</th>
              <!--
                Its own column rather than folded into the output: reasoning tokens are *inside*
                the output figure, so their column cannot be added to its neighbour and the header
                has to be honest about that.
              -->
              <th>{{ t("usage.field.reasoning") }}</th>
              <th>{{ t("usage.field.total") }}</th>
              <th>{{ t("usage.field.averageMs") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="bucket in table.rows" :key="bucket.key" :data-testid="`stats-row-${bucket.key}`">
              <td>{{ table.byPurpose ? purposeLabel(bucket.key) : label(bucket) }}</td>
              <td class="num">{{ formatTokens(bucket.calls) }}</td>
              <td class="num">{{ formatTokens(bucket.inputTokens) }}</td>
              <td class="num">{{ formatTokens(bucket.cachedInputTokens) }}</td>
              <td class="num">{{ formatTokens(bucket.outputTokens) }}</td>
              <td class="num">{{ formatTokens(bucket.reasoningTokens) }}</td>
              <td class="num">{{ formatTokens(bucket.totalTokens) }}</td>
              <td class="num">{{ averageMs(bucket) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="sessions.length > 0" class="stats-block">
        <h3 class="home-title">{{ t("usage.table.session") }}</h3>
        <table class="stats-table" data-testid="stats-table-session">
          <thead>
            <tr>
              <th>{{ t("usage.table.session") }}</th>
              <th>{{ t("usage.field.calls") }}</th>
              <th>{{ t("usage.field.input") }}</th>
              <th>{{ t("usage.field.output") }}</th>
              <th>{{ t("usage.field.total") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in sessions" :key="row.sessionId" :data-testid="`stats-session-${row.sessionId}`">
              <td>{{ row.title || t("usage.untitled") }}</td>
              <td class="num">{{ formatTokens(row.calls) }}</td>
              <td class="num">{{ formatTokens(row.inputTokens) }}</td>
              <td class="num">{{ formatTokens(row.outputTokens) }}</td>
              <td class="num">{{ formatTokens(row.totalTokens) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p v-if="stats.totals.calls === 0" class="stats-empty" data-testid="stats-range-empty">
        {{ t("usage.emptyRange") }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}

.stats-range {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--space-3);
}

/* The chosen preset, which the range inputs clear when they are typed in. */
.stats-range .btn.active {
  border-color: var(--accent);
  color: var(--accent);
}

.range-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--fs-2);
  color: var(--text-3);
}

.stats-loading,
.stats-since,
.stats-empty {
  margin: 0;
  font-size: var(--fs-2);
  color: var(--text-3);
}

.stats-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-4);
}

.stats-tile {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.tile-value {
  font-size: var(--fs-5);
  color: var(--text);
}

.tile-label {
  font-size: var(--fs-2);
  color: var(--text-3);
}

.stats-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* A fixed height, because `maintainAspectRatio: false` means the canvas takes exactly its box —
   and a chart that grew with its data would resize the page as the range changed. */
.chart-box {
  height: 220px;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.stats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-2);
}

.stats-table th,
.stats-table td {
  padding: var(--space-2) var(--space-3);
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.stats-table th {
  color: var(--text-3);
  font-weight: 500;
}

.stats-table td {
  color: var(--text);
}

/* Figures line up on their last digit, which is the only way a column of totals is comparable. */
.stats-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
