/**
 * 路线编辑器的数据模型。三种文件，互相独立：
 *
 *   prun-route        一条路线的「抽象」配置：步骤里可以引用材料组、引用别的 waypoint 的装/卸内容
 *   prun-matgroup     一个材料组：{ticker: 数量}，数量是精确值
 *   prun-route-game   导出给游戏内脚本用的「展开」结果：每个步骤一种材料，字段名与游戏内部一致
 *                     （LOAD / UNLOAD / REFUEL / WAIT / LOAD_SHIPMENT / UNLOAD_SHIPMENT，
 *                      ABSOLUTE / CAPACITY，fuelUsageFactor …；2026-11 在游戏里实测核对）
 */

export type Op = "LOAD" | "UNLOAD";
export type AmountType = "ABSOLUTE" | "CAPACITY";
export interface Amount { type: AmountType; units: number }

export type FtlPreference = "LEAST_JUMPS" | "SHORTEST_FTL";
export type WaitUnit = "SECONDS" | "MINUTES" | "HOURS" | "DAYS";

interface StepBase { id: string }
/** 单种材料的装 / 卸，对应游戏里的一个步骤 */
export interface MaterialStep extends StepBase {
  kind: "material"; op: Op; ticker: string; min: Amount; max: Amount; retain: number;
}
/** 装 / 卸一个材料组：导出时每种材料一个步骤，最小 = 最大 = 组里的数量 */
export interface GroupStep extends StepBase { kind: "group"; op: Op; groupId: string; groupName: string }
/** 装 / 卸「另一个 waypoint 的装或卸的内容」 */
export interface MirrorStep extends StepBase {
  kind: "mirror"; op: Op; waypointId: string; sourceOp: Op;
}
export interface RefuelStep extends StepBase {
  kind: "refuel"; fuel: "STL" | "FTL"; source: "LOCAL_STORE" | "SHIP_STORE"; min: Amount; max: Amount;
}
/** 卸下货舱里的所有材料 */
export interface UnloadAllStep extends StepBase { kind: "unloadAll" }
/** 从油箱卸燃料到当地仓库；CAPACITY 在这里是「油箱里的全部」 */
export interface UnloadFuelStep extends StepBase {
  kind: "unloadFuel"; fuel: "STL" | "FTL"; min: Amount; max: Amount;
}
export interface WaitStep extends StepBase { kind: "wait"; amount: number; unit: WaitUnit }
export interface LoadShipmentStep extends StepBase { kind: "loadShipment" }
export interface UnloadShipmentStep extends StepBase { kind: "unloadShipment" }
export type ShipmentStep = LoadShipmentStep | UnloadShipmentStep;

export type Step =
  | MaterialStep | GroupStep | MirrorStep | UnloadAllStep | RefuelStep | UnloadFuelStep | WaitStep | ShipmentStep;
export type StepKind = Step["kind"];

export interface Destination {
  /** 星球编号（OT-580b）或空间站代码（MOR） */
  naturalId: string;
  /** 展示名；脚本在游戏里搜空间站时用它 */
  name: string;
}

export interface Waypoint {
  id: string;
  destination: Destination;
  /** 1–100 */
  fuelUsage: number;
  reactorUsage: number;
  ftlPreference: FtlPreference;
  useGateways: boolean;
  steps: Step[];
  /** 画布上的位置 */
  x: number;
  y: number;
}

export interface RouteDoc {
  format: "prun-route";
  version: 1;
  id: string;
  name: string;
  repeats: boolean;
  /** 每一站都自动先卸运单、最后装运单（那一站自己已经写了对应步骤的除外） */
  autoShipments: boolean;
  waypoints: Waypoint[];
}

/** 「把某个基地补到 N 天」的材料组：数量由 FIO 的数据算出来，materials 是上次算的结果 */
export interface ResupplySpec {
  planet: string;
  planetName: string;
  /**
   * "days" = 补到 days 天；"cargo" = 把给定大小的货舱装满，天数由它反推；
   * "fill" = 由路线上的某一站「塞满」：和那一站装的别的补给组一起，分掉船舱扣掉其他货物后剩下的空间
   */
  mode?: "days" | "cargo" | "fill";
  days: number;
  /** cargo 模式下的货舱大小：载重 t、容积 m³ */
  cargoWeight?: number;
  cargoVolume?: number;
  /** cargo / fill 模式下算出来相当于补到几天 */
  fitDays?: number;
  /** fill 模式：在哪条路线的哪一站塞满 */
  fillAt?: { routeId: string; waypointId: string };
  includeLuxuries: boolean;
  /** 扣掉基地里已有的库存 */
  deductStock: boolean;
  /** 上次算的时间（毫秒时间戳），0 = 还没算过 */
  updatedAt: number;
}

