<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { errorText } from "../api/client";
import { categoryColor, categoryLabel, categoryTextColor } from "../api/materials";
import { fio } from "../data/sources";
import * as profit from "../services/profit";
import type { ExchangeCode, PriceSource, ProfitAnalysis, ProfitRecipe } from "../api/types";

const EXCHANGES: ExchangeCode[] = ["AI1", "CI1", "CI2", "IC1", "NC1", "NC2"];
const SOURCE_LABEL: Record<PriceSource, string> = {
  BID: "买一价", ASK: "卖一价", AVG: "均价", PP7D: "7 日均价", PP30D: "30 日均价", UNIVERSE: "全服均价",
};
const SOURCES = Object.keys(SOURCE_LABEL) as PriceSource[];

// 买卖口径记在浏览器里，下次打开还是上次选的
const PREF_KEY = "prun-market.profit.prefs";
interface Pref { exchange: ExchangeCode; price_source: PriceSource }
function loadPrefs(): { buy: Pref; sell: Pref } {
  const fallback = { buy: { exchange: "NC1" as ExchangeCode, price_source: "ASK" as PriceSource },
                     sell: { exchange: "NC1" as ExchangeCode, price_source: "BID" as PriceSource } };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    const ok = (p: Pref | undefined) =>
      p && EXCHANGES.includes(p.exchange) && SOURCES.includes(p.price_source);
    return { buy: ok(saved.buy) ? saved.buy : fallback.buy, sell: ok(saved.sell) ? saved.sell : fallback.sell };
  } catch {
    return fallback;
  }
}
const prefs = loadPrefs();
const buy = reactive<Pref>(prefs.buy);
const sell = reactive<Pref>(prefs.sell);
watch([buy, sell], () => {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ buy, sell })); } catch { /* 隐私模式 */ }
}, { deep: true });

const ticker = ref("");
const tickers = ref<string[]>([]);
const data = ref<ProfitAnalysis | null>(null);
const recipeId = ref("");
/** 当前用来计算的价格，键是 `sell:RAT` / `buy:GRN`；空 = 没有价格，按 0 计 */
const prices = reactive<Record<string, number | null | "">>({});
const target = ref<number | null>(null);
const error = ref("");
const busy = ref(false);

onMounted(async () => {
  try {
    tickers.value = (await fio.materials()).map((m) => m.Ticker).sort();
  } catch { /* 候选列表拿不到不影响手动输入 */ }
});

