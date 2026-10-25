<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { errorText } from "../api/client";
import { categoryColor, categoryLabel, categoryTextColor } from "../api/materials";
import * as arbitrage from "../services/arbitrage";
import type {
  ArbitrageBook, ArbitrageOpportunity, ArbitrageResult, ArbitrageSell,
  BookLevel, ExchangeCode, QuoteSource,
} from "../api/types";

const CURRENCY: Partial<Record<ExchangeCode, string>> = {
  AI1: "AIC", CI1: "CIS", IC1: "ICA", NC1: "NCC",
};

const sell = ref<ArbitrageSell>("bid");
const source = ref<QuoteSource>("FIO");
const result = ref<ArbitrageResult | null>(null);
const search = ref("");
const sameCurrency = ref(false);
const minMargin = ref(5);
const minTraded = ref(1);
const excluded = ref<ExchangeCode[]>([]);
const picked = ref<ArbitrageOpportunity | null>(null);
const book = ref<ArbitrageBook | null>(null);
const bookBusy = ref(false);
const amount = ref<number | null>(null);
const error = ref("");
const busy = ref(false);

onMounted(() => load());
watch([sell, source], () => load());

async function load(force = false) {
  busy.value = true;
  error.value = "";
  picked.value = null;
  book.value = null;
  try {
    result.value = await arbitrage.opportunities(source.value, sell.value, force);
  } catch (e) {
    result.value = null;
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

// ---- 表格列与排序 ----

type Row = ArbitrageOpportunity;
interface Column {
  key: string;
  label: string;
  value?: (o: Row) => number | string;
  left?: boolean;
}

const columns = computed<Column[]>(() => {
  const cols: Column[] = [
    { key: "ticker", label: "材料", value: (o) => o.ticker, left: true },
    { key: "buy_exchange", label: "买入", value: (o) => o.buy_exchange, left: true },
    { key: "buy_price", label: "卖一价", value: (o) => o.buy_price },
    { key: "sell_exchange", label: "卖出", value: (o) => o.sell_exchange, left: true },
    { key: "sell_price", label: sell.value === "bid" ? "买一价" : "日均价", value: (o) => o.sell_price },
  ];
  if (sell.value === "avg") {
    cols.push({ key: "daily_traded", label: "日成交", value: (o) => o.daily_traded ?? 0 });
  }
  cols.push(
    { key: "spread", label: "价差", value: (o) => o.spread },
    { key: "margin", label: "利润率", value: (o) => o.margin },
    { key: "quantity", label: "可套利数量",
      value: (o) => (o.unlimited ? Infinity : o.quantity ?? 0) },
    { key: "cost", label: "所需资金",
      value: (o) => (o.unlimited ? Infinity : o.cost ?? 0) },
    { key: "weight", label: "重量 t",
      value: (o) => (o.unlimited ? Infinity : o.weight ?? 0) },
    { key: "volume", label: "体积 m³",
      value: (o) => (o.unlimited ? Infinity : o.volume ?? 0) },
    { key: "profit", label: "可套利利润",
      value: (o) => (o.unlimited ? Infinity : o.profit ?? 0) },
    { key: "currency", label: "币种", left: true },
  );
  return cols;
});

const sortKey = ref("margin");
const sortDesc = ref(true);

function sortBy(col: Column) {
  if (!col.value) return;
  if (sortKey.value === col.key) {
    sortDesc.value = !sortDesc.value;
  } else {
    sortKey.value = col.key;
    sortDesc.value = !col.left;     // 数字列先从大到小，文字列先按字母
  }
}

const rows = computed(() => {
  const term = search.value.trim().toUpperCase();
  const floor = (minMargin.value || 0) / 100;
  const list = (result.value?.opportunities ?? []).filter((o) =>
    (!term || o.ticker.includes(term)) &&
    o.margin >= floor &&
    (!sameCurrency.value || o.same_currency) &&
    !excluded.value.includes(o.buy_exchange) && !excluded.value.includes(o.sell_exchange) &&
    (sell.value !== "avg" || (o.daily_traded ?? 0) >= (minTraded.value || 0)));
  const col = columns.value.find((c) => c.key === sortKey.value) ?? columns.value[0];
  const get = col.value!;
  const sign = sortDesc.value ? -1 : 1;
  return [...list].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x === y) return 0;    // 两个都是 Infinity（不限量）时相减得 NaN
    return sign * (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number));
  }).slice(0, 300);
});