export interface MaterialGroup {
  format: "prun-matgroup";
  version: 1;
  id: string;
  name: string;
  /** 从哪来的，只做展示 */
  origin: string;
  materials: Record<string, number>;
  /**
   * 被排除的材料：留在 materials 里（随时可以恢复），但装卸时不算。
   * 补给组重算后也记得；「装满货舱」的补给组会把腾出来的地方分给别的材料。
   */
  excluded?: string[];
  resupply?: ResupplySpec;
}

/** 一个材料组实际要装卸的内容：去掉被排除的和数量不是正数的 */
export function activeMaterials(g: MaterialGroup): Record<string, number> {
  const skip = new Set(g.excluded ?? []);
  return Object.fromEntries(Object.entries(g.materials).filter(([t, n]) => n > 0 && !skip.has(t)));
}

// ---- 导出给游戏的格式 ----

export type GameStep =
  | { type: "LOAD"; material: string; minimum: Amount; maximum: Amount; retain: number }
  | { type: "UNLOAD"; material: string; minimum: Amount; maximum: Amount }
  | { type: "UNLOAD_ALL" }
  | { type: "REFUEL"; fuel: "STL" | "FTL"; source: "LOCAL_STORE" | "SHIP_STORE"; minimum: Amount; maximum: Amount }
  | { type: "UNLOAD_FUEL"; fuel: "STL" | "FTL"; minimum: Amount; maximum: Amount }
  | { type: "WAIT"; amount: number; unit: WaitUnit }
  | { type: "LOAD_SHIPMENT" }
  | { type: "UNLOAD_SHIPMENT" };

export interface GameWaypoint {
  destination: Destination;
  fuelUsageFactor: number;
  reactorUsageFactor: number;
  preferences: { ftlPreference: FtlPreference; useGateways: boolean };
  steps: GameStep[];
}

export interface GameRoute {
  format: "prun-route-game";
  version: 1;
  name: string;
  repeats: boolean;
  waypoints: GameWaypoint[];
}

// ---- 工厂 ----

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export const abs = (units: number): Amount => ({ type: "ABSOLUTE", units });
export const cap = (): Amount => ({ type: "CAPACITY", units: 0 });

/** 新步骤的初值与游戏里点「添加」后的默认值一致，这样没改过的步骤脚本不用再进编辑表单 */
export function newStep(kind: StepKind, op: Op = "LOAD"): Step {
  const id = newId();
  switch (kind) {
    case "material": return { id, kind, op, ticker: "DW", min: abs(1), max: abs(100), retain: 0 };
    case "group": return { id, kind, op, groupId: "", groupName: "" };
    case "mirror": return { id, kind, op, waypointId: "", sourceOp: op === "LOAD" ? "UNLOAD" : "LOAD" };
    case "refuel": return { id, kind, fuel: "STL", source: "LOCAL_STORE", min: abs(100), max: cap() };
    // 游戏在服务器端建新步骤，「卸燃料」的初值前端看不到，这里取「把这个油箱卸空」
    case "unloadFuel": return { id, kind, fuel: "STL", min: abs(0), max: cap() };
    case "wait": return { id, kind, amount: 1, unit: "MINUTES" };
    case "loadShipment": return { id, kind };
    default: return { id, kind };
  }
}

/** 燃料 / 反应堆用量：游戏里是 1 到 100 的整数，不能更低；空着或不是数字时用默认值 */
export function clampPercent(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return v === "" || v == null || !Number.isFinite(n) ? fallback : Math.min(100, Math.max(1, n));
}

export function newWaypoint(x = 40, y = 40): Waypoint {
  return {
    id: newId(), destination: { naturalId: "", name: "" },
    fuelUsage: 25, reactorUsage: 50, ftlPreference: "LEAST_JUMPS", useGateways: true,
    steps: [], x, y,
  };
}

export function newRoute(name = "新路线"): RouteDoc {
  return { format: "prun-route", version: 1, id: newId(), name, repeats: false, autoShipments: false, waypoints: [] };
}

export function newGroup(name: string, materials: Record<string, number> = {}, origin = "手动"): MaterialGroup {
  return { format: "prun-matgroup", version: 1, id: newId(), name, origin, materials };
}

export function destinationLabel(d: Destination): string {
  if (!d.naturalId) return "未设置目的地";
  return d.name && d.name !== d.naturalId ? `${d.name} (${d.naturalId})` : d.naturalId;
}