async function load() {
  const wanted = ticker.value.trim().toUpperCase();
  if (!wanted) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await profit.analyze(wanted, {
      exchange: buy.exchange, price_source: buy.price_source,
      sell_exchange: sell.exchange, sell_price_source: sell.price_source,
    });
    data.value = result;
    ticker.value = result.ticker;
    resetPrices();
    const best = [...result.recipes].sort((a, b) => perArea(b) - perArea(a))[0];
    if (!result.recipes.some((r) => r.recipe_id === recipeId.value)) recipeId.value = best.recipe_id;
  } catch (e) {
    data.value = null;
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

/** 换口径后只在已经算过一次时重算，没输入材料时什么都不做 */
function reload() {
  if (data.value) load();
}

// ---- 价格 ----

function market(key: string): number | null {
  const [side, t] = key.split(":");
  const table = side === "sell" ? data.value?.sell_prices : data.value?.buy_prices;
  const v = table?.[t];
  return v == null ? null : round(v);     // 输入框里只留两位小数，基准也按同一个数算
}

function resetPrices() {
  for (const key of Object.keys(prices)) delete prices[key];
  for (const r of data.value?.recipes ?? []) {
    for (const l of r.outputs) prices[`sell:${l.ticker}`] = market(`sell:${l.ticker}`);
    for (const l of [...r.inputs, ...r.workforce]) prices[`buy:${l.ticker}`] = market(`buy:${l.ticker}`);
  }
}

function priceOf(key: string): number {
  const v = prices[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function changed(key: string): boolean {
  return priceOf(key) !== (market(key) ?? 0);
}

const anyChanged = computed(() => Object.keys(prices).some(changed));

// ---- 计算（一座建筑、每天）----

type PriceFn = (key: string) => number;

function totals(r: ProfitRecipe, p: PriceFn = priceOf) {
  const revenue = r.outputs.reduce((s, l) => s + l.amount * p(`sell:${l.ticker}`), 0);
  const inputs = r.inputs.reduce((s, l) => s + l.amount * p(`buy:${l.ticker}`), 0);
  const workforce = r.workforce.reduce((s, l) => s + l.amount * p(`buy:${l.ticker}`), 0);
  const profit = revenue - inputs - workforce;
  return {
    revenue, inputs, workforce, profit,
    perArea: profit / r.area,
    payback: profit > 0 && r.build_cost > 0 ? r.build_cost / profit : null,
  };
}

function perArea(r: ProfitRecipe): number {
  return totals(r).perArea;
}

const marketPrice: PriceFn = (key) => market(key) ?? 0;

const recipes = computed(() =>
  [...(data.value?.recipes ?? [])].sort((a, b) => perArea(b) - perArea(a)));
const recipe = computed(() =>
  data.value?.recipes.find((r) => r.recipe_id === recipeId.value) ?? null);
const now = computed(() => (recipe.value ? totals(recipe.value) : null));
const base = computed(() => (recipe.value ? totals(recipe.value, marketPrice) : null));

/** 一座建筑每天产出的这种材料，占卖出交易所日成交量的比例 */
const share = computed(() => {
  const traded = data.value?.daily_traded;
  const made = recipe.value?.outputs.find((l) => l.ticker === data.value?.ticker)?.amount;
  return traded && made ? made / traded : null;
});

// ---- 价格表与反推 ----

interface Row { key: string; ticker: string; amount: number; sign: 1 | -1 }

const groups = computed(() => {
  const r = recipe.value;
  if (!r) return [];
  const rows = (lines: ProfitRecipe["outputs"], side: "sell" | "buy"): Row[] =>
    lines.map((l) => ({ key: `${side}:${l.ticker}`, ticker: l.ticker, amount: l.amount,
                        sign: side === "sell" ? 1 : -1 }));
  return [
    { id: "out", label: "产出", rows: rows(r.outputs, "sell") },
    { id: "in", label: "配方投入", rows: rows(r.inputs, "buy") },
    { id: "wf", label: "工人消耗", rows: rows(r.workforce, "buy") },
  ].filter((g) => g.rows.length);
});

/** 距离目标还差多少利润（每天、一座建筑）；没填目标为 null */
const gap = computed(() => {
  if (target.value == null || (target.value as unknown) === "" || !recipe.value || !now.value) return null;
  return target.value * recipe.value.area - now.value.profit;
});

/** 同一个价格在配方投入和工人消耗里都出现时，改它两边一起动 */
function quantity(key: string): number {
  const r = recipe.value!;
  const lines = key.startsWith("sell:") ? r.outputs : [...r.inputs, ...r.workforce];
  const t = key.slice(key.indexOf(":") + 1);
  return lines.filter((l) => l.ticker === t).reduce((s, l) => s + l.amount, 0);
}

/** 只改这一行的价格、其余不动，达到目标所需的价格；达不到（要负价）为 null */
function solved(row: Row): number | null {
  if (gap.value == null) return null;
  const q = quantity(row.key);
  if (!q) return null;
  const p = priceOf(row.key) + (row.sign * gap.value) / q;
  return p >= 0 ? p : null;
}

/** 配方投入整体同比例调价达到目标的系数 */
const inputScale = computed(() => {
  if (gap.value == null || !now.value || now.value.inputs <= 0) return null;
  const k = 1 - gap.value / now.value.inputs;
  return k >= 0 ? k : null;
});

function apply(row: Row) {
  const p = solved(row);
  if (p != null) prices[row.key] = round(p);
}

function applyScale() {
  const k = inputScale.value;
  if (k == null || !recipe.value) return;
  for (const l of recipe.value.inputs) prices[`buy:${l.ticker}`] = round(priceOf(`buy:${l.ticker}`) * k);
}

// ---- 格式 ----

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function num(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function price(value: number | null | undefined): string {
  return value == null ? "—" : num(value, Math.abs(value) < 100 ? 2 : 1);
}

function delta(to: number, from: number): string {
  if (!from) return "";
  const pct = (to / from - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function tagStyle(t: string) {
  const c = data.value?.categories[t];
  return { background: categoryColor(c), color: categoryTextColor(c) };
}

/** `FP:1xALG-1xGRN=>10xRAT` → `1 ALG + 1 GRN → 10 RAT` */
function formula(id: string): string {
  const body = id.slice(id.indexOf(":") + 1);
  const side = (s: string) => s.split("-").filter(Boolean).map((x) => x.replace("x", " ")).join(" + ");
  const [left, right] = body.split("=>");
  return `${side(left) || "—"} → ${side(right ?? "")}`;
}
</script>

<template>
  <h2>面积利润</h2>
  <p v-if="error" class="err">{{ error }}</p>

  <form class="bar" @submit.prevent="load()">
    <label>
      材料
      <input v-model="ticker" list="profit-tickers" placeholder="如 RAT" style="width:90px" />
      <datalist id="profit-tickers"><option v-for="t in tickers" :key="t" :value="t" /></datalist>
    </label>
    <label>
      卖出
      <select v-model="sell.exchange" @change="reload()">
        <option v-for="c in EXCHANGES" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="sell.price_source" @change="reload()">
        <option v-for="s in SOURCES" :key="s" :value="s">{{ SOURCE_LABEL[s] }}</option>
      </select>
    </label>
    <label>
      买入
      <select v-model="buy.exchange" @change="reload()">
        <option v-for="c in EXCHANGES" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="buy.price_source" @change="reload()">
        <option v-for="s in SOURCES" :key="s" :value="s">{{ SOURCE_LABEL[s] }}</option>
      </select>
    </label>
    <button type="submit" :disabled="busy || !ticker.trim()">计算</button>
    <span v-if="busy" class="dim">读取中…</span>
  </form>

  <div v-if="data && recipe && now && base" class="cols">
    <section class="scroll">
      <h3>配方</h3>
      <table>
        <thead>
          <tr>
            <th>建筑</th><th>配方</th><th class="num">面积</th>
            <th class="num">日利润</th><th class="num">每面积日利润</th><th class="num">回本天数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in recipes" :key="r.recipe_id"
              :class="['row', { picked: r.recipe_id === recipeId }]" @click="recipeId = r.recipe_id">
            <td class="left">{{ r.building }}</td>
            <td class="left">{{ formula(r.recipe_id) }}</td>
            <td>{{ r.area }}</td>
            <td :class="totals(r).profit >= 0 ? 'long' : 'short'">{{ num(totals(r).profit) }}</td>
            <td :class="totals(r).profit >= 0 ? 'long' : 'short'">{{ num(totals(r).perArea, 1) }}</td>
            <td>{{ num(totals(r).payback, 1) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="scroll">
      <h3>{{ recipe.building }} · {{ formula(recipe.recipe_id) }}</h3>

      <dl class="metrics">
        <div class="main">
          <dt>每面积日利润</dt>
          <dd :class="now.profit >= 0 ? 'long' : 'short'">{{ num(now.perArea, 1) }}</dd>
          <dd v-if="anyChanged" class="was">市场价 {{ num(base.perArea, 1) }}</dd>
        </div>
        <div>
          <dt>回本天数</dt>
          <dd>{{ num(now.payback, 1) }}</dd>
          <dd v-if="anyChanged" class="was">市场价 {{ num(base.payback, 1) }}</dd>
        </div>
        <div>
          <dt>日利润</dt>
          <dd>{{ num(now.profit) }}</dd>
          <dd v-if="anyChanged" class="was">市场价 {{ num(base.profit) }}</dd>
        </div>
        <div><dt>日收入</dt><dd>{{ num(now.revenue) }}</dd></div>
        <div><dt>日成本</dt><dd>{{ num(now.inputs + now.workforce) }}</dd></div>
        <div><dt>面积</dt><dd>{{ recipe.area }}</dd></div>
        <div><dt>建造成本</dt><dd>{{ num(recipe.build_cost) }}</dd></div>
        <div><dt>{{ data.sell_exchange }} 日成交量</dt><dd>{{ num(data.daily_traded) }}</dd></div>
        <div>
          <dt>单建筑日产出占比</dt>
          <dd>{{ share == null ? "—" : `${(share * 100).toFixed(share < 0.1 ? 2 : 1)}%` }}</dd>
        </div>
      </dl>

      <div class="bar">
        <label>
          目标每面积日利润
          <input v-model.number="target" type="number" step="any" style="width:90px" />
        </label>
        <button :disabled="!anyChanged" @click="resetPrices()">恢复市场价</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>材料</th><th class="num">每日数量</th><th class="num">市场价</th>
            <th class="num">计算价</th><th class="num">每日金额</th>
            <th v-if="gap != null" class="num">达到目标的价格</th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.id">
          <tr class="group">
            <td :colspan="gap != null ? 5 : 6">{{ g.label }}</td>
            <td v-if="gap != null">
              <button v-if="g.id === 'in' && inputScale != null" title="配方投入整体按同一比例调价"
                      @click="applyScale()">
                整体 {{ delta(inputScale, 1) }}
              </button>
              <span v-else-if="g.id === 'in'" class="dim">—</span>
            </td>
          </tr>
          <tr v-for="row in g.rows" :key="g.id + row.key" :class="{ edited: changed(row.key) }">
            <td class="left">
              <span class="tag" :style="tagStyle(row.ticker)"
                    :title="categoryLabel(data.categories[row.ticker])">{{ row.ticker }}</span>
            </td>
            <td>{{ num(row.amount, 2) }}</td>
            <td class="dim">{{ market(row.key) == null ? "暂无价格" : price(market(row.key)) }}</td>
            <td>
              <input v-model.number="prices[row.key]" type="number" min="0" step="any" class="price" />
              <span class="pct">{{ changed(row.key) ? delta(priceOf(row.key), market(row.key) ?? 0) : "" }}</span>
            </td>
            <td :class="row.sign > 0 ? 'long' : ''">{{ num(row.sign * row.amount * priceOf(row.key)) }}</td>
            <td v-if="gap != null">
              <button v-if="solved(row) != null" @click="apply(row)">{{ price(solved(row)) }}</button>
              <span v-else class="dim">—</span>
              <span class="pct">{{ solved(row) != null ? delta(solved(row)!, priceOf(row.key)) : "" }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="recipe.build_unpriced.length" class="warn">
        建造成本未计入暂无价格的 {{ recipe.build_unpriced.join("、") }}。
      </p>
    </section>
  </div>

  <details v-if="data" class="notes">
    <summary>数据口径</summary>
    <ul>
      <li>按一座建筑、效率 100% 计算；面积只含这座生产建筑，不含住房。</li>
      <li>工人消耗按建筑满员、必需品与两种奢侈品全部供应计。</li>
      <li>建造成本为建筑建材按买入口径的合计，不含星球环境附加建材；回本天数 = 建造成本 ÷ 日利润。</li>
      <li>买一价、卖一价、均价取自 FIO 当前行情；7 日、30 日均价与全服均价取自 PRUNplanner 的成交额加权均价。</li>
      <li>「达到目标的价格」每一格都只改该行、其余价格保持当前的计算价；点击即写入计算价。「整体」为配方投入全部按同一比例调价。</li>
      <li>日成交量为卖出交易所近 7 日的日均成交量。</li>
      <li>不含手续费与运输成本。</li>
    </ul>
  </details>
</template>

<style scoped>
h3 { font-size: 14px; color: #9db4d0; margin: 0 0 8px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 1300px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.scroll { overflow-x: auto; }
.bar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
table { width: 100%; font-size: 13px; }
th { text-align: left; color: #9db4d0; font-weight: normal; white-space: nowrap; }
th.num { text-align: right; }
td { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.left { text-align: left; }
.row { cursor: pointer; }
.row:hover td { background: #232733; }
.picked td { background: #2c3140; }
.group td { text-align: left; color: #9db4d0; background: #1e2128; font-size: 12px; }
.group td:last-child:not(:first-child) { text-align: right; }
.edited td { background: #2b2a20; }
.tag { display: inline-block; min-width: 42px; text-align: center; padding: 1px 6px;
       border-radius: 3px; font-size: 12px; font-weight: 600; }
.price { width: 90px; text-align: right; }
.pct { display: inline-block; width: 56px; font-size: 11px; color: #c9b06a; }
.long { color: #7fb37f; }
.short { color: #e07a5f; }
.metrics { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 12px 0 16px; }
.metrics dt { font-size: 11px; color: #8a8f99; margin-bottom: 2px; }
.metrics dd { margin: 0; font-size: 13px; font-variant-numeric: tabular-nums; }
.metrics .main dd:not(.was) { font-size: 20px; }
.metrics dd.was { font-size: 11px; color: #8a8f99; }
.notes { margin-top: 24px; color: #8a8f99; font-size: 12px; max-width: 760px; }
.notes summary { cursor: pointer; color: #9db4d0; }
.notes ul { margin: 6px 0; padding-left: 20px; }
.dim { color: #8a8f99; }
.err { color: #e66; }
.warn { color: #c9b06a; }
label { display: inline-flex; gap: 6px; align-items: center; }
input, select, button { background: #23262e; color: #eee; border: 1px solid #444; padding: 3px 6px; }
td button { cursor: pointer; font-variant-numeric: tabular-nums; }
</style>
