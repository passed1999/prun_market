/** 基地层面的通用规则：效率加成、农田肥力、环境附加建材、住房配置。 */
import type { FertilePlanet } from "../data/sources";

/** CoGC 项目与建筑专业对口 */
export const COGC_FACTOR = 1.25;
/** 下标 = 对口专家人数 */
export const EXPERT_FACTORS = [1, 1.0306, 1.0696, 1.1248, 1.1974, 1.284];

/** 产量受星球肥力影响的建筑 */
export const FERTILITY_BUILDINGS = ["FRM", "ORC"];

/** FIO 的 Fertility（-1 = 不能种）→ 效率系数：0.4 → 112.12% */
export function fertilityFactor(fertility: number): number {
  return 1 + fertility * 10 / 33;
}

/** 有肥力的星球都是岩石地表、温度与重力适中，只会用到地表与低压两种附加建材 */
export function environmentCosts(area: number, planet: FertilePlanet): Record<string, number> {
  const out: Record<string, number> = { MCG: area * 4 };
  if (planet.pressure < 0.25) out.SEA = area;
  return out;
}

/** 单级住房：每座住 100 人，下标与 LEVELS 对应 */
const SINGLE_HOUSING = ["HB1", "HB2", "HB3", "HB4", "HB5"];
const SINGLE_CAPACITY = 100;
/** 两级合住：相邻两级各住 75 人。[建筑, 低的那一级的下标]，按省地多少排（HBL 省得最多）*/
const MIXED_HOUSING: [string, number][] = [["HBL", 3], ["HBM", 2], ["HBC", 1], ["HBB", 0]];
const MIXED_CAPACITY = 75;

/** 各级工人数（下标同 LEVELS）→ 占地最小的住房配置（座数可为小数）。相邻两级能配对的都合住，从高级往低级配 */
export function housingFor(workers: number[]): { ticker: string; count: number }[] {
  const left = [...workers];
  const out: { ticker: string; count: number }[] = [];
  for (const [ticker, low] of MIXED_HOUSING) {
    const paired = Math.min(left[low], left[low + 1]);
    if (paired <= 0) continue;
    left[low] -= paired;
    left[low + 1] -= paired;
    out.push({ ticker, count: paired / MIXED_CAPACITY });
  }
  left.forEach((n, i) => {
    if (n > 1e-9) out.push({ ticker: SINGLE_HOUSING[i], count: n / SINGLE_CAPACITY });
  });
  return out;
}

/**
 * 同上，但座数只能是整数：住得下所有人、占地最小的组合。
 * 第 i 级的人住在「i-1 与 i 合住」「i 与 i+1 合住」和单级住房里，所以沿级别做动态规划，
 * 状态是 i 与 i+1 合住的座数。
 */
export function wholeHousingFor(workers: number[], areaOf: (ticker: string) => number): { ticker: string; count: number }[] {
  const mixedAt = (low: number) => MIXED_HOUSING.find(([, l]) => l === low)![0];
  const last = workers.length - 1;
  // range[i]：i 与 i+1 合住最多值得建几座
  const range = workers.map((w, i) => i === last ? 0
    : Math.min(400, Math.ceil(Math.max(w, workers[i + 1]) / MIXED_CAPACITY - 1e-9)));
  let prev: { cost: number; mixed: number[]; single: number[] }[] = [{ cost: 0, mixed: [], single: [] }];
  for (let i = 0; i <= last; i++) {
    const next: typeof prev = [];
    for (let b = 0; b <= range[i]; b++) {
      let best: (typeof prev)[number] | null = null;
      for (let a = 0; a < prev.length; a++) {
        const uncovered = workers[i] - MIXED_CAPACITY * (a + b);
        const single = uncovered > 1e-9 ? Math.ceil(uncovered / SINGLE_CAPACITY - 1e-9) : 0;
        const cost = prev[a].cost + single * areaOf(SINGLE_HOUSING[i]) + (b ? b * areaOf(mixedAt(i)) : 0);
        if (!best || cost < best.cost) {
          best = { cost, mixed: [...prev[a].mixed, b], single: [...prev[a].single, single] };
        }
      }
      next.push(best!);
    }
    prev = next;
  }
  const { mixed, single } = prev[0];
  const out: { ticker: string; count: number }[] = [];
  for (const [ticker, low] of MIXED_HOUSING) if (mixed[low]) out.push({ ticker, count: mixed[low] });
  single.forEach((n, i) => { if (n) out.push({ ticker: SINGLE_HOUSING[i], count: n }); });
  return out;
}
