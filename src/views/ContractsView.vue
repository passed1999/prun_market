<script setup lang="ts">
/**
 * 合同生成：读入一份材料清单（任意 json），定价，写成 rprun 的 XIT ACT 包或 CONTD 的合同 json。
 * 两种输出的字段见 src/contracts/build.ts。
 */
import { computed, reactive, ref, watch } from "vue";

import { errorText } from "../api/client";
import { tickerStyle, useMaterialCategories } from "../api/materials";
import type { ExchangeCode } from "../api/types";
import {
  ACTION_TYPES, CONFIGURE, CURRENCIES, EXCHANGE_CURRENCY, MIN_PRICE,
  buildActPack, buildContract, contractPrice, newAction, readActPack,
  type ActionForm, type ActionType, type ContractType, type Line,
} from "../contracts/build";
import { ParseError, extractMaterials, mergeSources, type MaterialSource } from "../contracts/parse";
import { fio, pp } from "../data/sources";
import { useCatalog } from "../routes/catalog";
import { copyText, download, safeName, toText } from "../routes/io";
import { activeMaterials, newId } from "../routes/model";
import { workspace } from "../routes/store";
import { EXCHANGES } from "../services/prices";

type PriceMode = "min" | "fixed" | "file" | "cx";
type Basis = "ASK" | "BID" | "MID" | "AVG" | "PP7D";

interface Row { ticker: string; amount: number; filePrice: number | null; manual: number | null }

interface State {
  text: string;
  rows: Row[];
  output: "act" | "contract";
  priceMode: PriceMode;
  fixed: number;
  exchange: ExchangeCode;
  basis: Basis;
  /** 在交易所价上乘的百分比，100 = 原价 */
  percent: number;
  act: { name: string; groupName: string; groupType: "Manual" | "Paste"; actions: ActionForm[] };
  contract: {
    type: ContractType; currency: string; deadline: number; location: string;
    origin: string; destination: string; autoProvision: boolean;
    paymentMode: "total" | "perTon"; payment: number;
  };
}

const KEY = "prun-market.contracts";

function load(): State {
  const empty: State = {
    text: "", rows: [], output: "contract",
    priceMode: "cx", fixed: 100, exchange: "AI1", basis: "ASK", percent: 100,
    // 默认的两个动作与 PRUNplanner 导出的包一样：先在交易所买，再从仓库转到执行时选的地方
    act: {
      name: "contract", groupName: "A1", groupType: "Manual",
      actions: [
        { ...newAction("CX Buy", newId()), exchange: "AI1" },
        { ...newAction("MTRA", newId()), origin: "Antares Station Warehouse" },
      ],
    },
    contract: {
      type: "SELL", currency: "AIC", deadline: 3, location: "", origin: "", destination: "",
      autoProvision: false, paymentMode: "total", payment: 0,
    },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && Array.isArray(saved.rows)) {
      const act = { ...empty.act, ...saved.act };
      // 旧版本存下来的动作可能缺后来加的字段
      act.actions = (Array.isArray(act.actions) ? act.actions : []).map((a: ActionForm) => ({ ...newAction(a.type, a.id), ...a }));
      return { ...empty, ...saved, act, contract: { ...empty.contract, ...saved.contract } };
    }
  } catch { /* 存坏了：当作空的 */ }
  return empty;
}

const state = reactive<State>(load());
let saveTimer: ReturnType<typeof setTimeout> | undefined;
watch(state, () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 存不下就算了 */ }
  }, 300);
}, { deep: true });

const { materials: catalog, places } = useCatalog();
useMaterialCategories();

const message = ref("");
const messageBad = ref(false);
function say(text: string, bad = false) { message.value = text; messageBad.value = bad; }

// ---- 读入 ----

const sources = ref<MaterialSource[]>([]);
const chosen = ref<boolean[]>([]);
const workspaceGroup = ref("");

/** 读入的 ACT 包里 CX Buy 的限价，当作文件自带的价 */
let packLimits: Record<string, number> = {};