watch(columns, (cols) => {
  if (!cols.some((c) => c.key === sortKey.value)) { sortKey.value = "margin"; sortDesc.value = true; }
});

// ---- 挂单簿明细 ----

async function openBook(o: Row) {
  picked.value = o;
  book.value = null;
  amount.value = o.quantity ? Math.round(o.quantity) : null;
  bookBusy.value = true;
  try {
    book.value = await arbitrage.book(o.ticker, o.buy_exchange, o.sell_exchange);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    bookBusy.value = false;
  }
}

interface Fill { filled: number; value: number; used: number[]; last: number | null }

/** 从第一档起按顺序吃 qty 个；used[i] 是第 i 档吃掉的数量 */
function fill(levels: BookLevel[], qty: number): Fill {
  let left = qty, value = 0;
  let last: number | null = null;
  const used = levels.map((lv) => {
    const take = Math.max(0, Math.min(left, lv.count ?? Infinity));
    left -= take;
    value += take * lv.price;
    if (take > 0) last = lv.price;
    return take;
  });
  return { filled: qty - left, value, used, last };
}

const sim = computed(() => {
  if (!book.value || !picked.value || !amount.value || amount.value <= 0) return null;
  const buying = fill(book.value.asks, amount.value);
  if (sell.value === "avg") {
    const filled = buying.filled;
    const revenue = filled * picked.value.sell_price;
    return { buying, selling: null, filled, cost: buying.value, revenue, profit: revenue - buying.value };
  }
  const selling = fill(book.value.bids, amount.value);
  const filled = Math.min(buying.filled, selling.filled);
  // 两边吃到的量不一样时按少的那边重算，免得花费和收入对不上数量
  const b = filled < buying.filled ? fill(book.value.asks, filled) : buying;
  const s = filled < selling.filled ? fill(book.value.bids, filled) : selling;
  return { buying: b, selling: s, filled, cost: b.value, revenue: s.value, profit: s.value - b.value };
});

/** 单个的重量体积：由表格里的总量反推（按 quantity × 单重给出） */
const unit = computed(() => {
  const o = picked.value;
  if (!o?.quantity || o.weight == null || o.volume == null) return null;
  return { weight: o.weight / o.quantity, volume: o.volume / o.quantity };
});

function cumulative(levels: BookLevel[]): (number | null)[] {
  let total: number | null = 0;
  return levels.map((lv) => (total = total == null || lv.count == null ? null : total + lv.count));
}

// ---- 格式 ----

function toggleExchange(code: ExchangeCode) {
  excluded.value = excluded.value.includes(code)
    ? excluded.value.filter((c) => c !== code)
    : [...excluded.value, code];
}

