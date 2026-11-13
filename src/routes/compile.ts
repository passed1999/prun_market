/**
 * 把「抽象」路线展开成游戏里的逐材料步骤，并顺带做检查。
 *
 * 展开规则：
 *   材料组        每种材料一个步骤，最小 = 最大 = 组里的数量（精确值，装不够 / 卸不够就等）
 *   引用          取被引用 waypoint 里所有同类（装或卸）步骤展开后的内容，换成本步骤的方向；
 *                 数量照抄，「capacity」照抄（装 = 装到满，卸 = 船上全部）。
 *                 「装 ← 某站的卸货内容」会扣掉途中已经装上的部分，见 mirrorLines
 *   其余          一一对应
 *   自动运单      路线开了「每站自动装卸运单」时，每一站最前面加卸运单、最后面加装运单；
 *                 那一站自己已经有对应步骤的就不再加
 * 各步骤互相独立、按界面顺序输出，同一种材料出现多次不会合并（除非勾了「合并相邻」）。
 */
import type {
  Amount, GameRoute, GameStep, GameWaypoint, MaterialGroup, MirrorStep, Op, RouteDoc, Step, Waypoint,
} from "./model";
import { abs, destinationLabel } from "./model";

export interface Line { ticker: string; min: Amount; max: Amount; retain: number }

export interface Issue {
  level: "error" | "warn";
  waypointId?: string;
  stepId?: string;
  text: string;
}

export interface MaterialInfo { weight: number; volume: number }

export interface CompileOptions {
  mergeAdjacent?: boolean;
  /** 船的载重 / 容积；给了才做容量检查 */
  shipWeight?: number | null;
  shipVolume?: number | null;
  materials?: Record<string, MaterialInfo>;
}

export interface LegLoad { waypointId: string; weight: number; volume: number; exact: boolean }

export interface CompileResult {
  game: GameRoute;
  issues: Issue[];
  /** 每个 waypoint 的步骤跑完、离站时船上的货 */
  legs: LegLoad[];
  /** 脚本在游戏里大约要点多少下（每下一次服务器操作） */
  clicks: number;
}

type Groups = Record<string, MaterialGroup>;

class CycleError extends Error {}

/** 一个步骤展开成的材料行；非装卸步骤返回空 */
export function stepLines(route: RouteDoc, groups: Groups, step: Step, trail: string[] = []): Line[] {
  if (step.kind === "material") {
    return [{ ticker: step.ticker.trim().toUpperCase(), min: step.min, max: step.max, retain: step.retain }];
  }
  if (step.kind === "group") {
    const g = groups[step.groupId];
    if (!g) return [];
    return Object.entries(g.materials)
      .filter(([, n]) => n > 0)
      .map(([ticker, n]) => ({ ticker, min: abs(n), max: abs(n), retain: 0 }));
  }
  if (step.kind === "mirror") return mirrorLines(route, groups, step, trail).lines;
  return [];
}

export interface MirrorResult {
  lines: Line[];
  /** 因为途中已经装了而少装的数量；"all" = 途中有「装到满」，这里整种不装 */
  covered: Record<string, number | "all">;
}

/**
 * 引用步骤展开后的内容。
 *
 * 「在这里装 X 站要卸的东西」时，要扣掉到 X 之前船上已经会有的那部分，不然同一批货会装两遍：
 *   - 这一站自己另外写明要装的（单种材料、材料组）
 *   - 从这一站到 X 之间的各站装上来的
 *   途中各站卸掉的会先把这些「已有的」消耗掉——那是给它们自己用的，轮不到 X。
 * 只对「装货 ← 卸货内容」这一种引用做扣减；X 排在这一站前面且路线不循环时也不扣（那不是送货）。
 */
