/**
 * 产线：选一种材料，沿配方往上游展开成一张图（每种材料一个节点），按最终建筑的座数
 * 反推每个节点每天的需求、要几座建筑、买多少，最后汇总整条产线的进出与面积利润。
 *
 * 每个节点的来源三选一：
 *     买入          不再往上游展开
 *     某条配方      默认按需求算出刚好够的座数（可以是小数）；指定座数后，不够的买入、多出来的卖掉
 *     采集          只对星球上有的资源；座数由所选星球的浓度决定
 *
 * 效率是一个全局系数：每座建筑每天的投入与产出（含采集）都乘它，面积与工人消耗不变。
 * CoGC（×1.25）与 5 名专家（×1.284）相乘得 FULL_EFFICIENCY。
 *
 * 派系（总部所在地）加成只给对应专业的建筑，与上面的系数相乘（游戏手册 Headquarters 页，
 * 算法同 PRUNplanner 的 calculateBuildingFactionBonus）：
 *     系数 = 1 + 基础加成 × (3 − 2 × 已用许可 ÷ 许可总数)，许可总数 = 总部等级 + 1

 *
 * 面积与建造成本含住房：按各级工人数配刚好够住的住房（座数可为小数），优先用两级合住的
 * HBL / HBM / HBC / HBB（每个工人占地更少），配不成对的再用单级的 HB1–HB5。仓库与核心模块不计。
 *
 * 「按整座计」时自动算出的生产建筑座数向上取整（多出来的产能照常生产、富余卖掉），
 * 住房取住得下所有人、占地最小的整数组合；手动填的座数原样使用。
 *
 * 其余口径与「面积利润」页一致（见 profit.ts）：工人消耗按满员全供应、
 * 建造成本不含星球环境附加建材。采集日产量 = 浓度 × 70（EXT / RIG）或 × 60（COL），与 buildings.ts 相同。
 *
 * 进出按材料净额算：整条产线里某种材料「产出 − 配方消耗 − 工人消耗」为正就卖、为负就买。
 * 所以副产物会先抵掉产线内部对它的消耗，剩下的才卖；副产物不会让下游节点少建建筑。
 *
 * 配方成环时（A 要 B、B 又要 A）迭代求解，收敛不了就在结果里标 unstable。
 */
import { DataError } from "../api/client";
import { fio } from "../data/sources";
import type { ResourceForm, ResourceSite, ResourceSites } from "../data/sources";
import type { ExchangeCode, FioBuilding, PriceSource } from "../api/types";
import { resolvePrices } from "./prices";
import { COGC_FACTOR, EXPERT_FACTORS, housingFor, wholeHousingFor } from "./base";
import { workforceDaily } from "./profit";

const DAY_MS = 86_400_000;

const EXTRACTORS: Record<ResourceForm, { building: string; daily: number }> = {
  MINERAL: { building: "EXT", daily: 70 },
  GASEOUS: { building: "COL", daily: 60 },
  LIQUID: { building: "RIG", daily: 70 },
};
export const FORM_LABEL: Record<ResourceForm, string> = { MINERAL: "固态", GASEOUS: "气态", LIQUID: "液态" };

/** CoGC 加成 × 同一专业 5 名专家的加成 */
export const FULL_EFFICIENCY = COGC_FACTOR * EXPERT_FACTORS[5];

/** 派系 → 专业 → 基础加成（许可全部用完时的数）*/
export const FACTIONS: Record<string, { label: string; bonus: Record<string, number> }> = {
  ANTARES: { label: "Antares Initiative (AI)", bonus: { ELECTRONICS: 0.10 } },
  BENTEN: { label: "Castillo-Ito Mercantile (CI)", bonus: { MANUFACTURING: 0.10 } },
  HORTUS: { label: "Insitor Cooperative (IC)", bonus: { AGRICULTURE: 0.06, FOOD_INDUSTRIES: 0.04 } },
  MORIA: { label: "NEO Charter Exploration (NC)", bonus: { METALLURGY: 0.04, CONSTRUCTION: 0.06 } },
  OUTSIDEREGION: { label: "无派系星域", bonus: { CHEMISTRY: 0.04, FUEL_REFINING: 0.04, RESOURCE_EXTRACTION: 0.04 } },
};
export const EXPERTISE_LABEL: Record<string, string> = {
  AGRICULTURE: "农业", CHEMISTRY: "化工", CONSTRUCTION: "建造", ELECTRONICS: "电子",
  FOOD_INDUSTRIES: "食品", FUEL_REFINING: "燃料精炼", MANUFACTURING: "制造", METALLURGY: "冶金",
  RESOURCE_EXTRACTION: "资源采集",
};

