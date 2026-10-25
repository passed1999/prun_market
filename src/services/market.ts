/**
 * 全服市场统计：把每月的全服产量摊开成「供给 / 需求 / 集中度」。
 * 从 prun_selfplanner 的 services/market.py 逐行移植，算法与常数不变。
 *
 * 供给侧是现成的（每种材料的全服日产量），需求侧要自己推，分两段：
 *
 *     产线消耗(T) = Σ 每条配方每天跑的轮数 × 该配方每轮吃掉多少 T
 *     工人消费(T) = Σ 各级工人数 × 该级每 100 人日用量 / 100
 *
 * 配方每天跑多少轮由它的产出反推：某材料由 N 条配方产出时按等权拆分。
 * 全服工人数由「只有某一级工人吃的必需品」反推，取该级各独占品估计值的中位数。
 *
 * 对账（原项目）：数据源在 apr26 及以前自带 consumed，14 个月总量比 0.980–1.021，逐材料 ±10% 命中约七成。
 * 建造与造船的消耗算不出来，这类材料 confidence = partial，净流只能当上限看。
 */
import { DataError } from "../api/client";
import { fio, stats } from "../data/sources";
import type {
  MarketCompany, MarketMaterial, MarketMaterialPoint, MarketMaterialRow, MarketProducer,
  MarketRecipeUse, MarketSnapshot, MarketUniverseMonth, FioRecipe,
} from "../api/types";

const LEVELS = ["PIONEER", "SETTLER", "TECHNICIAN", "ENGINEER", "SCIENTIST"] as const;
const LUXURY_CATEGORY = "consumables (luxury)";
/** 星球环境附加建材：不在任何建筑的 BuildingCosts 里，但确实被建造吃掉 */
const ENV_MATERIALS = new Set(["MCG", "AEF", "SEA", "HSE", "MGC", "BL", "INS", "TSH"]);

// ---- 月份 ----

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 'jul26' -> [26, 7]，用于排序。无法解析的排到最前 */
export function monthKey(month: string): [number, number] {
  const num = MONTHS.indexOf(month.slice(0, 3).toLowerCase()) + 1;
  const year = Number(month.slice(3));
  return num && Number.isInteger(year) ? [year, num] : [0, 0];
}

function cmpMonth(a: string, b: string): number {
  const [ya, ma] = monthKey(a), [yb, mb] = monthKey(b);
  return ya - yb || ma - mb;
}

/** 'jul26' -> '3026 年 7 月'。游戏内年份 = 3000 + 两位数年 */
export function monthLabel(month: string): string {
  const [year, num] = monthKey(month);
  return num ? `${3000 + year} 年 ${num} 月` : month;
}

// ---- 静态游戏数据 ----

interface GameRef {
  category: Record<string, string>;
  recipes: FioRecipe[];
  needs: Record<string, Record<string, number>>;
  luxuries: Set<string>;
  buildingCosts: Set<string>;
}

async function gameRef(): Promise<GameRef> {
  const [materials, recipes, needs, buildings] = await Promise.all([
    fio.materials(), fio.recipes(), fio.workforceNeeds(), fio.buildings(),
  ]);
  const category: Record<string, string> = {};
  for (const m of materials) category[m.Ticker] = m.CategoryName ?? "";
  const needTable: Record<string, Record<string, number>> = {};
  for (const g of needs) {
    needTable[g.WorkforceType] = Object.fromEntries((g.Needs ?? []).map((n) => [n.MaterialTicker, n.Amount]));
  }
  const buildingCosts = new Set<string>();
  for (const b of buildings) for (const c of b.BuildingCosts ?? []) buildingCosts.add(c.CommodityTicker);
  return {
    category, recipes, needs: needTable,
    luxuries: new Set(Object.entries(category).filter(([, c]) => c === LUXURY_CATEGORY).map(([t]) => t)),
    buildingCosts,
  };
}

// ---- 需求推算 ----

interface Demand {
  line: Record<string, number>;
  workforce: Record<string, number>;
  confidence: Record<string, MarketMaterialRow["confidence"]>;
  population: Record<string, number>;
  consumedBy: Record<string, MarketRecipeUse[]>;
  madeBy: Record<string, MarketRecipeUse[]>;
}

function demandTotal(d: Demand, ticker: string): number {
  return (d.line[ticker] ?? 0) + (d.workforce[ticker] ?? 0);
}

