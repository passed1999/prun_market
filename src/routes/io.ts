/** 文件的读入与写出：路线、材料组、XIT ACT 包、导出给游戏的展开结果。 */
import type { Amount, GameRoute, MaterialGroup, RouteDoc, Step, Waypoint } from "./model";
import { abs, cap, newGroup, newId, newWaypoint } from "./model";
import type { ShipSpec } from "./flight";
import type { GatewayLink } from "./gateways";

export class ImportError extends Error {}

export type Imported =
  | { kind: "ships"; ships: ShipSpec[]; gateways: GatewayLink[] }
  | { kind: "route"; route: RouteDoc }
  | { kind: "groups"; groups: MaterialGroup[]; skipped: string[] };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanMaterials(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const [ticker, n] of Object.entries(raw)) {
    const qty = Math.round(Number(n));
    const key = ticker.trim().toUpperCase();
    if (key && Number.isFinite(qty) && qty > 0) out[key] = (out[key] ?? 0) + qty;
  }
  return out;
}

/**
 * 认四种文件：本工具的路线、本工具的材料组、导出给游戏的展开结果、XIT ACT 包。
 * ACT 包（rprun 与 planner 导出的是同一种格式）只取 Manual 组里的材料；
 * Resupply / Repair 组的数量是插件在游戏里现算的，文件里没有，只能跳过。
 */
export function parseFile(text: string, fileName: string): Imported {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError(`「${fileName}」不是合法的 JSON。`);
  }
  if (!isObj(data)) throw new ImportError(`「${fileName}」里没有可用的内容。`);

  if (data.format === "prun-ships") {
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const ships = (Array.isArray(data.ships) ? data.ships : []).filter(isObj).map((s): ShipSpec => ({
      name: String(s.name ?? "未命名"),
      emptyMass: num(s.emptyMass), thrust: num(s.thrust), flowRate: num(s.flowRate),
      stlCapacity: num(s.stlCapacity), ftlCapacity: num(s.ftlCapacity),
      cargoWeight: num(s.cargoWeight), cargoVolume: num(s.cargoVolume), volume: num(s.volume),
      ftlMaxSpeed: num(s.ftlMaxSpeed), chargeTime: num(s.chargeTime), overchargeTime: num(s.overchargeTime),
      minReactor: num(s.minReactor) || 1, reactorPower: num(s.reactorPower),
    })).filter((s) => s.emptyMass > 0 && s.thrust > 0 && s.flowRate > 0);
    if (!ships.length) throw new ImportError(`「${fileName}」里没有可用的船只参数。`);
    const planet = /^[A-Z]{2}-\d{3}[a-z]$/;
    const gateways = (Array.isArray(data.gateways) ? data.gateways : []).filter(isObj)
      .map((g): GatewayLink => ({ from: String(g.from ?? ""), to: String(g.to ?? ""), maxVolume: num(g.maxVolume) }))
      .filter((g) => planet.test(g.from) && planet.test(g.to));
    return { kind: "ships", ships, gateways };
  }
  if (data.format === "prun-route") return { kind: "route", route: normalizeRoute(data) };
  if (data.format === "prun-route-game") return { kind: "route", route: fromGame(data as unknown as GameRoute) };
  if (data.format === "prun-matgroup") {
    const g = newGroup(String(data.name ?? fileName), cleanMaterials(data.materials), String(data.origin ?? "文件"));
    if (typeof data.id === "string" && data.id) g.id = data.id;
    if (isObj(data.resupply) && typeof data.resupply.planet === "string") {
      const r = data.resupply;
      g.resupply = {
        planet: String(r.planet), planetName: String(r.planetName ?? ""),
        days: Math.max(1, Number(r.days) || 30),
        mode: r.mode === "cargo" ? "cargo" : "days",
        cargoWeight: Number(r.cargoWeight) || undefined, cargoVolume: Number(r.cargoVolume) || undefined,
        fitDays: Number(r.fitDays) || undefined,
        includeLuxuries: r.includeLuxuries !== false, deductStock: r.deductStock !== false,
        updatedAt: Number(r.updatedAt) || 0,
      };
    }
    return { kind: "groups", groups: [g], skipped: [] };
  }
  if (Array.isArray(data.groups)) {
    const pack = isObj(data.global) && typeof data.global.name === "string" ? data.global.name : fileName.replace(/\.json$/i, "");
    const groups: MaterialGroup[] = [];
    const skipped: string[] = [];
    for (const raw of data.groups) {
      if (!isObj(raw)) continue;
      const name = String(raw.name ?? "未命名");
      const materials = cleanMaterials(raw.materials);
      if (!Object.keys(materials).length) {
        skipped.push(`${name}（${String(raw.type ?? "未知类型")}）`);
        continue;
      }
      const single = data.groups.length === 1;
      groups.push(newGroup(single ? pack : `${pack} / ${name}`, materials, `ACT 包「${pack}」`));
    }
    if (!groups.length && !skipped.length) throw new ImportError(`「${fileName}」里没有材料组。`);
    return { kind: "groups", groups, skipped };
  }
  throw new ImportError(`认不出「${fileName}」是什么文件。`);
}

function amount(raw: unknown, fallback: Amount): Amount {
  if (!isObj(raw)) return fallback;
  if (raw.type === "CAPACITY") return cap();
  const n = Math.round(Number(raw.units));
  return abs(Number.isFinite(n) && n >= 0 ? n : fallback.units);
}

