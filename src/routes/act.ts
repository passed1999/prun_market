/**
 * 为路线生成「只采购」的 XIT ACT 包：把在空间站装货的东西按交易所汇总，
 * 每个交易所一个 Manual 组 + 一个 CX Buy 动作，不带转运（MTRA）——货买到后就在站上的仓库里，
 * 船到站时由路线自己的装货步骤装走。
 *
 * 包的格式与 PMMG-Extended / Refined PrUn 的 XIT ACT 一致：顶层 global / groups / actions 三项必填，
 * CX Buy 的 group 引用 groups 里的 name，exchange 是 AI1 | CI1 | CI2 | IC1 | NC1 | NC2。
 */
import type { FioStation } from "../api/types";
import type { GameRoute } from "./model";

export interface BuyPlan {
  /** 导入游戏用的包；没有任何要买的东西时为 null */
  pack: {
    global: { name: string; description: string };
    groups: { type: "Manual"; name: string; materials: Record<string, number> }[];
    actions: { type: "CX Buy"; name: string; group: string; exchange: string; useCXInv: boolean; buyPartial: boolean }[];
  } | null;
  /** 每个交易所买些什么，给提示用 */
  byExchange: { exchange: string; station: string; materials: Record<string, number> }[];
  /** 在空间站「装到满」的材料：没有确切数量，没法写进采购单 */
  open: string[];
}

export function buildBuyPlan(game: GameRoute, stations: FioStation[]): BuyPlan {
  const byId = new Map(stations.map((s) => [s.NaturalId, s]));
  const totals = new Map<string, { station: string; materials: Record<string, number> }>();
  const open = new Set<string>();

  for (const wp of game.waypoints) {
    const station = byId.get(wp.destination.naturalId.trim().toUpperCase());
    if (!station) continue;
    for (const step of wp.steps) {
      if (step.type !== "LOAD") continue;
      if (step.maximum.type === "CAPACITY") { open.add(step.material); continue; }
      if (step.maximum.units <= 0) continue;
      const entry = totals.get(station.ComexCode) ?? { station: station.Name, materials: {} };
      entry.materials[step.material] = (entry.materials[step.material] ?? 0) + step.maximum.units;
      totals.set(station.ComexCode, entry);
    }
  }

  const byExchange = [...totals].map(([exchange, v]) => ({ exchange, ...v }));
  if (!byExchange.length) return { pack: null, byExchange, open: [...open] };
  return {
    pack: {
      global: { name: `采购 ${game.name || "路线"}`.slice(0, 60), description: "由路线编辑器生成：只在交易所采购，不转运" },
      groups: byExchange.map((e) => ({ type: "Manual", name: `buy ${e.exchange}`, materials: e.materials })),
      // useCXInv：站上仓库里已有的先扣掉，只买差额；buyPartial 关：挂单簿不够就停下，不买一半
      actions: byExchange.map((e) => ({
        type: "CX Buy", name: `在 ${e.exchange} 采购`, group: `buy ${e.exchange}`, exchange: e.exchange,
        useCXInv: true, buyPartial: false,
      })),
    },
    byExchange,
    open: [...open],
  };
}
