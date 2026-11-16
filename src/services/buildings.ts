/**
 * 由每月全服产量反推建筑数量，再按「每日衰减」口径算建材的维修消耗。
 *
 *     建筑数量(B)   = Σ B 的每条配方每天跑的轮数 × 每轮耗时(天) ÷ 平均效率
 *     月维修消耗(T) = Σ 建筑数量(B) × B 的建造用量(T) ÷ 180 × 30
 *
 * 每条配方每天跑多少轮由产出反推，尽量只用该配方独占的产出（见 market.solveRuns）。
 * 维修口径：建筑满 180 天折旧完，维修用量与距上次维修的天数成正比，所以不管多久修一次，
 * 摊到每天都是「建造用量 ÷ 180」。
 *
 * 采集建筑（EXT / COL / RIG）没有配方，分两步估：
 *   1. 同一种资源在不同星球上是固态 / 液态 / 气态，对应不同建筑，浓度差得很远。每种形态取全宇宙浓度
 *      最高的前 N 颗星球的平均浓度，假定玩家都去「每个拓荒者产得最多」的那种形态上采；
 *   2. 采集建筑只雇拓荒者。全服拓荒者总数（由必需品消费反推，见 market.estimateDemand）减去配方建筑
 *      用掉的，剩下的就是采集建筑的用工，按这个余量把第 1 步的座数等比例校准。
 * 第 1 步定各资源、各建筑之间的比例，第 2 步定总量。
 *
 * 算不到的部分：
 *   - 同一资源在各形态之间的实际分布没有公开数据，只能假定全在人均产量最高的那种上；
 *   - 住房、仓库、核心模块与星球设施不折损效率，没人维修，也无从由产量反推，不计入；
 *   - 星球环境附加建材（MCG / SEA / INS 等）因星球而异，不在建造用量里；
 *   - 新建与扩建的一次性消耗不是维修，不计入。
 */
import { fio, stats } from "../data/sources";
import type { PlanetResources, ResourceForm } from "../data/sources";
import type { FioBuilding, FioRecipe } from "../api/types";
import { estimateDemand, gameRef, monthLabel, resolveMonth, solveRuns } from "./market";

const DAY_MS = 86_400_000;
/** 建筑从全新到完全折旧的天数 */
export const DEGRADE_DAYS = 180;
/** 月报里的量是日均值，月消耗统一按 30 天折算 */
export const MONTH_DAYS = 30;

/** 资源形态 → 采集建筑，以及它在浓度 100% 的资源上每天的产量（效率 100% 时）*/
const EXTRACTORS: Record<ResourceForm, { building: string; daily: number }> = {
  MINERAL: { building: "EXT", daily: 70 },
  GASEOUS: { building: "COL", daily: 60 },
  LIQUID: { building: "RIG", daily: 70 },
};
const EXTRACTOR_BUILDINGS = new Set(Object.values(EXTRACTORS).map((e) => e.building));

/** 人口级别（market 的口径）→ FIO 建筑表里的用工字段 */
const LEVEL_FIELDS = [
  ["PIONEER", "Pioneers"], ["SETTLER", "Settlers"], ["TECHNICIAN", "Technicians"],
  ["ENGINEER", "Engineers"], ["SCIENTIST", "Scientists"],
] as const;

export interface BuildingInputs {
  month: string;
  label: string;
  months: string[];
  amount: Record<string, number>;
  category: Record<string, string>;
  recipes: FioRecipe[];
  buildings: FioBuilding[];
  resources: PlanetResources;
  /** 全服各级工人数（由必需品消费反推）*/
  population: Record<string, number>;
}

export interface BuildingOptions {
  /** 全服平均生产效率，1 = 100% */
  efficiency: number;
  /** 每种资源形态取浓度最高的前几颗星球 */
  topPlanets: number;
  /** 按拓荒者余量校准采集建筑总量 */
  calibrate: boolean;
}

/** recipe 由配方反推；extract 是由星球浓度与拓荒者余量估的采集建筑 */
export type BuildingKind = "recipe" | "extract";

export interface BuildingOutput {
  ticker: string;
  count: number;
  /** 采集建筑：假定的资源浓度（0–1）*/
  concentration?: number;
}

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
  outputs: BuildingOutput[];
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

export interface WorkforceBalance {
  level: string;
  /** 由必需品消费反推的全服人数 */
  population: number;
  /** 估出来的建筑一共要雇多少 */
  need: number;
}

export interface ExtractionCheck {
  /** 拓荒者总数减去配方建筑用掉的 */
  available: number;
  /** 按星球浓度直接算出的采集建筑要雇多少拓荒者（校准前）*/
  needed: number;
  /** 实际乘到采集座数上的系数；没校准时是 1 */
  scale: number;
  /** 校准没生效的原因 */
  skipped: "" | "off" | "no-pioneers";
}

export interface BuildingReport {
  buildings: BuildingEstimate[];
  materials: RepairMaterial[];
  workforce: WorkforceBalance[];
  extraction: ExtractionCheck;
}