export function mirrorLines(route: RouteDoc, groups: Groups, step: MirrorStep, trail: string[] = []): MirrorResult {
  if (trail.includes(step.id)) throw new CycleError();
  const target = route.waypoints.find((w) => w.id === step.waypointId);
  if (!target) return { lines: [], covered: {} };
  const next = [...trail, step.id];
  const wanted = opLines(route, groups, target, step.sourceOp, next).map((l) => ({ ...l, retain: 0 }));
  if (step.op !== "LOAD" || step.sourceOp !== "UNLOAD") return { lines: wanted, covered: {} };

  const list = route.waypoints;
  const here = list.findIndex((w) => w.steps.some((s) => s.id === step.id));
  const there = list.indexOf(target);
  if (here < 0 || here === there || (there < here && !route.repeats)) return { lines: wanted, covered: {} };

  // 到 X 之前船上已有的：先算这一站自己写明装的，再顺着途中各站的步骤一步步加减
  const aboard: Record<string, number> = {};
  const open = new Set<string>();
  const apply = (op: Op, lines: Line[]) => {
    for (const l of lines) {
      if (op === "LOAD") {
        if (l.max.type === "CAPACITY") open.add(l.ticker);
        else aboard[l.ticker] = (aboard[l.ticker] ?? 0) + l.max.units;
      } else if (l.max.type === "CAPACITY") {
        aboard[l.ticker] = 0;
        open.delete(l.ticker);
      } else {
        aboard[l.ticker] = Math.max(0, (aboard[l.ticker] ?? 0) - l.max.units);
      }
    }
  };
  for (const s of list[here].steps) {
    if ((s.kind === "material" || s.kind === "group") && s.op === "LOAD") apply("LOAD", stepLines(route, groups, s, next));
  }
  for (let i = (here + 1) % list.length; i !== there; i = (i + 1) % list.length) {
    for (const s of list[i].steps) {
      if (s.kind === "material" || s.kind === "group" || s.kind === "mirror") apply(s.op, stepLines(route, groups, s, next));
    }
  }

  const covered: MirrorResult["covered"] = {};
  const lines: Line[] = [];
  for (const l of wanted) {
    if (open.has(l.ticker)) { covered[l.ticker] = "all"; continue; }
    if (l.max.type === "CAPACITY") { lines.push(l); continue; }
    const have = Math.min(aboard[l.ticker] ?? 0, l.max.units);
    if (have > 0) {
      aboard[l.ticker] -= have;
      const was = covered[l.ticker];
      covered[l.ticker] = (typeof was === "number" ? was : 0) + have;
    }
    const need = l.max.units - have;
    if (need <= 0) continue;
    lines.push({ ...l, min: l.min.type === "ABSOLUTE" ? abs(Math.min(l.min.units, need)) : l.min, max: abs(need) });
  }
  return { lines, covered };
}

/** 一个 waypoint 里所有装（或卸）步骤展开后的内容，按步骤顺序 */
export function opLines(route: RouteDoc, groups: Groups, wp: Waypoint, op: Op, trail: string[] = []): Line[] {
  const out: Line[] = [];
  for (const s of wp.steps) {
    if ((s.kind === "material" || s.kind === "group" || s.kind === "mirror") && s.op === op) {
      out.push(...stepLines(route, groups, s, trail));
    }
  }
  return out;
}

/** 同材料的行按数量合计，给界面上的摘要用；带 capacity 的行记在 open 里 */
export function summarize(lines: Line[]): { exact: Record<string, number>; open: string[] } {
  const exact: Record<string, number> = {};
  const open = new Set<string>();
  for (const l of lines) {
    if (l.max.type === "CAPACITY") open.add(l.ticker);
    else exact[l.ticker] = (exact[l.ticker] ?? 0) + l.max.units;
  }
  return { exact, open: [...open] };
}

const sameAmount = (a: Amount, b: Amount) => a.type === b.type && (a.type === "CAPACITY" || a.units === b.units);

function toGame(op: Op, l: Line): GameStep {
  return op === "LOAD"
    ? { type: "LOAD", material: l.ticker, minimum: l.min, maximum: l.max, retain: l.retain }
    : { type: "UNLOAD", material: l.ticker, minimum: l.min, maximum: l.max };
}

function mergeAdjacent(steps: GameStep[]): GameStep[] {
  const out: GameStep[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev && (s.type === "LOAD" || s.type === "UNLOAD") && prev.type === s.type
        && prev.material === s.material
        && prev.minimum.type === "ABSOLUTE" && prev.maximum.type === "ABSOLUTE"
        && s.minimum.type === "ABSOLUTE" && s.maximum.type === "ABSOLUTE"
        && (s.type === "UNLOAD" || (s.retain === 0 && (prev as { retain: number }).retain === 0))) {
      out[out.length - 1] = {
        ...prev,
        minimum: abs(prev.minimum.units + s.minimum.units),
        maximum: abs(prev.maximum.units + s.maximum.units),
      } as GameStep;
    } else {
      out.push(s);
    }
  }
  return out;
}