export function hqPermits(level: number): number {
  return Math.max(1, Math.floor(level) || 1) + 1;
}

/** 专业 → 效率系数（1.x）。used 不填按许可全部用完算（加成最低）*/
export function factionFactors(faction: string, level: number, used?: number | null): Record<string, number> {
  const total = hqPermits(level);
  const bases = Math.min(total, Math.max(1, used ?? total));
  const multiplier = 3 - 2 * bases / total;
  return Object.fromEntries(Object.entries(FACTIONS[faction]?.bonus ?? {})
    .map(([expertise, base]) => [expertise, 1 + base * multiplier]));
}

export const BUY = "BUY";
export const EXTRACT = "EXTRACT";

const LEVELS = [
  ["PIONEER", "Pioneers"], ["SETTLER", "Settlers"], ["TECHNICIAN", "Technicians"],
  ["ENGINEER", "Engineers"], ["SCIENTIST", "Scientists"],
] as const;

export interface ChainLine { ticker: string; amount: number }

/** 一种自产方式；数量都是一座建筑每天的 */
export interface ChainSource {
  /** 配方的 StandardRecipeName，或 EXTRACT */
  id: string;
  building: string;
  inputs: ChainLine[];
  outputs: ChainLine[];
}

export interface ChainData {
  tickers: string[];
  category: Record<string, string>;
  buildings: Map<string, FioBuilding>;
  /** 产出 ticker → 能产出它的配方 */
  recipes: Map<string, ChainSource[]>;
  sites: ResourceSites;
  planetNames: Record<string, string>;
  /** 建筑 → 一座每天的工人消耗 */
  workforce: Map<string, ChainLine[]>;
}

export interface ChainPrices {
  buy: Record<string, number>;
  sell: Record<string, number>;
}

export interface NodeSetting {
  /** BUY / EXTRACT / 配方 id；不填走全局规则与默认 */
  source?: string;
  /** 采集的星球 */
  planet?: string;
  /** 自产建筑座数；不填 = 刚好满足需求 */
  count?: number | null;
}

export type ChainRule = "buy" | "make";

export interface ChainConfig {
  root: string;
  /** 最终产品的建筑座数 */
  count: number;
  /** 全局生产效率，1 = 100% */
  efficiency: number;
  /** 自动算出的生产建筑与住房都按整座计 */
  whole?: boolean;
  /** 建筑专业 → 额外的效率系数（派系加成），与 efficiency 相乘 */
  factors?: Record<string, number>;
  nodes: Record<string, NodeSetting>;
  /** 全局规则：某种材料一律买入 / 一律自产（节点上单独选了来源的以节点为准）*/
  rules: Record<string, ChainRule>;
}

export interface ChainNode {
  ticker: string;
  root: boolean;
  /** 离最终产品几层 */
  depth: number;
  /** 可选的自产方式（不含买入）*/
  options: ChainSource[];
  /** 当前来源：BUY / EXTRACT / 配方 id */
  sourceId: string;
  source: ChainSource | null;
  /** 采集时所选的矿点 */
  site: ResourceSite | null;
  /** 产线内配方每天要用掉多少 */
  demand: number;
  /** 刚好满足需求要几座 */
  need: number;
  buildings: number;
  /** 座数是手动指定的 */
  fixed: boolean;
  /** 这个节点自己每天产多少 */
  made: number;
  bought: number;
  surplus: number;
}

export interface ChainEdge { from: string; to: string; amount: number }

export interface ChainFlow {
  ticker: string;
  produced: number;
  consumed: number;
  workforce: number;
  net: number;
}

export interface ChainBuilding {
  ticker: string;
  count: number;
  area: number;
  makes: string[];
}

export interface ChainResult {
  nodes: ChainNode[];
  edges: ChainEdge[];
  flows: ChainFlow[];
  buildings: ChainBuilding[];
  /** 住这些工人要的住房；makes 为空 */
  housing: ChainBuilding[];
  /** 各级工人数 */
  workers: { level: string; count: number }[];
  /** 总面积 = 生产（含采集）+ 住房 */
  area: number;
  production_area: number;
  housing_area: number;
  unstable: boolean;
}