/** 每级工人「只有它吃」的必需品 */
function exclusiveNeeds(ref: GameRef): Record<string, string[]> {
  const eaters: Record<string, string[]> = {};
  for (const level of LEVELS) {
    for (const ticker of Object.keys(ref.needs[level] ?? {})) {
      if (!ref.luxuries.has(ticker)) (eaters[ticker] ??= []).push(level);
    }
  }
  const out: Record<string, string[]> = {};
  for (const level of LEVELS) {
    out[level] = Object.entries(eaters).filter(([, lv]) => lv.length === 1 && lv[0] === level).map(([t]) => t);
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 全服各级工人数。稳态下「只有该级吃的必需品」产量减去产线消耗，就是工人吃掉的量 */
function estimatePopulation(amount: Record<string, number>, line: Record<string, number>, ref: GameRef) {
  const out: Record<string, number> = {};
  for (const [level, tickers] of Object.entries(exclusiveNeeds(ref))) {
    const estimates: number[] = [];
    for (const ticker of tickers) {
      const per100 = ref.needs[level]?.[ticker] ?? 0;
      const eaten = (amount[ticker] ?? 0) - (line[ticker] ?? 0);
      if (per100 > 0 && eaten > 0) estimates.push(eaten / per100 * 100);
    }
    out[level] = estimates.length ? Math.trunc(median(estimates)) : 0;
  }
  return out;
}

/** 由全服日产量推全服日消耗。amount 是 {ticker: 日产量} */
export function estimateDemand(amount: Record<string, number>, ref: GameRef): Demand {
  const byOutput: Record<string, FioRecipe[]> = {};
  for (const recipe of ref.recipes) {
    for (const out of recipe.Outputs ?? []) (byOutput[out.Ticker] ??= []).push(recipe);
  }
  const line: Record<string, number> = {};
  const consumedBy: Record<string, MarketRecipeUse[]> = {};
  const madeBy: Record<string, MarketRecipeUse[]> = {};
  const multiSource = new Set(Object.entries(byOutput).filter(([, rs]) => rs.length > 1).map(([t]) => t));
  const splitDownstream = new Set<string>();

  for (const recipe of ref.recipes) {
    const outputs = (recipe.Outputs ?? []).filter((o) => o.Amount).map((o) => [o.Ticker, o.Amount] as const);
    if (!outputs.length) continue;              // 采集类的空配方（RIG:=>）
    const rates = outputs.map(([ticker, perRun]) => ((amount[ticker] ?? 0) / byOutput[ticker].length) / perRun);
    const runs = rates.reduce((s, r) => s + r, 0) / rates.length;
    if (runs <= 0) continue;
    const recipeId = recipe.StandardRecipeName;
    const building = recipe.BuildingTicker ?? "";
    const approx = outputs.some(([ticker]) => multiSource.has(ticker));
    for (const [ticker, perRun] of outputs) {
      (madeBy[ticker] ??= []).push({ recipe_id: recipeId, building_ticker: building, daily_amount: runs * perRun });
    }
    for (const item of recipe.Inputs ?? []) {
      const used = runs * item.Amount;
      line[item.Ticker] = (line[item.Ticker] ?? 0) + used;
      (consumedBy[item.Ticker] ??= []).push({ recipe_id: recipeId, building_ticker: building, daily_amount: used });
      if (approx) splitDownstream.add(item.Ticker);
    }
  }

  const population = estimatePopulation(amount, line, ref);
  const workforce: Record<string, number> = {};
  const needTickers = new Set<string>();
  for (const level of LEVELS) for (const t of Object.keys(ref.needs[level] ?? {})) needTickers.add(t);
  for (const ticker of needTickers) {
    workforce[ticker] = LEVELS.reduce(
      (s, level) => s + ((ref.needs[level]?.[ticker] ?? 0) / 100) * (population[level] ?? 0), 0);
  }

  const confidence: Demand["confidence"] = {};
  for (const ticker of new Set([...Object.keys(amount), ...Object.keys(line), ...Object.keys(workforce)])) {
    const construction = ref.buildingCosts.has(ticker) || ENV_MATERIALS.has(ticker);
    if (construction || (!(ticker in consumedBy) && !(ticker in workforce))) confidence[ticker] = "partial";
    else if (splitDownstream.has(ticker) || ticker in workforce) confidence[ticker] = "approx";
    else confidence[ticker] = "exact";
  }
  for (const uses of [...Object.values(consumedBy), ...Object.values(madeBy)]) {
    uses.sort((a, b) => b.daily_amount - a.daily_amount);
  }
  return { line, workforce, confidence, population, consumedBy, madeBy };
}

function row(ticker: string, raw: { volume?: number; consumed?: number | null }, amount: Record<string, number>,
             demand: Demand, ref: GameRef, st: { producer_count?: number; cr4?: number; hhi?: number } | undefined,
): MarketMaterialRow {
  const daily = amount[ticker] ?? 0;
  return {
    ticker,
    category: ref.category[ticker] ?? "",
    amount: daily,
    volume: Number(raw.volume) || 0,
    line_consumption: demand.line[ticker] ?? 0,
    workforce_consumption: demand.workforce[ticker] ?? 0,
    net_flow: daily - demandTotal(demand, ticker),
    confidence: demand.confidence[ticker] ?? "partial",
    historical_consumed: raw.consumed ?? null,
    producer_count: st?.producer_count ?? 0,
    cr4: st?.cr4 ?? 0,
    hhi: st?.hhi ?? 0,
  };
}

function amountsOf(production: Record<string, { amount?: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, v] of Object.entries(production)) out[t] = Number(v.amount) || 0;
  return out;
}

// ---- 对外 ----

/** 由新到旧。universe-data.json 的 key 就是数据源发布过的月份 */
export async function availableMonths(force = false): Promise<string[]> {
  const universe = await stats.universe(force);
  return Object.keys(universe).sort((a, b) => cmpMonth(b, a));
}

async function resolveMonth(month: string | undefined, force = false): Promise<[string, string[]]> {
  const months = await availableMonths(force);
  if (!months.length) throw new DataError("暂时取不到全服统计数据。");
  if (month && !months.includes(month)) throw new DataError("这个月份还没有全服统计数据。");
  return [month || months[0], months];
}

/** 某个月的全服供需总表，外加逐月的宇宙规模曲线 */
export async function snapshot(month?: string, force = false): Promise<MarketSnapshot> {
  const [picked, months] = await resolveMonth(month, force);
  const [universeRaw, production, companies, ref] = await Promise.all([
    stats.universe(), stats.production(picked, force), stats.companies(picked, force), gameRef(),
  ]);
  const amount = amountsOf(production);
  const demand = estimateDemand(amount, ref);
  const byTicker = companies.by_ticker;

  const rows = Object.entries(production).map(([ticker, raw]) =>
    row(ticker, raw, amount, demand, ref, byTicker[ticker]));
  rows.sort((a, b) => b.volume - a.volume);

  // 数据源自 may26 起不再产出 consumed/profit，两者是同一批停的
  const withConsumed = months.filter((m) => universeRaw[m]?.profit != null);
  const universe: MarketUniverseMonth[] = [...months].sort(cmpMonth).map((m) => ({
    month: m, label: monthLabel(m),
    volume: Number(universeRaw[m]?.volume) || 0,
    bases: Number(universeRaw[m]?.bases) || 0,
    companies: Number(universeRaw[m]?.companies) || 0,
  }));
  return {
    month: picked, label: monthLabel(picked), months,
    consumed_until: withConsumed.length ? withConsumed.reduce((a, b) => (cmpMonth(a, b) >= 0 ? a : b)) : null,
    universe, materials: rows, workforce_estimate: demand.population,
  };
}

/** 单种材料：本月供需 + 逐月曲线 + 生产商榜 + 上下游配方 */
export async function material(tickerIn: string, month?: string, force = false): Promise<MarketMaterial> {
  const ticker = tickerIn.toUpperCase();
  const [picked, months] = await resolveMonth(month, force);
  const production = await stats.production(picked, force);
  if (!(ticker in production)) throw new DataError(`${monthLabel(picked)}的全服数据里没有 ${ticker}。`);

  const [ref, companies, known] = await Promise.all([
    gameRef(), stats.companies(picked, force), stats.knownCompanies(force),
  ]);
  const amount = amountsOf(production);
  const demand = estimateDemand(amount, ref);
  const st = companies.by_ticker[ticker];
  const total = st?.total_amount ?? 0;

  const ordered = [...months].sort(cmpMonth);
  const pasts = await Promise.all(ordered.map((m) => (m === picked ? production : stats.production(m))));
  const series: MarketMaterialPoint[] = [];
  ordered.forEach((m, i) => {
    const past = pasts[i];
    const r = past[ticker];
    if (!r) return;
    const pastDemand = m === picked ? demand : estimateDemand(amountsOf(past), ref);
    series.push({
      month: m, label: monthLabel(m),
      amount: Number(r.amount) || 0, volume: Number(r.volume) || 0,
      demand: demandTotal(pastDemand, ticker), consumed: r.consumed ?? null,
    });
  });

  const producers: MarketProducer[] = (st?.top ?? []).map((p) => ({
    company_id: p.company_id,
    name: known[p.company_id]?.name ?? "",
    corp: known[p.company_id]?.corp ?? "",
    amount: p.amount,
    share: total ? p.amount / total : 0,
  }));

  return {
    ticker, month: picked, label: monthLabel(picked),
    latest: row(ticker, production[ticker], amount, demand, ref, st),
    series, producers,
    consumed_by: (demand.consumedBy[ticker] ?? []).slice(0, 12),
    made_by: (demand.madeBy[ticker] ?? []).slice(0, 12),
  };
}

/** 全服公司按日产值排名 */
export async function topCompanies(month?: string, limit = 50, force = false): Promise<MarketCompany[]> {
  const [picked] = await resolveMonth(month, force);
  const [companies, known] = await Promise.all([stats.companies(picked, force), stats.knownCompanies(force)]);
  const rows: MarketCompany[] = Object.entries(companies.totals)
    .filter(([, v]) => v.rank)
    .map(([cid, v]) => ({
      company_id: cid, name: known[cid]?.name ?? "", corp: known[cid]?.corp ?? "",
      volume: v.volume, rank: v.rank,
    }));
  rows.sort((a, b) => a.rank - b.rank);
  return rows.slice(0, limit);
}
