<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { errorText } from "../api/client";
import { categoryColor, categoryLabel, categoryTextColor } from "../api/materials";
import * as chain from "../services/chain";
import { BUY, EXPERTISE_LABEL, EXTRACT, FACTIONS, FORM_LABEL, FULL_EFFICIENCY } from "../services/chain";
import { EXCHANGES } from "../services/prices";
import type { ChainNode, ChainRule, ChainSource, NodeSetting } from "../services/chain";
import type { ExchangeCode, PriceSource } from "../api/types";

const SOURCE_LABEL: Record<PriceSource, string> = {
  BID: "买一价", ASK: "卖一价", AVG: "均价", PP7D: "7 日均价", PP30D: "30 日均价", UNIVERSE: "全服均价",
};
const SOURCES = Object.keys(SOURCE_LABEL) as PriceSource[];
const LEVEL_LABEL: Record<string, string> = {
  PIONEER: "拓荒者", SETTLER: "定居者", TECHNICIAN: "技术员", ENGINEER: "工程师", SCIENTIST: "科学家",
};

// ---- 记在浏览器里的设置：价格口径、全局规则、每个产品上次的产线配置 ----

const STORE_KEY = "prun-market.chain.v1";
interface Pref { exchange: ExchangeCode; price_source: PriceSource }
/** 总部：派系（空 = 不加成）、等级、已建基地数（空 = 许可全部用完）*/
interface Hq { faction: string; level: number; bases: number | null }
interface Saved {
  buy: Pref; sell: Pref; last: string;
  /** 全局效率，百分数 */
  efficiency: number;
  hq: Hq;
  rules: Record<string, ChainRule>;
  chains: Record<string, { count: number; nodes: Record<string, NodeSetting> }>;
}
function loadSaved(): Saved {
  const fallback: Saved = {
    buy: { exchange: "NC1", price_source: "ASK" }, sell: { exchange: "NC1", price_source: "BID" },
    last: "", efficiency: 100, hq: { faction: "", level: 1, bases: null }, rules: {}, chains: {},
  };
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return fallback;
    const ok = (p: Pref | undefined) => p && EXCHANGES.includes(p.exchange) && SOURCES.includes(p.price_source);
    return {
      buy: ok(raw.buy) ? raw.buy : fallback.buy, sell: ok(raw.sell) ? raw.sell : fallback.sell,
      last: typeof raw.last === "string" ? raw.last : "",
      efficiency: typeof raw.efficiency === "number" && raw.efficiency > 0 ? raw.efficiency : 100,
      hq: raw.hq && typeof raw.hq === "object" && (raw.hq.faction === "" || raw.hq.faction in FACTIONS)
        ? { faction: raw.hq.faction, level: Number(raw.hq.level) || 1,
            bases: typeof raw.hq.bases === "number" ? raw.hq.bases : null }
        : fallback.hq,
      rules: raw.rules && typeof raw.rules === "object" ? raw.rules : {},
      chains: raw.chains && typeof raw.chains === "object" ? raw.chains : {},
    };
  } catch {
    return fallback;
  }
}
const saved = loadSaved();
const buy = reactive<Pref>(saved.buy);
const sell = reactive<Pref>(saved.sell);
const rules = reactive<Record<string, ChainRule>>(saved.rules);
/** 全局效率，百分数 */
const efficiency = ref(saved.efficiency);
const hq = reactive<Hq>(saved.hq);
const hqTotal = computed(() => chain.hqPermits(Number(hq.level)));
const hqBases = computed(() => typeof hq.bases === "number" && hq.bases >= 1 ? hq.bases : null);
const factors = computed(() => hq.faction ? chain.factionFactors(hq.faction, Number(hq.level), hqBases.value) : {});
const factorText = computed(() => Object.entries(factors.value)
  .map(([e, k]) => `${EXPERTISE_LABEL[e] ?? e} +${((k - 1) * 100).toFixed(1)}%`).join("，"));
const FULL_PCT = Math.round(FULL_EFFICIENCY * 1000) / 10;

const ticker = ref(saved.last);
/** 当前展开的产品；空 = 还没算 */
const root = ref("");
const count = ref(1);
const nodes = reactive<Record<string, NodeSetting>>({});

const data = shallowRef<chain.ChainData | null>(null);
const prices = shallowRef<chain.ChainPrices | null>(null);
const error = ref("");
const busy = ref(false);