function applySources() {
  const picked = sources.value.filter((_, i) => chosen.value[i]);
  const merged = mergeSources(picked);
  state.rows = Object.entries(merged.materials).map(([ticker, amount]) => ({
    ticker, amount, filePrice: merged.prices[ticker] ?? packLimits[ticker] ?? null, manual: null,
  }));
  if (state.rows.some((r) => r.filePrice !== null)) state.priceMode = "file";
  else if (state.priceMode === "file") state.priceMode = "cx";
}

function readText(text: string, name?: string) {
  // 是 XIT ACT 包的话，连包名、组名和动作一起读回来
  let pack: ReturnType<typeof readActPack> = null;
  try { pack = readActPack(JSON.parse(text), newId); } catch { /* 下面会报不是合法的 JSON */ }
  packLimits = pack?.limits ?? {};
  if (pack) {
    state.act = { name: pack.name, groupName: pack.groupName, groupType: pack.groupType, actions: pack.actions };
    state.output = "act";
  }
  const packNote = pack ? `，并读回了 ACT 包「${pack.name}」的 ${pack.actions.length} 个动作` : "";
  try {
    sources.value = extractMaterials(text, name);
  } catch (e) {
    if (pack && e instanceof ParseError) {
      // 包里没有材料（比如只有 Paste 组或空的 Manual 组）：动作照样读回来，清单留着原来的
      sources.value = [];
      say(`这个包里没有材料清单，材料沿用现有的${packNote}。`);
      return;
    }
    say(e instanceof ParseError ? e.message : "读不了这段内容。", true);
    return;
  }
  chosen.value = sources.value.map(() => true);
  applySources();
  const n = sources.value.length;
  say((n > 1 ? `找到 ${n} 份材料清单，已全部合并，可以在下面取消勾选不要的` : `读入 ${state.rows.length} 种材料`) + `${packNote}。`);
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  state.text = await file.text();
  readText(state.text, file.name.replace(/\.json$/i, ""));
}

function onDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  file.text().then((text) => { state.text = text; readText(text, file.name.replace(/\.json$/i, "")); });
}

function useWorkspaceGroup() {
  const g = workspace.groups.find((x) => x.id === workspaceGroup.value);
  workspaceGroup.value = "";
  if (!g) return;
  sources.value = [{ name: g.name, materials: activeMaterials(g), prices: {} }];
  chosen.value = [true];
  applySources();
  say(`读入材料组「${g.name}」的 ${state.rows.length} 种材料。`);
}

function addRow() { state.rows.push({ ticker: "", amount: 1, filePrice: null, manual: null }); }

// ---- 定价 ----

interface Quote { ask?: number; bid?: number; avg?: number; pp7d?: number }
/** 交易所 → 材料 → 报价 */
const quotes = ref<Record<string, Record<string, Quote>>>({});
const quoteBusy = ref(false);
const quoteError = ref("");
let quotesLoaded = false;

async function loadQuotes(force = false) {
  if (quoteBusy.value) return;
  quoteBusy.value = true;
  quoteError.value = "";
  const [book, weekly] = await Promise.allSettled([fio.exchangeAll(force), pp.exchanges(force)]);
  const out: Record<string, Record<string, Quote>> = {};
  const at = (cx: string, t: string) => ((out[cx] ??= {})[t] ??= {});
  if (book.status === "fulfilled") {
    for (const r of book.value) {
      const q = at(r.ExchangeCode, r.MaterialTicker);
      if (r.Ask) q.ask = r.Ask;
      if (r.Bid) q.bid = r.Bid;
      if (r.PriceAverage) q.avg = r.PriceAverage;
    }
  }
  if (weekly.status === "fulfilled") {
    for (const r of weekly.value) if (r.vwap_7d) at(r.exchange_code, r.ticker).pp7d = r.vwap_7d;
  }
  const failed = [book, weekly].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) quoteError.value = errorText(failed.reason);
  quotes.value = out;
  quotesLoaded = !failed;
  quoteBusy.value = false;
}

