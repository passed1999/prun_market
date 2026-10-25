<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { errorText } from "../api/client";
import { categoryColor, categoryLabel, categoryTextColor } from "../api/materials";
import * as market from "../services/market";
import type { MarketCompany, MarketMaterial, MarketSnapshot } from "../api/types";

const snapshot = ref<MarketSnapshot | null>(null);
const detail = ref<MarketMaterial | null>(null);
const companies = ref<MarketCompany[]>([]);
const mode = ref<"materials" | "companies">("materials");
const month = ref("");
const search = ref("");
const category = ref("");
const sortKey = ref<SortKey>("volume");
const onlyShort = ref(false);
const error = ref("");
const busy = ref(false);
const detailBusy = ref(false);

type SortKey = "volume" | "amount" | "net_flow" | "cr4" | "producer_count";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "volume", label: "日产值" },
  { key: "amount", label: "日产量" },
  { key: "net_flow", label: "净流" },
  { key: "producer_count", label: "生产商家数" },
  { key: "cr4", label: "集中度" },
];

const CONFIDENCE: Record<string, string> = {
  exact: "配方",
  approx: "估算",
  partial: "不完整",
};

const WORKFORCE_LABEL: Record<string, string> = {
  PIONEER: "拓荒者", SETTLER: "定居者", TECHNICIAN: "技工",
  ENGINEER: "工程师", SCIENTIST: "科学家",
};

const route = useRoute();

onMounted(async () => {
  await load();
  const ticker = route.query.ticker;
  if (typeof ticker === "string" && ticker) await openMaterial(ticker);
});
watch(month, (_value, old) => { if (old !== "") load(); });