/** 与游戏里点「添加」得到的默认步骤一样的话，脚本不用再编辑 */
function isDefault(s: GameStep): boolean {
  switch (s.type) {
    case "LOAD":
      return s.material === "DW" && sameAmount(s.minimum, abs(1)) && sameAmount(s.maximum, abs(100)) && s.retain === 0;
    case "UNLOAD":
      return s.material === "DW" && sameAmount(s.minimum, abs(1)) && sameAmount(s.maximum, abs(100));
    case "REFUEL":
      return s.fuel === "STL" && s.source === "LOCAL_STORE" && sameAmount(s.minimum, abs(100)) && s.maximum.type === "CAPACITY";
    case "WAIT":
      return s.amount === 1 && s.unit === "MINUTES";
    default:
      return true;
  }
}

export function compile(route: RouteDoc, groupList: MaterialGroup[], opts: CompileOptions = {}): CompileResult {
  const groups: Groups = Object.fromEntries(groupList.map((g) => [g.id, g]));
  const issues: Issue[] = [];
  const waypoints: GameWaypoint[] = [];
  const known = opts.materials ?? {};
  const haveCatalog = Object.keys(known).length > 0;

  if (route.waypoints.length < 2) {
    issues.push({ level: "warn", text: "路线至少要有两个 waypoint 才能分配给船。" });
  }

  for (const wp of route.waypoints) {
    const at = { waypointId: wp.id };
    if (!wp.destination.naturalId.trim()) {
      issues.push({ level: "error", ...at, text: "还没设置目的地。" });
    }
    const steps: GameStep[] = [];
    for (const s of wp.steps) {
      const here = { ...at, stepId: s.id };
      if (s.kind === "refuel") {
        steps.push({ type: "REFUEL", fuel: s.fuel, source: s.source, minimum: s.min, maximum: s.max });
      } else if (s.kind === "wait") {
        if (s.amount < 0 || toSeconds(s.amount, s.unit) > 30 * 86400) {
          issues.push({ level: "error", ...here, text: "等待时间要在 0 到 30 天之间。" });
        }
        steps.push({ type: "WAIT", amount: s.amount, unit: s.unit });
      } else if (s.kind === "loadShipment") {
        steps.push({ type: "LOAD_SHIPMENT" });
      } else if (s.kind === "unloadShipment") {
        steps.push({ type: "UNLOAD_SHIPMENT" });
      } else {
        if (s.kind === "group" && !groups[s.groupId]) {
          issues.push({
            level: "error", ...here,
            text: s.groupId ? `材料组「${s.groupName || "未命名"}」没有载入，请先导入它。` : "还没选材料组。",
          });
          continue;
        }
        if (s.kind === "mirror" && !route.waypoints.some((w) => w.id === s.waypointId)) {
          issues.push({ level: "error", ...here, text: "还没选要引用哪个 waypoint。" });
          continue;
        }
        let lines: Line[];
        try {
          lines = stepLines(route, groups, s);
        } catch (e) {
          if (!(e instanceof CycleError)) throw e;
          issues.push({ level: "error", ...here, text: "引用绕了一圈回到自己，无法展开。" });
          continue;
        }
        if (!lines.length && !(s.kind === "mirror" && Object.keys(mirrorLines(route, groups, s).covered).length)) {
          issues.push({ level: "warn", ...here, text: "这一步展开后没有任何材料。" });
        }
        for (const l of lines) {
          if (!l.ticker) {
            issues.push({ level: "error", ...here, text: "有一步没填材料。" });
            continue;
          }
          if (haveCatalog && !known[l.ticker]) {
            issues.push({ level: "error", ...here, text: `没有 ${l.ticker} 这种材料。` });
          }
          if (l.min.type === "ABSOLUTE" && l.max.type === "ABSOLUTE" && l.min.units > l.max.units) {
            issues.push({ level: "error", ...here, text: `${l.ticker} 的最小值比最大值大。` });
          }
          steps.push(toGame(s.op, l));
        }
      }
    }
    if (route.autoShipments) {
      if (!steps.some((s) => s.type === "UNLOAD_SHIPMENT")) steps.unshift({ type: "UNLOAD_SHIPMENT" });
      if (!steps.some((s) => s.type === "LOAD_SHIPMENT")) steps.push({ type: "LOAD_SHIPMENT" });
    }
    waypoints.push({
      destination: { naturalId: wp.destination.naturalId.trim(), name: wp.destination.name.trim() },
      fuelUsageFactor: wp.fuelUsage / 100,
      reactorUsageFactor: wp.reactorUsage / 100,
      preferences: { ftlPreference: wp.ftlPreference, useGateways: wp.useGateways },
      steps: opts.mergeAdjacent ? mergeAdjacent(steps) : steps,
    });
  }

  const game: GameRoute = {
    format: "prun-route-game", version: 1, name: route.name, repeats: route.repeats, waypoints,
  };
  const legs = simulate(route, game, opts, issues);

  let clicks = 1 + (route.repeats ? 1 : 0);
  for (const w of waypoints) {
    const defaults = w.fuelUsageFactor === 0.25 && w.reactorUsageFactor === 0.5
      && w.preferences.ftlPreference === "LEAST_JUMPS" && w.preferences.useGateways;
    clicks += defaults ? 1 : 2;
    for (const s of w.steps) clicks += isDefault(s) ? 1 : 2;
  }
  return { game, issues, legs, clicks };
}