watch(() => state.priceMode, (mode) => { if (mode === "cx" && !quotesLoaded) loadQuotes(); }, { immediate: true });
// 换交易所时币种跟着换，免得拿 AI1 的价配 NCC
watch(() => state.exchange, (cx) => {
  const currency = EXCHANGE_CURRENCY[cx];
  if (currency) state.contract.currency = currency;
});

const BASIS: { value: Basis; label: string }[] = [
  { value: "ASK", label: "卖一" },
  { value: "BID", label: "买一" },
  { value: "MID", label: "卖一买一中点" },
  { value: "AVG", label: "均价" },
  { value: "PP7D", label: "七日均价" },
];

function quotePrice(ticker: string): number | undefined {
  const q = quotes.value[state.exchange]?.[ticker];
  if (!q) return undefined;
  switch (state.basis) {
    case "ASK": return q.ask;
    case "BID": return q.bid;
    case "MID": return q.ask && q.bid ? (q.ask + q.bid) / 2 : undefined;
    case "AVG": return q.avg;
    default: return q.pp7d;
  }
}

function basePrice(row: Row): number | undefined {
  switch (state.priceMode) {
    case "min": return MIN_PRICE;
    case "fixed": return contractPrice(state.fixed);
    case "file": return contractPrice(row.filePrice);
    default: {
      const q = quotePrice(row.ticker);
      return q === undefined ? undefined : contractPrice(q * (Number(state.percent) || 100) / 100);
    }
  }
}

/** 一行最后用的单价：手填的优先 */
const priceOf = (row: Row) => contractPrice(row.manual) ?? basePrice(row);

const lines = computed<Line[]>(() => {
  const byTicker = new Map<string, Line>();
  for (const row of state.rows) {
    const ticker = row.ticker.trim().toUpperCase();
    const amount = Math.round(Number(row.amount));
    if (!ticker || !(amount > 0)) continue;
    const had = byTicker.get(ticker);
    if (had) had.amount += amount;
    else byTicker.set(ticker, { ticker, amount, price: priceOf({ ...row, ticker }) });
  }
  return [...byTicker.values()];
});

const known = computed(() => Object.keys(catalog.value).length > 0);
const unknown = computed(() => (known.value ? lines.value.filter((l) => !catalog.value[l.ticker]).map((l) => l.ticker) : []));

const totals = computed(() => {
  let value = 0, weight = 0, volume = 0, priced = 0;
  for (const l of lines.value) {
    if (l.price !== undefined) { value += l.price * l.amount; priced++; }
    const m = catalog.value[l.ticker];
    if (m) { weight += m.weight * l.amount; volume += m.volume * l.amount; }
  }
  return { value, weight, volume, priced };
});

function clearManual() { for (const r of state.rows) r.manual = null; }

// ---- 输出 ----

/** 交易所 → 「XX Station Warehouse」，MTRA 的起点用 */
const warehouses = ref<Record<string, string>>({});
fio.stations()
  .then((list) => { warehouses.value = Object.fromEntries(list.map((s) => [s.ComexCode, `${s.Name} Warehouse`])); })
  .catch(() => { /* 没有就手填 */ });

function addAction(type: ActionType) {
  const action = newAction(type, newId(), state.contract.currency);
  if (type === "MTRA") {
    // 前面有定了交易所的 CX Buy：货就在那个站的仓库里
    const buy = [...state.act.actions].reverse().find((a) => a.type === "CX Buy" && a.exchange !== CONFIGURE);
    if (buy && warehouses.value[buy.exchange]) action.origin = warehouses.value[buy.exchange];
  }
  state.act.actions.push(action);
  if (type === "CONT Trade") state.act.groupType = "Paste";
}

/** 游戏里的导入框是单行输入框，复制时给不带换行的一行 */
const compactText = computed(() => JSON.stringify(built.value.json));

const shipPayment = computed(() => (state.contract.paymentMode === "perTon"
  ? Math.round(totals.value.weight * (Number(state.contract.payment) || 0))
  : Math.round(Number(state.contract.payment) || 0)));

const built = computed(() => {
  if (state.output === "act") return buildActPack(lines.value, state.act);
  const c = state.contract;
  return buildContract(lines.value, { ...c, payment: shipPayment.value });
});