const pct = (v: unknown, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : d;
};

/** 读回自己存的路线：缺字段补默认，id 保留（引用靠它） */
function normalizeRoute(data: Json): RouteDoc {
  const waypoints: Waypoint[] = (Array.isArray(data.waypoints) ? data.waypoints : []).filter(isObj).map((w, i) => {
    const base = newWaypoint(40 + i * 400, 40);
    const dest = isObj(w.destination) ? w.destination : {};
    return {
      ...base,
      id: typeof w.id === "string" && w.id ? w.id : base.id,
      destination: { naturalId: String(dest.naturalId ?? ""), name: String(dest.name ?? "") },
      fuelUsage: pct(w.fuelUsage, 25),
      reactorUsage: pct(w.reactorUsage, 50),
      ftlPreference: w.ftlPreference === "SHORTEST_FTL" ? "SHORTEST_FTL" : "LEAST_JUMPS",
      useGateways: w.useGateways !== false,
      x: Number.isFinite(Number(w.x)) ? Number(w.x) : base.x,
      y: Number.isFinite(Number(w.y)) ? Number(w.y) : base.y,
      steps: (Array.isArray(w.steps) ? w.steps : []).filter(isObj).map(normalizeStep).filter((s): s is Step => !!s),
    };
  });
  return {
    format: "prun-route", version: 1,
    id: typeof data.id === "string" && data.id ? data.id : newId(),
    name: String(data.name ?? "未命名路线"),
    repeats: data.repeats === true,
    autoShipments: data.autoShipments === true,
    waypoints,
  };
}

function normalizeStep(s: Json): Step | null {
  const id = typeof s.id === "string" && s.id ? s.id : newId();
  const op = s.op === "UNLOAD" ? "UNLOAD" : "LOAD";
  switch (s.kind) {
    case "material":
      return { id, kind: "material", op, ticker: String(s.ticker ?? "").toUpperCase(),
               min: amount(s.min, abs(1)), max: amount(s.max, abs(100)),
               retain: Math.max(0, Math.round(Number(s.retain)) || 0) };
    case "group":
      return { id, kind: "group", op, groupId: String(s.groupId ?? ""), groupName: String(s.groupName ?? "") };
    case "mirror":
      return { id, kind: "mirror", op, waypointId: String(s.waypointId ?? ""),
               sourceOp: s.sourceOp === "UNLOAD" ? "UNLOAD" : "LOAD" };
    case "refuel":
      return { id, kind: "refuel", fuel: s.fuel === "FTL" ? "FTL" : "STL",
               source: s.source === "SHIP_STORE" ? "SHIP_STORE" : "LOCAL_STORE",
               min: amount(s.min, abs(100)), max: amount(s.max, cap()) };
    case "wait": {
      const units = ["SECONDS", "MINUTES", "HOURS", "DAYS"] as const;
      const unit = units.find((u) => u === s.unit) ?? "MINUTES";
      return { id, kind: "wait", amount: Math.max(0, Number(s.amount) || 0), unit };
    }
    case "loadShipment":
    case "unloadShipment":
      return { id, kind: s.kind };
    default:
      return null;
  }
}

/** 展开结果读回来只能得到逐材料的步骤，材料组与引用的信息已经不在了 */
function fromGame(game: GameRoute): RouteDoc {
  const waypoints: Waypoint[] = (game.waypoints ?? []).map((w, i) => {
    const wp = newWaypoint(40 + i * 400, 40);
    wp.destination = { naturalId: w.destination?.naturalId ?? "", name: w.destination?.name ?? "" };
    wp.fuelUsage = pct((w.fuelUsageFactor ?? 0.25) * 100, 25);
    wp.reactorUsage = pct((w.reactorUsageFactor ?? 0.5) * 100, 50);
    wp.ftlPreference = w.preferences?.ftlPreference === "SHORTEST_FTL" ? "SHORTEST_FTL" : "LEAST_JUMPS";
    wp.useGateways = w.preferences?.useGateways !== false;
    wp.steps = (w.steps ?? []).map((s): Step | null => {
      const id = newId();
      switch (s.type) {
        case "LOAD":
          return { id, kind: "material", op: "LOAD", ticker: s.material, min: s.minimum, max: s.maximum, retain: s.retain ?? 0 };
        case "UNLOAD":
          return { id, kind: "material", op: "UNLOAD", ticker: s.material, min: s.minimum, max: s.maximum, retain: 0 };
        case "REFUEL":
          return { id, kind: "refuel", fuel: s.fuel, source: s.source, min: s.minimum, max: s.maximum };
        case "WAIT":
          return { id, kind: "wait", amount: s.amount, unit: s.unit };
        case "LOAD_SHIPMENT": return { id, kind: "loadShipment" };
        case "UNLOAD_SHIPMENT": return { id, kind: "unloadShipment" };
        default: return null;
      }
    }).filter((s): s is Step => !!s);
    return wp;
  });
  return { format: "prun-route", version: 1, id: newId(), name: game.name || "导入的路线", repeats: !!game.repeats,
           autoShipments: false, waypoints };
}

export function safeName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "untitled";
}

export const toText = (data: unknown) => JSON.stringify(data, null, 2) + "\n";

/** 复制到剪贴板；浏览器不让用剪贴板接口时退回老办法 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

export function download(fileName: string, data: unknown) {
  const blob = new Blob([toText(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