export async function loadData(): Promise<ChainData> {
  const [buildingList, needList, materialList, recipeList, sites, planets] = await Promise.all([
    fio.buildings(), fio.workforceNeeds(), fio.materials(), fio.recipes(), fio.resourceSites(),
    fio.planets().catch(() => []),
  ]);
  const buildings = new Map(buildingList.map((b) => [b.Ticker, b]));
  const needs: Record<string, Record<string, number>> = {};
  for (const g of needList) {
    needs[g.WorkforceType] = Object.fromEntries((g.Needs ?? []).map((n) => [n.MaterialTicker, n.Amount]));
  }
  const workforce = new Map<string, ChainLine[]>();
  for (const b of buildingList) {
    workforce.set(b.Ticker, Object.entries(workforceDaily(b, needs)).map(([ticker, amount]) => ({ ticker, amount })));
  }
  const recipes = new Map<string, ChainSource[]>();
  for (const r of recipeList) {
    const building = buildings.get(r.BuildingTicker);
    if (!building || !r.TimeMs || !building.AreaCost || !(r.Outputs ?? []).length) continue;
    const runs = DAY_MS / r.TimeMs;
    const source: ChainSource = {
      id: r.StandardRecipeName, building: r.BuildingTicker,
      inputs: (r.Inputs ?? []).map((i) => ({ ticker: i.Ticker, amount: i.Amount * runs })),
      outputs: (r.Outputs ?? []).map((o) => ({ ticker: o.Ticker, amount: o.Amount * runs })),
    };
    for (const o of source.outputs) {
      if (!(o.amount > 0)) continue;
      if (!recipes.has(o.ticker)) recipes.set(o.ticker, []);
      recipes.get(o.ticker)!.push(source);
    }
  }
  return {
    tickers: materialList.map((m) => m.Ticker).sort(),
    category: Object.fromEntries(materialList.map((m) => [m.Ticker, m.CategoryName ?? ""])),
    buildings, recipes, sites, workforce,
    planetNames: Object.fromEntries(planets.map((p) => [p.PlanetNaturalId, p.PlanetName])),
  };
}

export interface PriceQuery {
  exchange: ExchangeCode;
  price_source: PriceSource;
  sell_exchange: ExchangeCode;
  sell_price_source: PriceSource;
}

export async function loadPrices(data: ChainData, q: PriceQuery): Promise<ChainPrices> {
  const [buy, sell] = await Promise.all([
    resolvePrices(data.tickers, q.exchange, q.price_source),
    resolvePrices(data.tickers, q.sell_exchange, q.sell_price_source),
  ]);
  return { buy, sell };
}

function extractSource(ticker: string, site: ResourceSite): ChainSource {
  const { building, daily } = EXTRACTORS[site.form];
  return { id: EXTRACT, building, inputs: [], outputs: [{ ticker, amount: daily * site.factor }] };
}

/** 这种材料的自产方式：配方 + 采集（星球上有的话）*/
export function optionsOf(data: ChainData, ticker: string, planet?: string): { options: ChainSource[]; site: ResourceSite | null } {
  const options = [...(data.recipes.get(ticker) ?? [])];
  const sites = data.sites[ticker] ?? [];
  const site = sites.find((s) => s.planet === planet) ?? sites[0] ?? null;
  if (site) options.push(extractSource(ticker, site));
  return { options, site };
}

/** 默认配方：按当前价格，这条配方单独看每面积日利润最高的 */
function bestRecipe(data: ChainData, options: ChainSource[], prices: ChainPrices): ChainSource | null {
  let best: ChainSource | null = null, bestValue = -Infinity;
  for (const s of options) {
    if (s.id === EXTRACT) continue;
    const value = (s.outputs.reduce((sum, l) => sum + l.amount * (prices.sell[l.ticker] ?? 0), 0)
      - s.inputs.reduce((sum, l) => sum + l.amount * (prices.buy[l.ticker] ?? 0), 0))
      / (data.buildings.get(s.building)?.AreaCost || 1);
    if (value > bestValue) { best = s; bestValue = value; }
  }
  return best;
}