const outputText = computed(() => toText(built.value.json).trimEnd());
const warnings = computed(() => {
  const list = [...built.value.warnings];
  if (unknown.value.length) list.push(`不认识的材料代码：${unknown.value.join("、")}`);
  if (state.output === "contract" && state.contract.type === "SHIP" && state.contract.paymentMode === "perTon" && !known.value) {
    list.push("材料的重量还没拿到，按每吨算不出运费。");
  }
  return list;
});

async function copy(text: string, what: string) {
  say(await copyText(text) ? `${what}已复制。` : "浏览器不让写剪贴板，请手动选中复制。", false);
}

function save() {
  const name = state.output === "act" ? `act-${safeName(state.act.name)}` : `contract-${state.contract.type.toLowerCase()}`;
  download(`${name}.json`, built.value.json);
}

const placeNames = computed(() => {
  const names = new Set<string>();
  for (const p of places.value) if (p.name && p.name !== p.naturalId) names.add(p.name);
  return [...names].sort();
});

const fmt = (n: number, digits = 2) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
</script>

<template>
  <div>
    <h2>合同生成</h2>
    <p class="dim lead">
      读入一份材料清单，定价，写成 Refined PrUn 能直接导入的 json：<b>XIT ACT</b> 的动作包，或合同草稿（<b>CONTD</b>）的导入内容。
    </p>

    <div class="cols">
      <!-- 左：读入与清单 -->
      <section>
        <h3>1. 读入材料</h3>
        <textarea
          v-model="state.text" class="input" spellcheck="false" rows="6"
          placeholder='粘贴任意 json，或把文件拖到这里。例如 {"RAT": 300, "DW": 400}、材料组文件、XIT ACT 包、PRUNplanner 购物车、rprun 导出的合同 json …'
          @dragover.prevent @drop.prevent="onDrop"
        />
        <div class="bar">
          <button type="button" class="primary" :disabled="!state.text.trim()" @click="readText(state.text)">读入</button>
          <label class="file">选文件<input type="file" accept=".json,application/json" @change="onFile"></label>
          <select v-if="workspace.groups.length" v-model="workspaceGroup" @change="useWorkspaceGroup">
            <option value="">从路线编辑的材料组读入…</option>
            <option v-for="g in workspace.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <span :class="messageBad ? 'err' : 'dim'">{{ message }}</span>
        </div>
        <div v-if="sources.length > 1" class="sources">
          <label v-for="(s, i) in sources" :key="i">
            <input v-model="chosen[i]" type="checkbox" @change="applySources">
            {{ s.name }} <span class="dim">（{{ Object.keys(s.materials).length }} 种）</span>
          </label>
        </div>

        <h3>2. 定价</h3>
        <div class="bar">
          <select v-model="state.priceMode">
            <option value="cx">交易所价</option>
            <option value="min">最低价（{{ MIN_PRICE }}）</option>
            <option value="fixed">统一价</option>
            <option value="file" :disabled="!state.rows.some((r) => r.filePrice !== null)">读入的 json 里的价</option>
          </select>
          <template v-if="state.priceMode === 'cx'">
            <select v-model="state.exchange">
              <option v-for="cx in EXCHANGES" :key="cx" :value="cx">{{ cx }}</option>
            </select>
            <select v-model="state.basis">
              <option v-for="b in BASIS" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
            <label>× <input v-model.number="state.percent" type="number" min="1" step="1" class="short"> %</label>
            <button type="button" :disabled="quoteBusy" @click="loadQuotes(true)">{{ quoteBusy ? "取价中…" : "刷新行情" }}</button>
          </template>
          <label v-else-if="state.priceMode === 'fixed'">
            每件 <input v-model.number="state.fixed" type="number" min="0.01" step="0.01" class="price">
          </label>
          <button v-if="state.rows.some((r) => r.manual !== null)" type="button" @click="clearManual">清掉手填的价</button>
        </div>
        <p v-if="quoteError" class="err">{{ quoteError }}</p>

        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>材料</th><th class="num">数量</th><th class="num">单价</th><th class="num">手填单价</th>
                <th class="num">金额</th><th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in state.rows" :key="i" :class="{ edited: row.manual !== null }">
                <td class="left">
                  <input
                    v-model.trim="row.ticker" class="ticker" maxlength="4" spellcheck="false"
                    :style="catalog[row.ticker.toUpperCase()] ? tickerStyle(row.ticker.toUpperCase()) : {}"
                    @change="row.ticker = row.ticker.toUpperCase()"
                  >
                </td>
                <td><input v-model.number="row.amount" type="number" min="1" step="1" class="amount"></td>
                <td :class="{ warn: priceOf(row) === undefined }">
                  {{ priceOf(row) === undefined ? "无价" : fmt(priceOf(row)!) }}
                </td>
                <td><input v-model.number="row.manual" type="number" min="0.01" step="0.01" class="price" placeholder="—" @change="row.manual = row.manual || null"></td>
                <td>{{ priceOf(row) === undefined ? "—" : fmt(priceOf(row)! * (Number(row.amount) || 0)) }}</td>
                <td><button type="button" title="删掉这一行" @click="state.rows.splice(i, 1)">×</button></td>
              </tr>
              <tr v-if="!state.rows.length"><td colspan="6" class="left dim">还没有材料。读入一段 json，或者手动加行。</td></tr>
            </tbody>
          </table>
        </div>
        <div class="bar under">
          <button type="button" @click="addRow">＋ 加一行</button>
          <span class="dim">
            {{ lines.length }} 种 · 合计 {{ fmt(totals.value) }} {{ state.contract.currency }}
            <template v-if="totals.priced < lines.length">（{{ lines.length - totals.priced }} 种无价未计）</template>
            · {{ fmt(totals.weight) }} t · {{ fmt(totals.volume) }} m³
          </span>
        </div>
      </section>

      <!-- 右：输出 -->
      <section>
        <h3>3. 输出</h3>
        <div class="tabs">
          <button type="button" :class="{ on: state.output === 'contract' }" @click="state.output = 'contract'">合同 json（CONTD 导入）</button>
          <button type="button" :class="{ on: state.output === 'act' }" @click="state.output = 'act'">XIT ACT 包</button>
        </div>

        <!-- 合同 -->
        <div v-if="state.output === 'contract'" class="form">
          <label>类型
            <select v-model="state.contract.type">
              <option value="BUY">BUY 买入</option>
              <option value="SELL">SELL 卖出</option>
              <option value="SHIP">SHIP 运输</option>
            </select>
          </label>
          <label>币种
            <select v-model="state.contract.currency">
              <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label>期限（天）<input v-model.number="state.contract.deadline" type="number" min="1" max="99" step="1" class="short"></label>
          <template v-if="state.contract.type === 'SHIP'">
            <label>起点 <input v-model="state.contract.origin" list="contract-places" placeholder="如 Montem"></label>
            <label>终点 <input v-model="state.contract.destination" list="contract-places" placeholder="如 Moria Station"></label>
            <label>运费
              <select v-model="state.contract.paymentMode">
                <option value="total">总额</option>
                <option value="perTon">每吨</option>
              </select>
              <input v-model.number="state.contract.payment" type="number" min="0" step="1" class="price">
              <span v-if="state.contract.paymentMode === 'perTon'" class="dim">= {{ fmt(shipPayment, 0) }}</span>
            </label>
            <label><input v-model="state.contract.autoProvision" type="checkbox"> 自动备货（用起点的第一个仓库）</label>
          </template>
          <label v-else>地点 <input v-model="state.contract.location" list="contract-places" placeholder="如 Montem"></label>
        </div>

        <!-- ACT -->
        <div v-else>
          <div class="form">
            <label>包名 <input v-model="state.act.name" placeholder="contract"></label>
            <label>材料组名 <input v-model="state.act.groupName" placeholder="A1"></label>
            <label>材料组类型
              <select v-model="state.act.groupType">
                <option value="Manual">Manual（数量写在包里）</option>
                <option value="Paste">Paste（执行时粘贴，带单价）</option>
              </select>
            </label>
          </div>
          <div v-for="(a, i) in state.act.actions" :key="a.id" class="action">
            <div class="head">
              <b>{{ i + 1 }}. {{ a.type }}</b>
              <span>
                <button type="button" :disabled="i === 0" title="上移" @click="state.act.actions.splice(i - 1, 0, ...state.act.actions.splice(i, 1))">↑</button>
                <button type="button" title="删掉这个动作" @click="state.act.actions.splice(i, 1)">×</button>
              </span>
            </div>
            <div class="form">
              <template v-if="a.type === 'CX Buy'">
                <label>交易所
                  <select v-model="a.exchange">
                    <option :value="CONFIGURE">执行时再选</option>
                    <option v-for="cx in EXCHANGES" :key="cx" :value="cx">{{ cx }}</option>
                  </select>
                </label>
                <label><input v-model="a.useCXInv" type="checkbox"> 先扣掉交易所仓库里已有的</label>
                <label><input v-model="a.buyPartial" type="checkbox"> 挂单不够时只买现有的</label>
                <label><input v-model="a.allowUnfilled" type="checkbox"> 允许挂未成交的买单</label>
                <label :class="{ dim: state.act.groupType === 'Paste' }">
                  <input v-model="a.priceLimits" type="checkbox" :disabled="state.act.groupType === 'Paste'"> 把左边的单价当限价
                  <span v-if="state.act.groupType === 'Paste'">（Paste 组的单价本身就是限价）</span>
                </label>
              </template>
              <template v-else-if="a.type === 'MTRA'">
                <label>从 <input v-model="a.origin" list="contract-stores"></label>
                <label>到 <input v-model="a.dest" list="contract-stores"></label>
                <label><input v-model="a.noSfc" type="checkbox"> 装上船后不自动打开飞行控制（noSfc）</label>
                <span class="dim hint">写法：「Montem Base」「Moria Station Warehouse」「船名 Cargo」；两头要在同一个地点。</span>
              </template>
              <template v-else>
                <label v-if="a.type === 'CONT Trade'">方向
                  <select v-model="a.contTradeType">
                    <option value="BUYING">买入</option>
                    <option value="SELLING">卖出</option>
                  </select>
                </label>
                <label v-if="a.type === 'CONT Trade'">地点 <input v-model="a.contLocation" list="contract-locations"></label>
                <template v-else>
                  <label>起点 <input v-model="a.contOrigin" list="contract-locations"></label>
                  <label>终点 <input v-model="a.contDest" list="contract-locations"></label>
                  <label>每吨运费 <input v-model.number="a.paymentPerTon" type="number" min="0" step="1" class="price"></label>
                  <label><input v-model="a.autoProvision" type="checkbox"> 自动备货</label>
                </template>
                <label>币种
                  <select v-model="a.currency">
                    <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
                  </select>
                </label>
                <label>期限（天）<input v-model.number="a.daysToFulfill" type="number" min="1" max="99" step="1" class="short"></label>
              </template>
            </div>
          </div>
          <div class="bar">
            <span class="dim">加动作：</span>
            <button v-for="t in ACTION_TYPES" :key="t" type="button" @click="addAction(t)">＋ {{ t }}</button>
          </div>
        </div>

        <ul v-if="warnings.length" class="warnings">
          <li v-for="w in warnings" :key="w">{{ w }}</li>
        </ul>

        <div class="bar">
          <button type="button" class="primary" @click="copy(compactText, 'json ')">复制 json</button>
          <button type="button" @click="save">存成文件</button>
        </div>
        <textarea class="output" readonly spellcheck="false" :value="outputText" rows="16" />
        <template v-if="built.paste !== undefined">
          <div class="bar">
            <span class="dim">执行时粘贴进 Paste 组的内容（代码,数量,单价）：</span>
            <button type="button" @click="copy(built.paste!, '粘贴内容')">复制</button>
          </div>
          <textarea class="output" readonly spellcheck="false" :value="built.paste" rows="6" />
        </template>

        <details class="notes">
          <summary>怎么用</summary>
          <ul>
            <li><b>合同 json</b>：游戏里打开合同草稿（CONTD）→ 模板那一步的导入框选 JSON → 粘贴 → Import。
              需要 Refined PrUn 开着 <code>contd-import-export</code>。BUY / SELL 的单价是每件的价；SHIP 没有逐材料的价，只有运费总额。</li>
            <li><b>XIT ACT 包</b>：<code>XIT ACT</code> → Import → 粘贴。地点留「{{ CONFIGURE }}」就是执行时再选。</li>
            <li>ACT 的 Manual 组存不了价格。CONT Trade（买卖合同）要用 Paste 组：执行时把上面那段「代码,数量,单价」粘进去；
              rprun 规定这里的单价最多 3 位有效数字，所以会被取整。要精确到分就用合同 json。</li>
            <li>行情来自 FIO（卖一 / 买一 / 均价）和 PRUNplanner（七日成交额加权均价），有 15 分钟缓存。</li>
          </ul>
        </details>
      </section>
    </div>

    <datalist id="contract-places">
      <option v-for="n in placeNames" :key="n" :value="n" />
    </datalist>
    <datalist id="contract-locations">
      <option :value="CONFIGURE" />
      <option v-for="n in placeNames" :key="n" :value="n" />
    </datalist>
    <datalist id="contract-stores">
      <option :value="CONFIGURE" />
      <option v-for="w in warehouses" :key="w" :value="w" />
    </datalist>
  </div>
