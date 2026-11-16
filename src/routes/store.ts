/**
 * 编辑器的工作区：打开着的路线与材料组，记在浏览器里，刷新后还在。
 * 正式的保存是把每条路线、每个材料组各自存成一个文件（见 io.ts）；这里只是防丢。
 */
import { reactive, watch } from "vue";

import type { MaterialGroup, RouteDoc } from "./model";
import { newRoute } from "./model";
import type { ShipSpec } from "./flight";
import type { GatewayLink } from "./gateways";

const KEY = "prun-market.routes.workspace";

interface Workspace {
  routes: RouteDoc[];
  groups: MaterialGroup[];
  activeRouteId: string;
  shipWeight: number | null;
  shipVolume: number | null;
  mergeAdjacent: boolean;
  /** 从游戏里复制来的船只参数；shipName 是当前用来估时间的那艘 */
  ships: ShipSpec[];
  shipName: string;
  /** 估算时启航的 STL 燃料；null = 满油箱 */
  startFuel: number | null;
  /** 估算时燃料逐段递减（后一段按前一段剩下的算） */
  fuelCarry: boolean;
  /** 从游戏里导出的星门清单；空 = 用内置的那份快照 */
  gateways: GatewayLink[];
  gatewaysAt: number;
}

function load(): Workspace {
  const empty: Workspace = {
    routes: [], groups: [], activeRouteId: "", shipWeight: null, shipVolume: null, mergeAdjacent: false,
    ships: [], shipName: "", startFuel: null, fuelCarry: true, gateways: [], gatewaysAt: 0,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.routes) && Array.isArray(saved.groups)) return { ...empty, ...saved };
    }
  } catch { /* 存坏了或隐私模式：当作空的 */ }
  return empty;
}

export const workspace = reactive<Workspace>(load());

if (!workspace.routes.length) {
  const first = newRoute();
  workspace.routes.push(first);
  workspace.activeRouteId = first.id;
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(workspace, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(workspace)); } catch { /* 存不下就算了 */ }
  }, 300);
}, { deep: true });

/** 同 id 的替换（重新载入同一个文件），否则追加 */
export function upsertRoute(route: RouteDoc) {
  const i = workspace.routes.findIndex((r) => r.id === route.id);
  if (i >= 0) workspace.routes[i] = route;
  else workspace.routes.push(route);
  workspace.activeRouteId = route.id;
}

/**
 * 载入一批材料组，返回覆盖了几个已有的。
 * 同 id 的直接替换；id 对不上（ACT 包每次导入 id 都是新的）但原来恰好有一个同名的，
 * 就覆盖那一个并沿用它的 id，路线里的引用不会断。只跟载入前就有的组比名字，同一批里重名的各自保留。
 */
export function upsertGroups(groups: MaterialGroup[]): number {
  const before = [...workspace.groups];
  let replaced = 0;
  for (const group of groups) {
    let i = workspace.groups.findIndex((g) => g.id === group.id);
    if (i < 0) {
      const same = before.filter((g) => g.name === group.name);
      if (same.length === 1) {
        before.splice(before.indexOf(same[0]), 1);
        group.id = same[0].id;
        i = workspace.groups.findIndex((g) => g.id === group.id);
      }
    }
    if (i >= 0) { workspace.groups[i] = group; replaced++; }
    else workspace.groups.push(group);
  }
  return replaced;
}

/**
 * 路线里的材料组步骤靠 id 找组；从 ACT 包重新导入的组 id 是新的，这时按名字接回去。
 * 路线或材料组任何一边新载入后都跑一遍。
 */
export function relinkGroups() {
  const byId = new Set(workspace.groups.map((g) => g.id));
  for (const route of workspace.routes) {
    for (const wp of route.waypoints) {
      for (const step of wp.steps) {
        if (step.kind !== "group" || byId.has(step.groupId)) continue;
        const match = workspace.groups.find((g) => g.name === step.groupName);
        if (match) step.groupId = match.id;
      }
    }
  }
}