function num(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function price(value: number | null | undefined): string {
  return value == null ? "—" : num(value, value < 100 ? 2 : 1);
}

function currencies(o: Row): string {
  const from = CURRENCY[o.buy_exchange];
  const to = CURRENCY[o.sell_exchange];
  return from === to ? `${from}` : `${from} → ${to}`;
}

function cell(o: Row, key: string): string {
  switch (key) {
    case "buy_price": return price(o.buy_price);
    case "sell_price": return price(o.sell_price);
    case "daily_traded": return num(o.daily_traded);
    case "spread": return price(o.spread);
    case "margin": return `${(o.margin * 100).toFixed(1)}%`;
    case "quantity": return o.unlimited ? `${num(o.quantity)}+` : num(o.quantity);
    case "cost": return o.unlimited ? `${num(o.cost)}+` : num(o.cost);
    case "weight": return o.unlimited ? `${num(o.weight, 1)}+` : num(o.weight, 1);
    case "volume": return o.unlimited ? `${num(o.volume, 1)}+` : num(o.volume, 1);
    case "profit": return o.unlimited ? `${num(o.profit)}+` : num(o.profit);
    case "currency": return currencies(o);
    default: return String((o as unknown as Record<string, unknown>)[key] ?? "");
  }
}

const CELL_CLASS: Record<string, string> = {
  daily_traded: "dim", weight: "dim", volume: "dim", spread: "long", margin: "long", quantity: "", profit: "long",
};
</script>

<template>
  <h2>套利</h2>
  <p v-if="error" class="err">{{ error }}</p>

  <div class="bar tabs">
    <button :class="{ on: sell === 'bid' }" @click="sell = 'bid'">买一价 / 卖一价</button>
    <button :class="{ on: sell === 'avg' }" @click="sell = 'avg'">日均价</button>
  </div>

  <div class="bar">
    <label>
      行情
      <select v-model="source" :disabled="busy">
        <option value="FIO">FIO</option>
        <option value="PRUNPLANNER">PRUNplanner</option>
      </select>
    </label>
    <button :disabled="busy" @click="load(true)">刷新行情</button>
    <span v-if="busy" class="dim">读取中…</span>
  </div>

  <div class="bar">
    <label>材料 <input v-model="search" placeholder="如 RAT" style="width:90px" /></label>
    <label>最低利润率 <input v-model.number="minMargin" type="number" min="0" style="width:60px" /> %</label>
    <label v-if="sell === 'avg'">
      日成交至少 <input v-model.number="minTraded" type="number" min="0" style="width:70px" />
    </label>
    <label><input v-model="sameCurrency" type="checkbox" /> 只看同币种</label>
    <span class="exchanges">
      <label v-for="code in result?.exchanges ?? []" :key="code">
        <input type="checkbox" :checked="!excluded.includes(code)" @change="toggleExchange(code)" />
        {{ code }}
      </label>
    </span>
  </div>

  <p v-for="w in result?.warnings ?? []" :key="w" class="warn">{{ w }}</p>

  <div v-if="result" class="cols">
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th v-for="c in columns" :key="c.key" :class="{ num: !c.left, sortable: !!c.value }"
                @click="sortBy(c)">
              {{ c.label }}<span v-if="sortKey === c.key" class="arrow">{{ sortDesc ? "▼" : "▲" }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in rows" :key="`${o.ticker}.${o.buy_exchange}.${o.sell_exchange}`"
              :class="['row', { picked: picked === o }]" @click="openBook(o)">
            <template v-for="c in columns" :key="c.key">
              <td v-if="c.key === 'ticker'">
                <span class="tag" :style="{ background: categoryColor(o.category),
                                            color: categoryTextColor(o.category) }"
                      :title="categoryLabel(o.category)">{{ o.ticker }}</span>
              </td>
              <td v-else :class="[c.left ? 'left' : '', CELL_CLASS[c.key] ?? '',
                                  { cross: c.key === 'currency' && !o.same_currency }]">
                {{ cell(o, c.key) }}
              </td>
            </template>
          </tr>
          <tr v-if="!rows.length"><td :colspan="columns.length" class="dim">没有符合条件的价差</td></tr>
        </tbody>
      </table>
      <p v-if="rows.length === 300" class="dim">只列出前 300 条，缩小范围可看到其余的。</p>
    </div>

    <div>
      <p v-if="bookBusy" class="dim">读取挂单簿…</p>
      <p v-else-if="!picked" class="dim">选择一行查看挂单簿。</p>
      <template v-else-if="book">
        <h3>
          <span class="tag" :style="{ background: categoryColor(picked.category),
                                      color: categoryTextColor(picked.category) }">
            {{ book.ticker }}</span>
          {{ book.buy_exchange }} → {{ book.sell_exchange }}
        </h3>

        <label>数量 <input v-model.number="amount" type="number" min="0" style="width:100px" /></label>

        <dl v-if="sim" class="metrics">
          <div><dt>成交数量</dt><dd>{{ num(sim.filled) }}</dd></div>
          <div><dt>买入均价</dt><dd>{{ price(sim.filled ? sim.cost / sim.filled : null) }}</dd></div>
          <div>
            <dt>{{ sell === "bid" ? "卖出均价" : "日均价" }}</dt>
            <dd>{{ price(sim.filled ? sim.revenue / sim.filled : null) }}</dd>
          </div>
          <div><dt>花费</dt><dd>{{ num(sim.cost) }}</dd></div>
          <template v-if="unit">
            <div><dt>重量</dt><dd>{{ num(sim.filled * unit.weight, 1) }} t</dd></div>
            <div><dt>体积</dt><dd>{{ num(sim.filled * unit.volume, 1) }} m³</dd></div>
          </template>
          <div><dt>收入</dt><dd>{{ num(sim.revenue) }}</dd></div>
          <div><dt>利润</dt><dd :class="sim.profit >= 0 ? 'long' : 'short'">{{ num(sim.profit) }}</dd></div>
        </dl>

        <div class="ladders">
          <table class="mini">
            <caption>{{ book.buy_exchange }} 卖单</caption>
            <thead><tr><th>档</th><th class="num">价格</th><th class="num">数量</th><th class="num">累计</th></tr></thead>
            <tbody>
              <tr v-for="(lv, i) in book.asks" :key="lv.price"
                  :class="{ used: sim && sim.buying.used[i] > 0 }">
                <td>卖{{ i + 1 }}</td>
                <td>{{ price(lv.price) }}</td>
                <td>{{ lv.count == null ? "不限" : num(lv.count) }}</td>
                <td class="dim">{{ num(cumulative(book.asks)[i]) }}</td>
              </tr>
              <tr v-if="!book.asks.length"><td colspan="4" class="dim">没有卖单</td></tr>
            </tbody>
          </table>
          <table v-if="sell === 'bid'" class="mini">
            <caption>{{ book.sell_exchange }} 买单</caption>
            <thead><tr><th>档</th><th class="num">价格</th><th class="num">数量</th><th class="num">累计</th></tr></thead>
            <tbody>
              <tr v-for="(lv, i) in book.bids" :key="lv.price"
                  :class="{ used: sim?.selling && sim.selling.used[i] > 0 }">
                <td>买{{ i + 1 }}</td>
                <td>{{ price(lv.price) }}</td>
                <td>{{ lv.count == null ? "不限" : num(lv.count) }}</td>
                <td class="dim">{{ num(cumulative(book.bids)[i]) }}</td>
              </tr>
              <tr v-if="!book.bids.length"><td colspan="4" class="dim">没有买单</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="!picked.same_currency" class="dim">
          {{ CURRENCY[book.buy_exchange] }} 与 {{ CURRENCY[book.sell_exchange] }} 按 1:1 计，未含换汇。
        </p>
      </template>
    </div>
  </div>

  <details class="notes">
    <summary>数据口径</summary>
    <ul>
      <li>日均价：FIO 为近 24 小时成交额 ÷ 成交量；PRUNplanner 为 UTC 当日已成交部分的加权均价。无成交的交易所不列出。</li>
      <li>可套利数量按 FIO 挂单簿逐档计算，到买入价不再低于卖出价为止；按日均价卖出时不超过对方交易所的日成交量。末尾带 + 表示碰到做市商单，数量不限。</li>
      <li>不同币种按 1:1 比较，不含换汇、手续费与运输成本。</li>
      <li>行情每 15 分钟更新一次；「刷新行情」最多每分钟向数据源取一次。</li>
    </ul>
  </details>