</template>

<style scoped>
h3 { font-size: 14px; color: #9db4d0; margin: 20px 0 8px; }
section > h3:first-child { margin-top: 0; }
.lead { margin: -8px 0 16px; font-size: 13px; max-width: 760px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 1200px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 8px 0; font-size: 13px; }
.bar.under { justify-content: space-between; }
.scroll { overflow-x: auto; }
table { width: 100%; font-size: 13px; }
th { text-align: left; color: #9db4d0; font-weight: normal; white-space: nowrap; }
th.num { text-align: right; }
td { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.left { text-align: left; }
.edited td { background: #2b2a20; }
textarea { width: 100%; background: #1b1d23; color: #e2e2e2; border: 1px solid #444; padding: 8px;
           font: 12px/1.5 ui-monospace, Consolas, monospace; resize: vertical; }
.output { color: #cfd8e3; }
input, select, button { background: #23262e; color: #eee; border: 1px solid #444; padding: 3px 6px; font: inherit; }
button { cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: #2f4a6b; border-color: #46689a; }
.ticker { width: 58px; text-align: center; font-weight: 600; text-transform: uppercase; }
.amount { width: 90px; text-align: right; }
.price { width: 96px; text-align: right; }
.short { width: 64px; text-align: right; }
.file { cursor: pointer; background: #23262e; border: 1px solid #444; padding: 3px 8px; }
.file input { display: none; }
.sources { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 8px; font-size: 13px; }
.tabs { display: flex; gap: 0; margin-bottom: 12px; }
.tabs button { padding: 6px 14px; border-radius: 0; }
.tabs button + button { border-left: 0; }
.tabs button.on { background: #2c3140; color: #fff; border-color: #5a6a86; }
.form { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; font-size: 13px; }
.form label { display: inline-flex; gap: 6px; align-items: center; }
.action { border: 1px solid #333; border-radius: 4px; padding: 8px 10px; margin-top: 10px; background: #1b1d23; }
.action .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; }
.action .head span { display: inline-flex; gap: 4px; }
.hint { flex-basis: 100%; font-size: 12px; }
.warnings { margin: 12px 0 4px; padding-left: 20px; color: #c9b06a; font-size: 13px; }
.notes { margin-top: 20px; color: #8a8f99; font-size: 12px; }
.notes summary { cursor: pointer; color: #9db4d0; }
.notes ul { margin: 6px 0; padding-left: 20px; line-height: 1.7; }
.notes code { color: #cfd8e3; }
.dim { color: #8a8f99; }
.err { color: #e66; }
.warn { color: #c9b06a; }
</style>