export function compute(data: ChainData, config: ChainConfig, prices: ChainPrices): ChainResult {
  const root = config.root;
  const efficiency = config.efficiency > 0 ? config.efficiency : 1;
  const scaled = (s: ChainSource | null): ChainSource | null => {
    if (!s) return s;
    const k = efficiency * (config.factors?.[data.buildings.get(s.building)?.Expertise ?? ""] ?? 1);
    return k === 1 ? s : {
      ...s,
      inputs: s.inputs.map((l) => ({ ...l, amount: l.amount * k })),
      outputs: s.outputs.map((l) => ({ ...l, amount: l.amount * k })),
    };
  };

  interface Resolved { options: ChainSource[]; site: ResourceSite | null; source: ChainSource | null }
  const resolved = new Map<string, Resolved>();
  const resolve = (ticker: string): Resolved => {
    let r = resolved.get(ticker);
    if (r) return r;
    const setting = config.nodes[ticker] ?? {};
    const { options, site } = optionsOf(data, ticker, setting.planet);
    const fallback = () => bestRecipe(data, options, prices);
    const anyMake = () => fallback() ?? options[0] ?? null;
    let source: ChainSource | null;
    const chosen = setting.source ? options.find((o) => o.id === setting.source) : undefined;
    if (ticker === root) source = chosen ?? anyMake();
    else if (chosen) source = chosen;
    else if (setting.source === BUY) source = null;
    else if (config.rules[ticker] === "buy") source = null;
    else if (config.rules[ticker] === "make") source = anyMake();
    else source = fallback();          // 默认：有配方就自产，原矿买入
    resolved.set(ticker, r = { options, site, source: scaled(source) });
    return r;
  };

  if (!resolve(root).source) {
    throw new DataError(`${root} 既没有配方，也不是星球上能采的资源，没法展开产线。`);
  }

  // 结构：从最终产品沿自产节点的投入往上游走；DFS 顺便找出成环的边
  const state = new Map<string, 1 | 2>();
  const post: string[] = [];
  const back = new Set<string>();
  const visit = (ticker: string) => {
    state.set(ticker, 1);
    for (const input of resolve(ticker).source?.inputs ?? []) {
      const s = state.get(input.ticker);
      if (s === 1) back.add(`${input.ticker}>${ticker}`);
      else if (!s) visit(input.ticker);
    }
    state.set(ticker, 2);
    post.push(ticker);
  };
  visit(root);
  const order = post.reverse();        // 消费者在前

  const depth = new Map<string, number>([[root, 0]]);
  for (const ticker of order) {
    const d = depth.get(ticker) ?? 0;
    for (const input of resolve(ticker).source?.inputs ?? []) {
      if (back.has(`${input.ticker}>${ticker}`)) continue;
      depth.set(input.ticker, Math.max(depth.get(input.ticker) ?? 0, d + 1));
    }
  }

  // 座数：需求由下游座数决定，下游先定；成环时多迭代几遍
  const own = (ticker: string) =>
    resolve(ticker).source?.outputs.find((o) => o.ticker === ticker)?.amount ?? 0;
  const fixedCount = (ticker: string): number | null => {
    const c = config.nodes[ticker]?.count;
    return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : null;
  };
  const auto = (need: number) => config.whole ? Math.ceil(need - 1e-9) : need;
  const count = new Map<string, number>();
  let demand = new Map<string, number>();
  let unstable = true;
  for (let i = 0; i < 200; i++) {
    demand = new Map();
    for (const ticker of order) {
      const n = count.get(ticker) ?? 0;
      if (!n) continue;
      for (const input of resolve(ticker).source!.inputs) {
        demand.set(input.ticker, (demand.get(input.ticker) ?? 0) + n * input.amount);
      }
    }
    let moved = 0;
    for (const ticker of order) {
      if (!resolve(ticker).source) continue;
      const per = own(ticker);
      const next = ticker === root ? Math.max(0, config.count)
        : fixedCount(ticker) ?? auto(per > 0 ? (demand.get(ticker) ?? 0) / per : 0);
      moved = Math.max(moved, Math.abs(next - (count.get(ticker) ?? 0)) / Math.max(1, next));
      count.set(ticker, next);
    }
    if (moved < 1e-9) { unstable = false; break; }
  }

  const nodes: ChainNode[] = order.map((ticker) => {
    const { options, site, source } = resolve(ticker);
    const per = own(ticker);
    const need = demand.get(ticker) ?? 0;
    const buildings = source ? count.get(ticker) ?? 0 : 0;
    const made = buildings * per;
    return {
      ticker, root: ticker === root, depth: depth.get(ticker) ?? 0, options,
      sourceId: source?.id ?? BUY, source, site: source?.id === EXTRACT ? site : null,
      demand: need, need: source && per > 0 ? need / per : 0, buildings,
      fixed: ticker === root || (!!source && fixedCount(ticker) != null),
      made, bought: Math.max(0, need - made), surplus: Math.max(0, made - need),
    };
  });

  const edges: ChainEdge[] = [];
  const flow = new Map<string, ChainFlow>();
  const at = (ticker: string) => {
    let f = flow.get(ticker);
    if (!f) flow.set(ticker, f = { ticker, produced: 0, consumed: 0, workforce: 0, net: 0 });
    return f;
  };
  const byBuilding = new Map<string, ChainBuilding>();
  const workers = new Map<string, number>();
  let area = 0;
  for (const node of nodes) {
    if (!node.source) continue;
    const n = node.buildings;
    for (const input of node.source.inputs) {
      edges.push({ from: input.ticker, to: node.ticker, amount: n * input.amount });
      at(input.ticker).consumed += n * input.amount;
    }
    if (!n) continue;
    for (const output of node.source.outputs) at(output.ticker).produced += n * output.amount;
    for (const line of data.workforce.get(node.source.building) ?? []) at(line.ticker).workforce += n * line.amount;
    const info = data.buildings.get(node.source.building);
    let b = byBuilding.get(node.source.building);
    if (!b) byBuilding.set(node.source.building, b = { ticker: node.source.building, count: 0, area: 0, makes: [] });
    b.count += n;
    b.area += n * (info?.AreaCost ?? 0);
    b.makes.push(node.ticker);
    area += n * (info?.AreaCost ?? 0);
    for (const [level, field] of LEVELS) {
      const c = info?.[field] ?? 0;
      if (c) workers.set(level, (workers.get(level) ?? 0) + n * c);
    }
  }
  const flows = [...flow.values()];
  for (const f of flows) {
    f.net = f.produced - f.consumed - f.workforce;
    if (Math.abs(f.net) < 1e-9 * Math.max(1, f.produced, f.consumed)) f.net = 0;
  }

  const areaOf = (ticker: string) => data.buildings.get(ticker)?.AreaCost ?? 0;
  const headcount = LEVELS.map(([level]) => workers.get(level) ?? 0);
  const housing: ChainBuilding[] = (config.whole ? wholeHousingFor(headcount, areaOf) : housingFor(headcount))
    .map(({ ticker, count: n }) => ({ ticker, count: n, area: n * (data.buildings.get(ticker)?.AreaCost ?? 0), makes: [] }));
  const housingArea = housing.reduce((s, h) => s + h.area, 0);

  return {
    nodes, edges, flows, housing,
    production_area: area, housing_area: housingArea,
    buildings: [...byBuilding.values()].sort((a, b) => b.area - a.area),
    workers: LEVELS.map(([level]) => ({ level, count: workers.get(level) ?? 0 })).filter((w) => w.count),
    area: area + housingArea, unstable,
  };
}