</template>

<style scoped>
h3 { font-size: 14px; color: #9db4d0; margin: 0 0 8px; }
.cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 1fr); gap: 24px; }
@media (max-width: 1200px) { .cols { grid-template-columns: minmax(0, 1fr); } .cols > :last-child { order: -1; } }
.scroll { overflow-x: auto; }
.bar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.exchanges { display: inline-flex; gap: 10px; }
table { width: 100%; font-size: 13px; }
th { text-align: left; color: #9db4d0; font-weight: normal; white-space: nowrap; }
th.num { text-align: right; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: #fff; }
.arrow { font-size: 10px; margin-left: 3px; }
td { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td:first-child, td.left { text-align: left; }
td.cross { color: #c9b06a; }
.row { cursor: pointer; }
.row:hover td { background: #232733; }
.picked td { background: #2c3140; }
.tag { display: inline-block; min-width: 42px; text-align: center; padding: 1px 6px;
       border-radius: 3px; font-size: 12px; font-weight: 600; }
.long { color: #7fb37f; }
.short { color: #e07a5f; }
.metrics { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 12px 0; }
.metrics dt { font-size: 11px; color: #8a8f99; margin-bottom: 2px; }
.metrics dd { margin: 0; font-size: 13px; font-variant-numeric: tabular-nums; }
.ladders { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
table.mini { font-size: 12px; }
caption { text-align: left; color: #9db4d0; padding-bottom: 4px; }
tr.used td { background: #23302a; }
.tabs button { background: #23262e; color: #9db4d0; border: 1px solid #444; padding: 4px 14px;
               cursor: pointer; }
.tabs button.on { background: #2c3140; color: #fff; }
.notes { margin-top: 24px; color: #8a8f99; font-size: 12px; max-width: 760px; }
.notes summary { cursor: pointer; color: #9db4d0; }
.notes ul { margin: 6px 0; padding-left: 20px; }
.dim { color: #8a8f99; }
.err { color: #e66; }
.warn { color: #c9b06a; }
label { display: inline-flex; gap: 6px; align-items: center; }
input, select, button { background: #23262e; color: #eee; border: 1px solid #444; padding: 3px 6px; }
</style>
