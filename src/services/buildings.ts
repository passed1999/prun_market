/**
 * 由每月全服产量反推建筑数量，再按「每日衰减」口径算建材的维修消耗。
 *
 *     建筑数量(B)   = Σ B 的每条配方每天跑的轮数 × 每轮耗时(天) ÷ 平均效率
 *     月维修消耗(T) = Σ 建筑数量(B) × B 的建造用量(T) ÷ 180 × 30
 *
 * 每条配方每天跑多少轮沿用全服市场的推法（market.recipeRuns：由产出反推，多条配方产同一材料时等权拆分）。
 * 维修口径：建筑满 180 天折旧完，维修用量与距上次维修的天数成正比，所以不管多久修一次，
 * 摊到每天都是「建造用量 ÷ 180」。
 *
 * 算不到的部分：
 *   - 采集建筑（EXT / COL / RIG）没有配方，产量取决于各星球的资源浓度，只能按一个假定的平均浓度粗估；
 *   - 住房、仓库、核心模块与星球设施不折损效率，没人维修，也无从由产量反推，不计入；
 *   - 星球环境附加建材（MCG / SEA / INS 等）因星球而异，不在建造用量里；
 *   - 新建与扩建的一次性消耗不是维修，不计入。
 */
import { fio, stats } from "../data/sources";
import type { FioBuilding, FioRecipe } from "../api/types";
import { monthLabel, recipeRuns, resolveMonth } from "./market";

const DAY_MS = 86_400_000;
/** 建筑从全新到完全折旧的天数 */
export const DEGRADE_DAYS = 180;
/** 月报里的量是日均值，月消耗统一按 30 天折算 */
export const MONTH_DAYS = 30;

/** 采集建筑在浓度 100% 的资源上每天的产量（效率 100% 时）*/
const EXTRACTORS: Record<string, number> = { EXT: 70, COL: 60, RIG: 70 };

function extractorOf(category: string): string {
  if (category === "gases") return "COL";
  if (category === "liquids") return "RIG";
  return "EXT";
}

export interface BuildingInputs {
  month: string;
  label: string;
  months: string[];
  amount: Record<string, number>;
  category: Record<string, string>;
  recipes: FioRecipe[];
  buildings: FioBuilding[];
}

export interface BuildingOptions {
  /** 全服平均生产效率，1 = 100% */
  efficiency: number;
  /** 采集建筑所在资源的平均浓度，0–1 */
  concentration: number;
}

/** recipe 由配方反推；extract 是按假定浓度粗估的采集建筑 */
export type BuildingKind = "recipe" | "extract";

export interface BuildingEstimate {
  ticker: string;
  name: string;
  kind: BuildingKind;
  /** 估算的全服座数 */
  count: number;
  /** 单座占地 */
  area: number;
  /** 含等权拆分出来的轮数 */
  approx: boolean;
  /** 占用座数最多的几种产出 */
  outputs: { ticker: string; count: number }[];
}

export interface RepairUse {
  building: string;
  kind: BuildingKind;
  count: number;
  /** 单座建造用量 */
  per_building: number;
  monthly: number;
}

export interface RepairMaterial {
  ticker: string;
  category: string;
  /** 月维修消耗 */
  monthly: number;
  /** 月产量（日产量 × 30）*/
  monthly_production: number;
  uses: RepairUse[];
}

export interface BuildingReport {
  buildings: BuildingEstimate[];
  materials: RepairMaterial[];
}

export async function loadInputs(month?: string, force = false): Promise<BuildingInputs> {
  const [picked, months] = await resolveMonth(month, force);
  const [production, materials, recipes, buildings] = await Promise.all([
    stats.production(picked, force), fio.materials(), fio.recipes(), fio.buildings(),
  ]);
  const amount: Record<string, number> = {};
  for (const [t, v] of Object.entries(production)) amount[t] = Number(v.amount) || 0;
  const category: Record<string, string> = {};
  for (const m of materials) category[m.Ticker] = m.CategoryName ?? "";
  return { month: picked, label: monthLabel(picked), months, amount, category, recipes, buildings };
}

export function compute(input: BuildingInputs, options: BuildingOptions): BuildingReport {
  const efficiency = options.efficiency > 0 ? options.efficiency : 1;
  const concentration = options.concentration > 0 ? options.concentration : 1;

  interface Acc { count: number; approx: boolean; outputs: Map<string, number> }
  const acc = new Map<string, Acc>();
  const bump = (building: string, count: number, approx: boolean, outputs: string[]) => {
    let a = acc.get(building);
    if (!a) acc.set(building, a = { count: 0, approx: false, outputs: new Map() });
    a.count += count;
    a.approx ||= approx;
    for (const t of outputs) a.outputs.set(t, (a.outputs.get(t) ?? 0) + count / outputs.length);
  };

  const made = new Set<string>();
  for (const recipe of input.recipes) for (const o of recipe.Outputs ?? []) made.add(o.Ticker);

  for (const { recipe, outputs, runs, approx } of recipeRuns(input.amount, input.recipes)) {
    const count = runs * (recipe.TimeMs / DAY_MS) / efficiency;
    bump(recipe.BuildingTicker, count, approx, outputs.map(([t]) => t));
  }
  // 没有任何配方产出、却有产量的，就是采出来的原料
  for (const [ticker, daily] of Object.entries(input.amount)) {
    if (daily <= 0 || made.has(ticker)) continue;
    const building = extractorOf(input.category[ticker] ?? "");
    bump(building, daily / (EXTRACTORS[building] * concentration * efficiency), true, [ticker]);
  }

  const info = new Map(input.buildings.map((b) => [b.Ticker, b]));
  const buildings: BuildingEstimate[] = [];
  for (const [ticker, a] of acc) {
    const b = info.get(ticker);
    buildings.push({
      ticker,
      name: b?.Name ?? "",
      kind: ticker in EXTRACTORS ? "extract" : "recipe",
      count: a.count,
      area: b?.AreaCost ?? 0,
      approx: a.approx,
      outputs: [...a.outputs].sort((x, y) => y[1] - x[1]).slice(0, 4)
        .map(([t, count]) => ({ ticker: t, count })),
    });
  }
  buildings.sort((a, b) => b.count - a.count);

  const byMaterial = new Map<string, RepairUse[]>();
  for (const est of buildings) {
    for (const cost of info.get(est.ticker)?.BuildingCosts ?? []) {
      if (!cost.Amount) continue;
      const use: RepairUse = {
        building: est.ticker, kind: est.kind, count: est.count, per_building: cost.Amount,
        monthly: est.count * cost.Amount / DEGRADE_DAYS * MONTH_DAYS,
      };
      if (!byMaterial.has(cost.CommodityTicker)) byMaterial.set(cost.CommodityTicker, []);
      byMaterial.get(cost.CommodityTicker)!.push(use);
    }
  }
  const materials: RepairMaterial[] = [];
  for (const [ticker, uses] of byMaterial) {
    uses.sort((a, b) => b.monthly - a.monthly);
    materials.push({
      ticker,
      category: input.category[ticker] ?? "",
      monthly: uses.reduce((s, u) => s + u.monthly, 0),
      monthly_production: (input.amount[ticker] ?? 0) * MONTH_DAYS,
      uses,
    });
  }
  materials.sort((a, b) => b.monthly - a.monthly);
  return { buildings, materials };
}