async function load() {
  busy.value = true;
  error.value = "";
  try {
    snapshot.value = await market.snapshot(month.value || undefined);
    if (!month.value) month.value = snapshot.value.month;
    companies.value = [];
    if (mode.value === "companies") await loadCompanies();
  } catch (e) {
    snapshot.value = null;
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

watch(mode, (value) => { if (value === "companies") loadCompanies(); });

async function loadCompanies() {
  if (companies.value.length && companies.value[0]?.company_id) return;
  try {
    companies.value = await market.topCompanies(month.value || undefined, 100);
  } catch (e) {
    error.value = errorText(e);
  }
}

async function openMaterial(ticker: string) {
  detailBusy.value = true;
  detail.value = null;
  error.value = "";
  try {
    detail.value = await market.material(ticker, month.value || undefined);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    detailBusy.value = false;
  }
}

const categories = computed(() => {
  const seen = new Set((snapshot.value?.materials ?? []).map((m) => m.category));
  return [...seen].filter(Boolean).sort();
});

const rows = computed(() => {
  const term = search.value.trim().toUpperCase();
  let list = (snapshot.value?.materials ?? []).filter((m) =>
    (!term || m.ticker.includes(term)) &&
    (!category.value || m.category === category.value) &&
    (!onlyShort.value || m.net_flow < 0));
  const key = sortKey.value;
  list = [...list].sort((a, b) =>
    key === "net_flow" ? a.net_flow - b.net_flow : (b[key] as number) - (a[key] as number));
  return list.slice(0, 200);
});

const latestUniverse = computed(() => snapshot.value?.universe.at(-1) ?? null);

function num(value: number, digits = 0): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function money(value: number): string {
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return num(value);
}

/** 折线：把一串数值压进 100×28 的坐标里 */
function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  return values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 26 - 1}`)
    .join(" ");
}
</script>

<template>
  <h2>全服市场</h2>
  <p v-if="error" class="err">{{ error }}</p>

  <div class="bar">
    <label>
      月份
      <select v-model="month" :disabled="busy">
        <option v-for="m in snapshot?.months ?? []" :key="m" :value="m">
          {{ snapshot?.universe.find((u) => u.month === m)?.label ?? m }}
        </option>
      </select>
    </label>
    <span v-if="busy" class="dim">读取中…</span>
    <template v-if="latestUniverse && !busy">
      <span class="stat"><b>{{ num(latestUniverse.bases) }}</b> 座基地</span>
      <span class="stat"><b>{{ num(latestUniverse.companies) }}</b> 家公司</span>
      <span class="stat"><b>{{ money(latestUniverse.volume) }}</b> 日产值</span>
    </template>
  </div>

  <template v-if="snapshot">
    <div class="bar tabs">
      <button :class="{ on: mode === 'materials' }" @click="mode = 'materials'">材料</button>
      <button :class="{ on: mode === 'companies' }" @click="mode = 'companies'">公司</button>
    </div>

    <template v-if="mode === 'companies'">
      <table class="companies">
        <thead><tr><th>名次</th><th>公司</th><th>军团</th><th>日产值</th></tr></thead>
        <tbody>
          <tr v-for="c in companies" :key="c.company_id">
            <td>{{ c.rank }}</td>
            <td>{{ c.name || "未知" }}</td>
            <td class="dim">{{ c.corp }}</td>
            <td>{{ money(c.volume) }}</td>
          </tr>
          <tr v-if="!companies.length"><td colspan="4" class="dim">读取中…</td></tr>
        </tbody>
      </table>
    </template>

    <template v-else>
    <div class="bar">
      <label>材料 <input v-model="search" placeholder="如 RAT" style="width:100px" /></label>
      <label>
        分类
        <select v-model="category">
          <option value="">全部</option>
          <option v-for="c in categories" :key="c" :value="c">{{ categoryLabel(c) }}</option>
        </select>
      </label>
      <label>
        排序
        <select v-model="sortKey">
          <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
      </label>
      <label><input v-model="onlyShort" type="checkbox" /> 只看净流为负的</label>
    </div>

    <div class="cols">
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>材料</th><th>日产量</th><th>日产值</th>
              <th>产线消耗</th><th>工人消费</th><th>净流</th>
              <th>生产商</th><th>CR4</th><th>口径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in rows" :key="m.ticker" class="row"
                :class="{ picked: detail?.ticker === m.ticker }" @click="openMaterial(m.ticker)">
              <td>
                <span class="tag" :style="{ background: categoryColor(m.category),
                                            color: categoryTextColor(m.category) }"
                      :title="categoryLabel(m.category)">{{ m.ticker }}</span>
              </td>
              <td>{{ num(m.amount) }}</td>
              <td>{{ money(m.volume) }}</td>
              <td class="dim">{{ num(m.line_consumption) }}</td>
              <td class="dim">{{ m.workforce_consumption ? num(m.workforce_consumption) : "" }}</td>
              <td :class="m.net_flow < 0 ? 'short' : 'long'">{{ num(m.net_flow) }}</td>
              <td class="dim">{{ m.producer_count || "—" }}</td>
              <td class="dim">{{ m.cr4 ? (m.cr4 * 100).toFixed(0) + "%" : "—" }}</td>
              <td><span class="conf" :class="m.confidence">{{ CONFIDENCE[m.confidence] }}</span></td>
            </tr>
            <tr v-if="!rows.length"><td colspan="9" class="dim">没有符合条件的材料</td></tr>
          </tbody>
        </table>
        <p v-if="rows.length === 200" class="dim">只列出前 200 种，缩小范围可看到其余的。</p>
      </div>

      <div>
        <p v-if="detailBusy" class="dim">读取中…</p>
        <p v-else-if="!detail" class="dim">选择一种材料，查看它的逐月走势、生产商与上下游。</p>
        <template v-else>
          <h3>
            <span class="tag" :style="{ background: categoryColor(detail.latest.category),
                                        color: categoryTextColor(detail.latest.category) }">
              {{ detail.ticker }}</span>
            {{ categoryLabel(detail.latest.category) }}
          </h3>
          <p>
            日产量 <b>{{ num(detail.latest.amount) }}</b> ·
            推算日消耗 <b>{{ num(detail.latest.line_consumption
              + detail.latest.workforce_consumption) }}</b> ·
            净流 <b :class="detail.latest.net_flow < 0 ? 'short' : 'long'">
              {{ num(detail.latest.net_flow) }}</b>
          </p>
          <p class="dim">
            {{ detail.latest.producer_count }} 家在产 ·
            前四大占 {{ (detail.latest.cr4 * 100).toFixed(0) }}% ·
            集中度 {{ detail.latest.hhi.toFixed(3) }}
          </p>

          <template v-if="detail.series.length > 1">
            <h4>产量与消耗</h4>
            <svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none">
              <polyline :points="sparkline(detail.series.map((p) => p.amount))"
                        fill="none" stroke="#7fb37f" stroke-width="1.2" vector-effect="non-scaling-stroke" />
              <polyline :points="sparkline(detail.series.map((p) => p.demand))"
                        fill="none" stroke="#e0a33e" stroke-width="1.2" stroke-dasharray="3 2"
                        vector-effect="non-scaling-stroke" />
            </svg>
            <p class="dim legend">
              <span class="key produced"></span>产量
              <span class="key demanded"></span>消耗 ·
              {{ detail.series[0].label }} → {{ detail.series.at(-1)?.label }}
            </p>
          </template>

          <h4>生产商</h4>
          <table class="mini">
            <tbody>
              <tr v-for="p in detail.producers.slice(0, 10)" :key="p.company_id">
                <td>{{ p.name || "未知" }}</td>
                <td class="dim">{{ p.corp }}</td>
                <td>{{ num(p.amount, 1) }}/天</td>
                <td class="dim">{{ (p.share * 100).toFixed(1) }}%</td>
              </tr>
              <tr v-if="!detail.producers.length"><td colspan="4" class="dim">没有生产商数据</td></tr>
            </tbody>
          </table>

          <h4>谁在生产</h4>
          <table class="mini">
            <tbody>
              <tr v-for="u in detail.made_by.slice(0, 6)" :key="u.recipe_id">
                <td class="recipe">{{ u.recipe_id }}</td>
                <td>{{ num(u.daily_amount) }}/天</td>
              </tr>
              <tr v-if="!detail.made_by.length"><td colspan="2" class="dim">配方表里没有产出它的配方</td></tr>
            </tbody>
          </table>

          <h4>被谁消耗</h4>
          <table class="mini">
            <tbody>
              <tr v-for="u in detail.consumed_by.slice(0, 8)" :key="u.recipe_id">
                <td class="recipe">{{ u.recipe_id }}</td>
                <td>{{ num(u.daily_amount) }}/天</td>
              </tr>
              <tr v-if="!detail.consumed_by.length">
                <td colspan="2" class="dim">没有配方吃它，去向是建造或造船</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
    </div>

    </template>

    <details class="notes">
      <summary>数据口径</summary>
      <p>
        产量来自每月发布的全服排行榜，次月初更新，因此最新月份通常是上个月。
        消耗没有现成数据，由配方与工人需求推算：
      </p>
      <ul>
        <li><b>配方</b>：消耗全部来自配方，且每种下游产品都只有唯一产出配方。</li>
        <li><b>估算</b>：下游有多条候选配方按等权拆分，或含由全服人口反推的工人消费。</li>
        <li><b>不完整</b>：还有建造与造船的去向算不出来，净流只能当上限看。</li>
      </ul>
      <p>
        全服人口估算（由只有该级工人消费的必需品反推）：
        <span v-for="(n, level) in snapshot.workforce_estimate" :key="level">
          {{ WORKFORCE_LABEL[level] ?? level }} {{ money(n) }} ·
        </span>
      </p>
      <p v-if="snapshot.consumed_until">
        数据源自带的实际消耗数据截止到
        {{ snapshot.universe.find((u) => u.month === snapshot!.consumed_until)?.label }}，
        推算结果已与之逐月对账。
      </p>
    </details>
  </template>
</template>

<style scoped>
h3 { font-size: 14px; color: #9db4d0; margin: 0 0 8px; }
h4 { font-size: 12px; color: #9db4d0; margin: 16px 0 4px; text-transform: none; }
.cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(300px, 1fr); gap: 24px; }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.scroll { overflow-x: auto; }
.bar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.stat { color: #8a8f99; }
.stat b { color: #e2e2e2; }
table { width: 100%; font-size: 13px; }
table.mini { font-size: 12px; }
th { text-align: left; color: #9db4d0; font-weight: normal; }
td { text-align: right; }
td:first-child, th:first-child { text-align: left; }
.row { cursor: pointer; }
.row:hover td { background: #232733; }
.row.picked td { background: #2c3140; }
.tag { display: inline-block; min-width: 42px; text-align: center; padding: 1px 6px;
       border-radius: 3px; font-size: 12px; font-weight: 600; }
.conf { font-size: 11px; padding: 1px 5px; border-radius: 3px; }
.conf.exact { color: #7fb37f; }
.conf.approx { color: #c9b06a; }
.conf.partial { color: #8a8f99; }
.short { color: #e07a5f; }
.long { color: #7fb37f; }
.recipe { font-family: ui-monospace, monospace; font-size: 11px; text-align: left; }
.spark { width: 100%; height: 44px; background: #1b1e25; border-radius: 3px; }
.legend { font-size: 11px; margin-top: 4px; }
.key { display: inline-block; width: 10px; height: 2px; margin: 0 4px 3px 0; }
.key.produced { background: #7fb37f; }
.key.demanded { background: #e0a33e; }
.tabs button { background: #23262e; color: #9db4d0; border: 1px solid #444; padding: 4px 14px;
               cursor: pointer; }
.tabs button.on { background: #2c3140; color: #fff; }
.companies { max-width: 620px; }
.notes { margin-top: 24px; color: #8a8f99; font-size: 12px; max-width: 760px; }
.notes summary { cursor: pointer; color: #9db4d0; }
.notes ul { margin: 6px 0; padding-left: 20px; }
.dim { color: #8a8f99; }
.err { color: #e66; }
label { display: inline-flex; gap: 6px; align-items: center; }
input, select { background: #23262e; color: #eee; border: 1px solid #444; padding: 3px 6px; }
</style>