export async function loadInputs(month?: string, force = false): Promise<BuildingInputs> {
  const [picked, months] = await resolveMonth(month, force);
  const [production, ref, buildings, resources] = await Promise.all([
    stats.production(picked, force), gameRef(), fio.buildings(), fio.planetResources(),
  ]);
  const amount: Record<string, number> = {};
  for (const [t, v] of Object.entries(production)) amount[t] = Number(v.amount) || 0;
  return {
    month: picked, label: monthLabel(picked), months, amount,
    category: ref.category, recipes: ref.recipes, buildings, resources,
    population: estimateDemand(amount, ref).population,
  };
}

/** 这种资源去哪种形态上采：前 N 颗星球的平均浓度下，每个拓荒者每天产得最多的那种 */
function bestForm(forms: PlanetResources[string], topPlanets: number, info: Map<string, FioBuilding>) {
  let best: { building: string; concentration: number; daily: number; perPioneer: number } | null = null;
  for (const [form, factors] of Object.entries(forms) as [ResourceForm, number[]][]) {
    const top = factors.slice(0, Math.max(1, topPlanets));
    if (!top.length) continue;
    const concentration = top.reduce((s, f) => s + f, 0) / top.length;
    const { building, daily } = EXTRACTORS[form];
    const perPioneer = concentration * daily / (info.get(building)?.Pioneers || 1);
    if (!best || perPioneer > best.perPioneer) {
      best = { building, concentration, daily: concentration * daily, perPioneer };
    }
  }
  return best;
}

export function compute(input: BuildingInputs, options: BuildingOptions): BuildingReport {
  const efficiency = options.efficiency > 0 ? options.efficiency : 1;
  const info = new Map(input.buildings.map((b) => [b.Ticker, b]));

  interface Acc { count: number; approx: boolean; outputs: Map<string, BuildingOutput> }
  const acc = new Map<string, Acc>();
  const bump = (building: string, count: number, approx: boolean, outputs: string[], concentration?: number) => {
    let a = acc.get(building);
    if (!a) acc.set(building, a = { count: 0, approx: false, outputs: new Map() });
    a.count += count;
    a.approx ||= approx;
    for (const t of outputs) {
      const o = a.outputs.get(t) ?? { ticker: t, count: 0, concentration };
      o.count += count / outputs.length;
      a.outputs.set(t, o);
    }
  };

  const made = new Set<string>();
  for (const recipe of input.recipes) for (const o of recipe.Outputs ?? []) if (o.Amount) made.add(o.Ticker);

  // 配方没解释掉的产量
  const residual: Record<string, number> = { ...input.amount };
  let recipePioneers = 0;
  for (const { recipe, outputs, runs, approx } of solveRuns(input.amount, input.recipes)) {
    const count = runs * (recipe.TimeMs / DAY_MS) / efficiency;
    // 座数记在决定轮数的产出上，副产物不占座
    bump(recipe.BuildingTicker, count, approx, outputs.filter((o) => o.key).map((o) => o.ticker));
    recipePioneers += count * (info.get(recipe.BuildingTicker)?.Pioneers ?? 0);
    for (const o of outputs) residual[o.ticker] = (residual[o.ticker] ?? 0) - runs * o.perRun;
  }

  // 采出来的量：没有任何配方产出的全算；既能采又是副产物的（如 O），只算配方解释不掉的那部分
  const extracts: { ticker: string; building: string; concentration: number; count: number }[] = [];
  let needed = 0;
  for (const [ticker, forms] of Object.entries(input.resources)) {
    const daily = input.amount[ticker] ?? 0;
    const extracted = made.has(ticker) ? residual[ticker] ?? 0 : daily;
    if (daily <= 0 || extracted < daily * 0.005) continue;
    const best = bestForm(forms, options.topPlanets, info);
    if (!best) continue;
    const count = extracted / (best.daily * efficiency);
    extracts.push({ ticker, building: best.building, concentration: best.concentration, count });
    needed += count * (info.get(best.building)?.Pioneers ?? 0);
  }

  const available = (input.population.PIONEER ?? 0) - recipePioneers;
  const extraction: ExtractionCheck = { available, needed, scale: 1, skipped: "" };
  if (!options.calibrate) extraction.skipped = "off";
  else if (available <= 0 || needed <= 0) extraction.skipped = "no-pioneers";
  else extraction.scale = available / needed;
  for (const e of extracts) {
    // 校准等价于把假定的浓度整体除以这个系数
    bump(e.building, e.count * extraction.scale, true, [e.ticker], e.concentration / extraction.scale);
  }

  const buildings: BuildingEstimate[] = [];
  for (const [ticker, a] of acc) {
    const b = info.get(ticker);
    buildings.push({
      ticker,
      name: b?.Name ?? "",
      kind: EXTRACTOR_BUILDINGS.has(ticker) ? "extract" : "recipe",
      count: a.count,
      area: b?.AreaCost ?? 0,
      approx: a.approx,
      outputs: [...a.outputs.values()].sort((x, y) => y.count - x.count).slice(0, 4),
    });
  }
  buildings.sort((a, b) => b.count - a.count);

  const workforce: WorkforceBalance[] = LEVEL_FIELDS.map(([level, field]) => ({
    level,
    population: input.population[level] ?? 0,
    need: buildings.reduce((s, est) => s + est.count * (info.get(est.ticker)?.[field] ?? 0), 0),
  }));

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
  return { buildings, materials, workforce, extraction };
}