watch([buy, sell, rules, root, count, nodes, efficiency, hq], () => {
  if (Number(efficiency.value) > 0) saved.efficiency = Number(efficiency.value);
  if (root.value) {
    saved.last = root.value;
    saved.chains[root.value] = { count: count.value, nodes: JSON.parse(JSON.stringify(nodes)) };
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...saved, buy, sell, rules, hq }));
  } catch { /* 隐私模式 */ }
}, { deep: true });

async function ensureData() {
  data.value ??= await chain.loadData();
  return data.value;
}

async function loadPrices() {
  const d = await ensureData();
  prices.value = await chain.loadPrices(d, {
    exchange: buy.exchange, price_source: buy.price_source,
    sell_exchange: sell.exchange, sell_price_source: sell.price_source,
  });
}

async function run(task: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await task();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

function load() {
  const wanted = ticker.value.trim().toUpperCase();
  if (!wanted) return;
  return run(async () => {
    const d = await ensureData();
    if (!d.tickers.includes(wanted)) {
      error.value = `没有 ${wanted} 这种材料。`;
      return;
    }
    if (!prices.value) await loadPrices();
    for (const key of Object.keys(nodes)) delete nodes[key];
    const before = saved.chains[wanted];
    Object.assign(nodes, JSON.parse(JSON.stringify(before?.nodes ?? {})));
    count.value = before?.count && before.count > 0 ? before.count : 1;
    ticker.value = wanted;
    root.value = wanted;
    await nextTick();
    focusRoot();
  });
}

function reprice() {
  if (data.value) run(loadPrices);
}

onMounted(() => {
  if (ticker.value) load();
  else run(async () => { await ensureData(); });
});

// ---- 计算 ----

const solved = computed(() => {
  if (!data.value || !prices.value || !root.value) return null;
  try {
    const result = chain.compute(data.value,
      { root: root.value, count: Number(count.value) || 0, efficiency: (Number(efficiency.value) || 100) / 100,
        factors: factors.value, nodes, rules }, prices.value);
    return { result, money: chain.summarize(data.value, result, prices.value), error: "" };
  } catch (e) {
    return { result: null, money: null, error: errorText(e) };
  }
});
const result = computed(() => solved.value?.result ?? null);
const money = computed(() => solved.value?.money ?? null);

// ---- 节点设置 ----

function setting(t: string): NodeSetting {
  return nodes[t] ??= {};
}

function setSource(node: ChainNode, id: string) {
  const s = setting(node.ticker);
  s.source = id;
  if (id === BUY) delete s.count;
}

function setCount(node: ChainNode, raw: string) {
  const v = raw.trim() === "" ? NaN : Number(raw);
  if (node.root) {
    if (Number.isFinite(v) && v >= 0) count.value = v;
    return;
  }
  const s = setting(node.ticker);
  // 手动填了座数，就把来源也钉住，免得换价格口径后默认配方变了
  if (Number.isFinite(v) && v >= 0) { s.count = v; s.source ??= node.sourceId; }
  else delete s.count;
}

function setPlanet(node: ChainNode, planet: string) {
  setting(node.ticker).planet = planet;
}

// ---- 全局规则 ----

const ruleInput = ref("");

function addRule(rule: ChainRule) {
  const known = new Set(data.value?.tickers ?? []);
  const list = ruleInput.value.toUpperCase().split(/[\s,，、;]+/).filter((t) => known.has(t));
  if (!list.length) return;
  for (const t of list) {
    rules[t] = rule;
    // 「全部设置」：节点上单独选过的来源让位给规则
    if (nodes[t]) { delete nodes[t].source; delete nodes[t].count; }
  }
  ruleInput.value = "";
}

function removeRule(t: string) {
  delete rules[t];
}

const ruleList = computed(() => Object.entries(rules).sort((a, b) => a[0].localeCompare(b[0])));
const hasNodeSettings = computed(() => Object.values(nodes).some((s) => Object.keys(s).length));

function clearNodes() {
  for (const key of Object.keys(nodes)) delete nodes[key];
}

/** 把图上现在所有非最终产品的节点一次设成买入 / 自产 */
function setAll(rule: ChainRule) {
  for (const node of result.value?.nodes ?? []) {
    if (node.root || !node.options.length) continue;
    const s = setting(node.ticker);
    delete s.count;
    if (rule === "buy") s.source = BUY;
    else if (node.sourceId === BUY) {
      s.source = (node.options.find((o) => o.id !== EXTRACT) ?? node.options[0]).id;
    }
  }
}

// ---- 布局：按离最终产品的层数分列，最终产品在最右 ----

const W = 232, H = 132, GX = 64, GY = 14, PAD = 12;

const layout = computed(() => {
  const r = result.value;
  if (!r) return null;
  const maxDepth = Math.max(...r.nodes.map((n) => n.depth));
  const layers: ChainNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of r.nodes) layers[n.depth].push(n);
  const consumers = new Map<string, string[]>();
  for (const e of r.edges) {
    if (!consumers.has(e.from)) consumers.set(e.from, []);
    consumers.get(e.from)!.push(e.to);
  }
  const tall = Math.max(...layers.map((l) => l.length));
  const height = tall * H + (tall - 1) * GY;
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, d) => {
    // 尽量排在自己下游的旁边，少交叉
    const rank = (n: ChainNode) => {
      const ys = (consumers.get(n.ticker) ?? []).map((t) => pos.get(t)?.y).filter((y): y is number => y != null);
      return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : 0;
    };
    const ranked = layer.map((n) => ({ n, r: rank(n) })).sort((a, b) => a.r - b.r || a.n.ticker.localeCompare(b.n.ticker));
    const top = (height - (ranked.length * H + (ranked.length - 1) * GY)) / 2;
    ranked.forEach(({ n }, i) => {
      pos.set(n.ticker, { x: PAD + (maxDepth - d) * (W + GX), y: PAD + top + i * (H + GY) });
    });
  });
  const edges = r.edges.flatMap((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return [];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    return [{
      ...e, key: `${e.from}>${e.to}`,
      d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
      lx: x2 - 8, ly: y2 - 5,
    }];
  });
  return {
    cards: r.nodes.map((n) => ({ node: n, ...pos.get(n.ticker)! })),
    edges,
    width: PAD * 2 + (maxDepth + 1) * W + maxDepth * GX,
    height: PAD * 2 + height,
  };
});