function toSeconds(amount: number, unit: string): number {
  return amount * ({ SECONDS: 1, MINUTES: 60, HOURS: 3600, DAYS: 86400 }[unit] ?? 1);
}

/**
 * 按计划数量走一遍货舱：只认精确数量的步骤。循环路线走两圈，第二圈才是稳定状态。
 * 一种材料只要经过「装到满」，之后它在船上的数量就不可知，相关检查跳过。
 */
function simulate(route: RouteDoc, game: GameRoute, opts: CompileOptions, issues: Issue[]): LegLoad[] {
  const known = opts.materials ?? {};
  const cargo: Record<string, number> = {};
  const unknown = new Set<string>();
  let legs: LegLoad[] = [];
  const rounds = route.repeats ? 2 : 1;

  for (let round = 0; round < rounds; round++) {
    const last = round === rounds - 1;
    legs = [];
    game.waypoints.forEach((w, i) => {
      const wp = route.waypoints[i];
      const flagged = new Set<string>();
      for (const s of w.steps) {
        if (s.type === "LOAD") {
          if (s.maximum.type === "CAPACITY") unknown.add(s.material);
          else cargo[s.material] = (cargo[s.material] ?? 0) + s.maximum.units;
        } else if (s.type === "UNLOAD") {
          const aboard = cargo[s.material] ?? 0;
          if (s.maximum.type === "CAPACITY") {
            cargo[s.material] = 0;
            unknown.delete(s.material);
          } else {
            if (last && !unknown.has(s.material) && s.minimum.type === "ABSOLUTE"
                && aboard < s.minimum.units && !flagged.has(s.material)) {
              flagged.add(s.material);
              issues.push({
                level: "warn", waypointId: wp.id,
                text: `到 ${destinationLabel(wp.destination)} 时按计划船上只有 ${aboard} 个 ${s.material}，`
                  + `不够卸 ${s.minimum.units} 个，路线会停在这一步等。`,
              });
            }
            cargo[s.material] = Math.max(0, aboard - s.maximum.units);
          }
        }
        if (last && s.type === "LOAD") checkCapacity(wp, cargo, unknown, known, opts, issues, flagged);
      }
      const { weight, volume } = totals(cargo, known);
      legs.push({ waypointId: wp.id, weight, volume, exact: unknown.size === 0 });
    });
  }
  return legs;
}

function totals(cargo: Record<string, number>, known: Record<string, MaterialInfo>) {
  let weight = 0;
  let volume = 0;
  for (const [t, n] of Object.entries(cargo)) {
    const m = known[t];
    if (m) { weight += m.weight * n; volume += m.volume * n; }
  }
  return { weight, volume };
}

function checkCapacity(
  wp: Waypoint, cargo: Record<string, number>, unknown: Set<string>,
  known: Record<string, MaterialInfo>, opts: CompileOptions, issues: Issue[], flagged: Set<string>,
) {
  if (flagged.has("#capacity")) return;
  const { weight, volume } = totals(cargo, known);
  const over: string[] = [];
  if (opts.shipWeight && weight > opts.shipWeight + 1e-6) over.push(`${weight.toFixed(1)} t / ${opts.shipWeight} t`);
  if (opts.shipVolume && volume > opts.shipVolume + 1e-6) over.push(`${volume.toFixed(1)} m³ / ${opts.shipVolume} m³`);
  if (!over.length) return;
  flagged.add("#capacity");
  issues.push({
    level: "warn", waypointId: wp.id,
    text: `在 ${destinationLabel(wp.destination)} 装货后超出货舱（${over.join("，")}`
      + `${unknown.size ? "，还没算「装到满」的材料" : ""}），装不下的那一步会一直等。`,
  });
}
