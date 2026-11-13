/**
 * 为路线生成「只采购」的 XIT ACT 包：把在空间站装货的东西按交易所汇总，
 * 每个交易所一个 Manual 组 + 一个 CX Buy 动作，不带转运（MTRA）——货买到后就在站上的仓库里，
 * 船到站时由路线自己的装货步骤装走。
 *
 * 包的格式与 PMMG-Extended / Refined PrUn 的 XIT ACT 一致：顶层 global / groups / actions 三项必填，
 * CX Buy 的 group 引用 groups 里的 name，exchange 是 AI1 | CI1 | CI2 | IC1 | NC1 | NC2。
 * 包里出现的名字与说明一律只用英文字母、数字、连字符（"CX Buy" / "Manual" 是格式规定的关键字）。
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

/**
 * 包里所有的名字只用英文字母、数字和连字符：游戏里的插件遇到别的字符（中文、空格、下划线等）会出问题。
 * 路线名里其余的字符换成连字符，全是中文时退回一个固定的名字。
 */
function ascii(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
      global: { name: `buy-${ascii(game.name) || "route"}`.slice(0, 60), description: "buy-only-no-transfer" },
      groups: byExchange.map((e) => ({ type: "Manual", name: `buy-${e.exchange}`, materials: e.materials })),
      // useCXInv：站上仓库里已有的先扣掉，只买差额；buyPartial 关：挂单簿不够就停下，不买一半
      actions: byExchange.map((e) => ({
        type: "CX Buy", name: `cx-buy-${e.exchange}`, group: `buy-${e.exchange}`, exchange: e.exchange,
        useCXInv: true, buyPartial: false,
      })),
    },
    byExchange,
    open: [...open],
  };
}