export interface MoneyRow {
  ticker: string;
  amount: number;
  /** 买入行：其中工人消耗掉的量 */
  workforce: number;
  price: number | null;
  value: number;
}

export interface ChainMoney {
  inputs: MoneyRow[];
  outputs: MoneyRow[];
  revenue: number;
  cost: number;
  profit: number;
  per_area: number | null;
  build_cost: number;
  payback: number | null;
  /** 进出里没有价格、按 0 计的材料 */
  unpriced: string[];
  build_unpriced: string[];
}

export function summarize(data: ChainData, result: ChainResult, prices: ChainPrices): ChainMoney {
  const inputs: MoneyRow[] = [], outputs: MoneyRow[] = [];
  const unpriced: string[] = [];
  for (const f of result.flows) {
    if (!f.net) continue;
    const selling = f.net > 0;
    const price = (selling ? prices.sell : prices.buy)[f.ticker] ?? null;
    if (price == null) unpriced.push(f.ticker);
    const amount = Math.abs(f.net);
    (selling ? outputs : inputs).push({
      ticker: f.ticker, amount, workforce: selling ? 0 : Math.min(amount, f.workforce),
      price, value: amount * (price ?? 0),
    });
  }
  inputs.sort((a, b) => b.value - a.value);
  outputs.sort((a, b) => b.value - a.value);
  const revenue = outputs.reduce((s, r) => s + r.value, 0);
  const cost = inputs.reduce((s, r) => s + r.value, 0);
  const profit = revenue - cost;

  let buildCost = 0;
  const buildUnpriced = new Set<string>();
  for (const b of [...result.buildings, ...result.housing]) {
    for (const c of data.buildings.get(b.ticker)?.BuildingCosts ?? []) {
      const p = prices.buy[c.CommodityTicker];
      if (p == null) buildUnpriced.add(c.CommodityTicker);
      else buildCost += b.count * c.Amount * p;
    }
  }
  return {
    inputs, outputs, revenue, cost, profit,
    per_area: result.area > 0 ? profit / result.area : null,
    build_cost: buildCost,
    payback: profit > 0 && buildCost > 0 ? buildCost / profit : null,
    unpriced: unpriced.sort(), build_unpriced: [...buildUnpriced].sort(),
  };
}