const hover = ref("");
const canvas = ref<HTMLElement | null>(null);

function focusRoot() {
  const el = canvas.value;
  if (!el) return;
  el.scrollLeft = el.scrollWidth;
  el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
}

// ---- 格式 ----

function num(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function qty(value: number): string {
  return num(value, value < 10 ? 2 : value < 1000 ? 1 : 0);
}

function price(value: number | null | undefined): string {
  return value == null ? "暂无价格" : num(value, Math.abs(value) < 100 ? 2 : 1);
}

function tagStyle(t: string) {
  const c = data.value?.category[t];
  return { background: categoryColor(c), color: categoryTextColor(c) };
}

/** `FP:1xALG-1xGRN=>10xRAT` → `FP · 1 ALG + 1 GRN → 10 RAT` */
function sourceLabel(s: ChainSource): string {
  if (s.id === EXTRACT) return `采集 · ${s.building}`;
  const body = s.id.slice(s.id.indexOf(":") + 1);
  const side = (x: string) => x.split("-").filter(Boolean).map((p) => p.replace("x", " ")).join(" + ");
  const [left, right] = body.split("=>");
  return `${s.building} · ${side(left) || "—"} → ${side(right ?? "")}`;
}

function planetLabel(planet: string): string {
  const name = data.value?.planetNames[planet];
  return name && name !== planet ? `${name} (${planet})` : planet;
}

function sitesOf(t: string) {
  return data.value?.sites[t] ?? [];
}

function nodeNote(n: ChainNode): string {
  if (!n.source) return `买入 ${qty(n.demand)}/日`;
  if (n.root) return `日产 ${qty(n.made)}`;
  if (n.bought > 1e-9) return `自产 ${qty(n.made)} · 买入 ${qty(n.bought)}`;
  if (n.surplus > 1e-9) return `自产 ${qty(n.made)} · 富余 ${qty(n.surplus)}`;
  return `自产 ${qty(n.made)}/日`;
}
</script>

<template>
  <h2>产线</h2>
  <p v-if="error || solved?.error" class="err">{{ error || solved?.error }}</p>

  <form class="bar" @submit.prevent="load()">
    <label>
      产品
      <input v-model="ticker" list="chain-tickers" placeholder="如 RAT" style="width:90px" />
      <datalist id="chain-tickers"><option v-for="t in data?.tickers ?? []" :key="t" :value="t" /></datalist>
    </label>
    <button type="submit" :disabled="busy || !ticker.trim()">展开产线</button>
    <label>
      最终建筑
      <input v-model.number="count" type="number" min="0" step="1" style="width:64px" /> 座
    </label>
    <span class="group">
      <label title="每座建筑每天的投入与产出都乘这个系数；面积与工人消耗不变">
        效率
        <input v-model.number="efficiency" type="number" min="1" step="any" style="width:68px" /> %
      </label>
      <button type="button" :class="{ on: efficiency === 100 }" @click="efficiency = 100">基础 100%</button>
      <button type="button" :class="{ on: efficiency === FULL_PCT }" title="CoGC ×1.25，5 名专家 ×1.284"
              @click="efficiency = FULL_PCT">CoGC + 满专家 {{ FULL_PCT }}%</button>
    </span>
    <span class="group">
      <label title="总部所在星域的派系，给对应专业的建筑加效率，与上面的效率相乘">
        总部派系
        <select v-model="hq.faction">
          <option value="">不加成</option>
          <option v-for="(f, id) in FACTIONS" :key="id" :value="id">{{ f.label }}</option>
        </select>
      </label>
      <template v-if="hq.faction">
        <label>等级 <input v-model.number="hq.level" type="number" min="1" max="50" step="1" style="width:54px" /></label>
        <label :title="`总部 ${hq.level} 级共 ${hqTotal} 个基地许可；基地越少加成越高。留空 = 许可全部用完`">
          基地数
          <input v-model.number="hq.bases" type="number" min="1" :max="hqTotal" step="1" :placeholder="String(hqTotal)"
                 style="width:54px" /> / {{ hqTotal }}
        </label>
        <span class="dim">{{ factorText }}</span>
      </template>
    </span>
    <label>
      卖出
      <select v-model="sell.exchange" @change="reprice()">
        <option v-for="c in EXCHANGES" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="sell.price_source" @change="reprice()">
        <option v-for="s in SOURCES" :key="s" :value="s">{{ SOURCE_LABEL[s] }}</option>
      </select>
    </label>
    <label>
      买入
      <select v-model="buy.exchange" @change="reprice()">
        <option v-for="c in EXCHANGES" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="buy.price_source" @change="reprice()">
        <option v-for="s in SOURCES" :key="s" :value="s">{{ SOURCE_LABEL[s] }}</option>
      </select>
    </label>
    <span v-if="busy" class="dim">读取中…</span>
  </form>

  <div class="bar rules">
    <label>
      批量设置
      <input v-model="ruleInput" list="chain-tickers" placeholder="材料，可多个：H2O PE" style="width:190px"
             @keydown.enter.prevent="addRule('buy')" />
    </label>
    <button :disabled="!ruleInput.trim()" @click="addRule('buy')">全部买入</button>
    <button :disabled="!ruleInput.trim()" @click="addRule('make')">全部自产</button>
    <span v-for="[t, rule] in ruleList" :key="t" class="chip" :title="`所有产线里的 ${t} 都${rule === 'buy' ? '买入' : '自产'}`">
      <span class="tag" :style="tagStyle(t)">{{ t }}</span>
      {{ rule === "buy" ? "买入" : "自产" }}
      <button class="x" title="移除这条规则" @click="removeRule(t)">×</button>
    </span>
    <span class="sep" />
    <button :disabled="!result" title="图上现在的所有中间品与原料都改成买入" @click="setAll('buy')">本产线全买入</button>
    <button :disabled="!result" title="图上现在买入的节点，有配方的都改成自产" @click="setAll('make')">本产线全自产</button>
    <button :disabled="!hasNodeSettings" title="清掉这条产线每个节点上单独做的选择" @click="clearNodes()">恢复默认</button>
  </div>

  <template v-if="result && money && layout && data">
    <dl class="metrics">
      <div class="main">
        <dt>每面积日利润</dt>
        <dd :class="money.profit >= 0 ? 'long' : 'short'">{{ num(money.per_area, 1) }}</dd>
      </div>
      <div><dt>日利润</dt><dd :class="money.profit >= 0 ? 'long' : 'short'">{{ num(money.profit) }}</dd></div>
      <div><dt>日收入</dt><dd>{{ num(money.revenue) }}</dd></div>
      <div><dt>日成本</dt><dd>{{ num(money.cost) }}</dd></div>
      <div :title="`生产 ${num(result.production_area, 1)} + 住房 ${num(result.housing_area, 1)}`">
        <dt>总面积（含住房）</dt>
        <dd>{{ num(result.area, 1) }} <span class="dim">= {{ num(result.production_area, 1) }} + {{ num(result.housing_area, 1) }}</span></dd>
      </div>
      <div><dt>建造成本</dt><dd>{{ num(money.build_cost) }}</dd></div>
      <div><dt>回本天数</dt><dd>{{ num(money.payback, 1) }}</dd></div>
      <div v-for="w in result.workers" :key="w.level">
        <dt>{{ LEVEL_LABEL[w.level] }}</dt><dd>{{ num(w.count) }}</dd>
      </div>
    </dl>
    <p v-if="result.unstable" class="warn">配方之间成环且收敛不了，下面的数字不可靠；把环上的某种材料改成买入。</p>

    <div ref="canvas" class="canvas">
      <div class="stage" :style="{ width: layout.width + 'px', height: layout.height + 'px' }">
        <svg :width="layout.width" :height="layout.height">
          <path v-for="e in layout.edges" :key="e.key" :d="e.d"
                :class="['edge', { hot: hover === e.from || hover === e.to }]" />
          <template v-for="e in layout.edges" :key="'t' + e.key">
            <text v-if="hover === e.from || hover === e.to" :x="e.lx" :y="e.ly" text-anchor="end" class="flow">
              {{ e.from }} {{ qty(e.amount) }}/日
            </text>
          </template>
        </svg>
        <div v-for="c in layout.cards" :key="c.node.ticker"
             :class="['card', { root: c.node.root, buy: !c.node.source, hot: hover === c.node.ticker }]"
             :style="{ left: c.x + 'px', top: c.y + 'px', width: W + 'px', height: H + 'px' }"
             @mouseenter="hover = c.node.ticker" @mouseleave="hover = ''">
          <div class="head">
            <span class="tag" :style="tagStyle(c.node.ticker)"
                  :title="categoryLabel(data.category[c.node.ticker])">{{ c.node.ticker }}</span>
            <span v-if="c.node.root" class="dim">最终产品</span>
            <span v-else class="dim">需求 {{ qty(c.node.demand) }}/日</span>
          </div>
          <select :value="c.node.sourceId" :title="c.node.source ? sourceLabel(c.node.source) : '买入'"
                  @change="setSource(c.node, ($event.target as HTMLSelectElement).value)">
            <option v-if="!c.node.root" :value="BUY">买入</option>
            <option v-for="o in c.node.options" :key="o.id" :value="o.id">{{ sourceLabel(o) }}</option>
          </select>
          <select v-if="c.node.site" :value="c.node.site.planet"
                  @change="setPlanet(c.node, ($event.target as HTMLSelectElement).value)">
            <option v-for="s in sitesOf(c.node.ticker)" :key="s.planet" :value="s.planet">
              {{ planetLabel(s.planet) }} · {{ FORM_LABEL[s.form] }} {{ (s.factor * 100).toFixed(1) }}%
            </option>
          </select>
          <div v-if="c.node.source" class="line">
            <input type="number" min="0" step="any" class="count"
                   :value="c.node.fixed ? c.node.buildings : ''" :placeholder="num(c.node.need, 2)"
                   :title="c.node.root ? '最终建筑座数' : '自产建筑座数；留空 = 刚好满足需求'"
                   @change="setCount(c.node, ($event.target as HTMLInputElement).value)" />
            <span>座 {{ c.node.source.building }}</span>
            <span v-if="!c.node.root && c.node.fixed" class="dim">需 {{ num(c.node.need, 2) }}</span>
          </div>
          <div :class="['note', { warn: c.node.source && c.node.bought > 1e-9 }]">{{ nodeNote(c.node) }}</div>
        </div>
      </div>
    </div>

    <div class="cols">
      <section class="scroll">
        <h3>每日输入（买入）</h3>
        <table>
          <thead>
            <tr><th>材料</th><th class="num">每日数量</th><th class="num">其中工人消耗</th>
                <th class="num">单价</th><th class="num">每日金额</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in money.inputs" :key="r.ticker">
              <td class="left"><span class="tag" :style="tagStyle(r.ticker)">{{ r.ticker }}</span></td>
              <td>{{ qty(r.amount) }}</td>
              <td class="dim">{{ r.workforce ? qty(r.workforce) : "" }}</td>
              <td :class="{ warn: r.price == null }">{{ price(r.price) }}</td>
              <td>{{ num(r.value) }}</td>
            </tr>
            <tr class="total"><td class="left" colspan="4">合计</td><td>{{ num(money.cost) }}</td></tr>
          </tbody>
        </table>
      </section>

      <section class="scroll">
        <h3>每日输出（卖出）</h3>
        <table>
          <thead>
            <tr><th>材料</th><th class="num">每日数量</th><th class="num">单价</th><th class="num">每日金额</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in money.outputs" :key="r.ticker">
              <td class="left"><span class="tag" :style="tagStyle(r.ticker)">{{ r.ticker }}</span></td>
              <td>{{ qty(r.amount) }}</td>
              <td :class="{ warn: r.price == null }">{{ price(r.price) }}</td>
              <td class="long">{{ num(r.value) }}</td>
            </tr>
            <tr class="total"><td class="left" colspan="3">合计</td><td>{{ num(money.revenue) }}</td></tr>
          </tbody>
        </table>

        <h3 style="margin-top:20px">建筑</h3>
        <table>
          <thead><tr><th>建筑</th><th class="num">座数</th><th class="num">面积</th><th>生产</th></tr></thead>
          <tbody>
            <tr v-for="b in result.buildings" :key="b.ticker">
              <td class="left">{{ b.ticker }}</td>
              <td>{{ num(b.count, 2) }}</td>
              <td>{{ num(b.area, 1) }}</td>
              <td class="left">
                <span v-for="t in b.makes" :key="t" class="tag small" :style="tagStyle(t)">{{ t }}</span>
              </td>
            </tr>
            <tr v-for="b in result.housing" :key="b.ticker">
              <td class="left">{{ b.ticker }}</td>
              <td>{{ num(b.count, 2) }}</td>
              <td>{{ num(b.area, 1) }}</td>
              <td class="left dim">住房</td>
            </tr>
            <tr class="total"><td class="left" colspan="2">合计</td><td>{{ num(result.area, 1) }}</td><td /></tr>
          </tbody>
        </table>
      </section>
    </div>
    <p v-if="money.unpriced.length" class="warn">
      {{ money.unpriced.join("、") }} 在所选口径下暂无价格，按 0 计入。
    </p>
    <p v-if="money.build_unpriced.length" class="warn">
      建造成本未计入暂无价格的 {{ money.build_unpriced.join("、") }}。
    </p>
  </template>

  <details class="notes">
    <summary>数据口径</summary>
    <ul>
      <li>每种材料在图上只有一个节点，多处用到的需求合在一起。节点来源可选买入、某条配方，或（星球上有的资源）在指定星球采集。</li>
      <li>默认：有配方的材料自产，配方取当前价格下单独看每面积日利润最高的一条；原矿买入。</li>
      <li>自产座数留空时刚好满足需求，可以是小数，面积与工人按小数座数折算；填了座数后，不够的部分买入，多出来的卖出。</li>
      <li>效率是全局系数：每座建筑每天的投入与产出（含采集）都乘它，面积、工人与工人消耗不变。「CoGC + 满专家」= 1.25 × 1.284；工人满意度按 100%，不含总部加成与农田肥力。</li>
      <li>总部派系加成只给对应专业的建筑，与效率相乘：1 + 基础加成 ×（3 − 2 × 基地数 ÷ 许可总数），许可总数 = 总部等级 + 1。基础加成：AI 电子 10%；CI 制造 10%；IC 农业 6%、食品 4%；NC 冶金 4%、建造 6%；无派系星域化工、燃料精炼、资源采集各 4%。</li>
      <li>采集日产量 = 星球浓度 × 70（EXT / RIG）或 × 60（COL），再乘效率。</li>
      <li>进出按整条产线的净额算：副产物先抵掉产线内部（含工人）对它的消耗，剩下的才卖。</li>
      <li>工人消耗按建筑满员、必需品与两种奢侈品全部供应计，一律算作买入。</li>
      <li>面积与建造成本含住房：按各级工人数配刚好够住的住房（座数可为小数），相邻两级能配对的用合住的 HBL / HBM / HBC / HBB（各住 75 + 75 人，人均占地更少），剩下的用单级 HB1–HB5（每座 100 人）。不含仓库与核心模块。</li>
      <li>建造成本不含星球环境附加建材；回本天数 = 建造成本 ÷ 日利润。</li>
      <li>价格口径与「面积利润」页相同：买一价、卖一价、均价取自 FIO 当前行情；7 日、30 日均价与全服均价取自 PRUNplanner。</li>
      <li>「批量设置」的规则对所有产品的产线生效；节点上单独选的来源优先于规则。设置都记在本浏览器里。</li>
      <li>不含手续费与运输成本。</li>
    </ul>
  </details>
</template>

<style scoped>
h3 { font-size: 14px; color: #9db4d0; margin: 0 0 8px; }
.bar { display: flex; gap: 8px 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.rules { gap: 8px; font-size: 13px; }
.sep { flex: 1; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 2px; background: #23262e;
        border: 1px solid #3a3f4b; border-radius: 4px; font-size: 12px; }
.chip .x { border: 0; background: none; color: #8a8f99; padding: 0 2px; cursor: pointer; font-size: 14px; line-height: 1; }
.chip .x:hover { color: #fff; }
.metrics { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 12px 0 16px; }
.metrics dt { font-size: 11px; color: #8a8f99; margin-bottom: 2px; }
.metrics dd { margin: 0; font-size: 13px; font-variant-numeric: tabular-nums; }
.metrics .main dd { font-size: 20px; }

.canvas { overflow: auto; max-height: 72vh; border: 1px solid #2c3140; border-radius: 6px; background: #121419;
          margin-bottom: 20px; }
.stage { position: relative; margin: 0 auto; }
.stage svg { position: absolute; inset: 0; pointer-events: none; }
.edge { fill: none; stroke: #3d4454; stroke-width: 1.5; }
.edge.hot { stroke: #9db4d0; stroke-width: 2; }
.flow { fill: #e2e2e2; font-size: 11px; paint-order: stroke; stroke: #121419; stroke-width: 4px; }
.card { position: absolute; display: flex; flex-direction: column; gap: 5px; padding: 8px;
        background: #1e2128; border: 1px solid #3a3f4b; border-radius: 6px; font-size: 12px; }
.card.hot { border-color: #9db4d0; z-index: 1; }
.card.root { border-color: #7fb37f; }
.card.buy { background: #1a1c22; border-style: dashed; }
.card .head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.card select { width: 100%; min-width: 0; font-size: 12px; }
.card .line { display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; }
.card .count { width: 70px; text-align: right; font-size: 12px; }
.card .note { margin-top: auto; color: #b8bcc6; font-variant-numeric: tabular-nums; white-space: nowrap;
              overflow: hidden; text-overflow: ellipsis; }

.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 1300px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.scroll { overflow-x: auto; }
table { width: 100%; font-size: 13px; }
th { text-align: left; color: #9db4d0; font-weight: normal; white-space: nowrap; }
th.num { text-align: right; }
td { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.left { text-align: left; }
.total td { background: #1e2128; color: #9db4d0; }
.tag { display: inline-block; min-width: 42px; text-align: center; padding: 1px 6px;
       border-radius: 3px; font-size: 12px; font-weight: 600; }
.tag.small { min-width: 0; margin-right: 4px; }
.long { color: #7fb37f; }
.short { color: #e07a5f; }
.dim { color: #8a8f99; }
.err { color: #e66; }
.warn { color: #c9b06a; }
.notes { margin-top: 24px; color: #8a8f99; font-size: 12px; max-width: 760px; }
.notes summary { cursor: pointer; color: #9db4d0; }
.notes ul { margin: 6px 0; padding-left: 20px; }
label { display: inline-flex; gap: 6px; align-items: center; }
input, select, button { background: #23262e; color: #eee; border: 1px solid #444; padding: 3px 6px; }
button:not(:disabled) { cursor: pointer; }
button:disabled { color: #777; }
button.on { border-color: #9db4d0; color: #fff; background: #2c3140; }
.group { display: inline-flex; gap: 6px; align-items: center; }
</style>
