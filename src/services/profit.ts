/**
 * 单条配方的单位面积利润：选一种材料，列出所有能产出它的配方，每条按一座建筑、
 * 标称产能（效率 100%）折成每天的进出，连同市场价一起交给页面。
 * 从 prun_selfplanner 的 services/profit.py 移植。
 *
 * 调价、反推都是线性的（利润 = Σ产出×卖价 − Σ投入×买价），页面拿着这里给的数量自己算。
 *
 *     面积      /building/allbuildings 的 AreaCost（只算这座生产建筑，不含住房）
 *     每日轮数  86400000 / TimeMs
 *     工人消耗  建筑各级工人数 × /global/workforceneeds 的每 100 人日用量（奢侈品两种都计）
 *     建造成本  BuildingCosts × 买入价；不含星球环境附加建材（没有指定星球）
 *     日成交量  PRUNplanner 公开行情的 avg_traded_7d（卖出交易所，近 7 日日均）
 *
 * 采集类（EXT/RIG/COL）在配方表里只有一条空配方，产量取决于星球资源浓度，这里不出现。
 */
import { DataError } from "../api/client";
import { fio, pp } from "../data/sources";
import type { ExchangeCode, FioBuilding, PriceSource, ProfitAnalysis, ProfitLine, ProfitRecipe } from "../api/types";
import { resolvePrices } from "./prices";

const DAY_MS = 86_400_000;
const WORKERS: [string, keyof FioBuilding][] = [
  ["PIONEER", "Pioneers"], ["SETTLER", "Settlers"], ["TECHNICIAN", "Technicians"],
  ["ENGINEER", "Engineers"], ["SCIENTIST", "Scientists"],
];

function lines(amounts: Record<string, number>): ProfitLine[] {
  return Object.entries(amounts).sort((a, b) => b[1] - a[1]).map(([ticker, amount]) => ({ ticker, amount }));
}

function workforceDaily(building: FioBuilding, needs: Record<string, Record<string, number>>) {
  const out: Record<string, number> = {};
  for (const [level, field] of WORKERS) {
    const count = Number(building[field]) || 0;
    if (!count) continue;
    for (const [ticker, per100] of Object.entries(needs[level] ?? {})) {
      out[ticker] = (out[ticker] ?? 0) + (per100 / 100) * count;
    }
  }
  return out;
}

export interface ProfitQuery {
  exchange: ExchangeCode;
  price_source: PriceSource;
  sell_exchange: ExchangeCode;
  sell_price_source: PriceSource;
}

export async function analyze(tickerIn: string, q: ProfitQuery): Promise<ProfitAnalysis> {
  const ticker = tickerIn.trim().toUpperCase();
  const [buildingList, needList, materialList, recipeList] = await Promise.all([
    fio.buildings(), fio.workforceNeeds(), fio.materials(), fio.recipes(),
  ]);
  const buildings = new Map(buildingList.map((b) => [b.Ticker, b]));
  const needs: Record<string, Record<string, number>> = {};
  for (const g of needList) {
    needs[g.WorkforceType] = Object.fromEntries((g.Needs ?? []).map((n) => [n.MaterialTicker, n.Amount]));
  }
  const category = new Map(materialList.map((m) => [m.Ticker, m.CategoryName ?? ""]));

  const picked = recipeList.flatMap((recipe) => {
    const building = buildings.get(recipe.BuildingTicker);
    return building && recipe.TimeMs && building.AreaCost
      && (recipe.Outputs ?? []).some((o) => o.Ticker === ticker)
      ? [[recipe, building] as const] : [];
  });
  if (!picked.length) {
    throw new DataError(`没有产出 ${ticker} 的配方。采集类材料的产量取决于星球资源，不在此列。`);
  }

  const buyTickers = new Set<string>();
  const sellTickers = new Set<string>();
  const drafts = picked.map(([recipe, building]) => {
    const runs = DAY_MS / recipe.TimeMs;
    const outputs = Object.fromEntries((recipe.Outputs ?? []).map((o) => [o.Ticker, o.Amount * runs]));
    const inputs = Object.fromEntries((recipe.Inputs ?? []).map((i) => [i.Ticker, i.Amount * runs]));
    const workforce = workforceDaily(building, needs);
    const build = Object.fromEntries((building.BuildingCosts ?? []).map((c) => [c.CommodityTicker, c.Amount]));
    for (const t of Object.keys(outputs)) sellTickers.add(t);
    for (const t of [...Object.keys(inputs), ...Object.keys(workforce), ...Object.keys(build)]) buyTickers.add(t);
    return { recipe, building, outputs, inputs, workforce, build };
  });

  const [buyPrices, sellPrices] = await Promise.all([
    resolvePrices([...buyTickers].sort(), q.exchange, q.price_source),
    resolvePrices([...sellTickers].sort(), q.sell_exchange, q.sell_price_source),
  ]);

  const recipes: ProfitRecipe[] = drafts.map(({ recipe, building, outputs, inputs, workforce, build }) => ({
    recipe_id: recipe.StandardRecipeName, building: building.Ticker, area: building.AreaCost,
    outputs: lines(outputs), inputs: lines(inputs), workforce: lines(workforce),
    build_cost: Object.entries(build).reduce((s, [t, n]) => s + (t in buyPrices ? n * buyPrices[t] : 0), 0),
    build_unpriced: Object.keys(build).filter((t) => !(t in buyPrices)).sort(),
  }));

  let dailyTraded: number | null = null;
  try {
    dailyTraded = (await pp.exchanges())
      .find((r) => r.ticker === ticker && r.exchange_code === q.sell_exchange)?.avg_traded_7d ?? null;
  } catch { /* 行情源挂了只是少一个数 */ }

  const shown = new Set([...sellTickers]);
  for (const r of recipes) for (const l of [...r.inputs, ...r.workforce]) shown.add(l.ticker);
  const categories: Record<string, string> = {};
  for (const t of shown) categories[t] = category.get(t) ?? "";

  return {
    ticker, exchange: q.exchange, price_source: q.price_source,
    sell_exchange: q.sell_exchange, sell_price_source: q.sell_price_source,
    recipes, buy_prices: buyPrices, sell_prices: sellPrices, categories, daily_traded: dailyTraded,
  };
}
