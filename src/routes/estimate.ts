/** 沿着路线一站一站估时间与 STL 耗油：取轨道与星图数据，选路，跟踪船上的货与燃料。公式见 flight.ts。 */
import { fio } from "../data/sources";
import type { FtlPreference, GameRoute } from "./model";
import type { Hop, LegEstimate, Place, ShipSpec } from "./flight";
import { estimateLeg, ftlCharge, ftlSpeed, GATE_FIXED_SECONDS, GATE_SECONDS_PER_PARSEC } from "./flight";
import type { GatewayLink } from "./gateways";

/**
 * 空间站的轨道没有公开数据。Moria 站是从游戏的试飞结果里量出来的（2026-11-12）：
 * 位置 (-34477936, 191430568) km，近圆轨道，推算 70 分钟后的航程偏差约 0.8%。其余站还没量。
 */
const STATION_ORBITS: Record<string, { radiusKm: number; theta0: number; t0: number }> = {
  MOR: { radiusKm: Math.hypot(-34477936.03, 191430567.75), theta0: Math.atan2(-34477936.03, 191430567.75), t0: 1794545254.257 },
};

const PLANET_ID = /^([A-Z]{2}-\d{3})[a-z]$/;
const systemOf = (planet: string) => planet.match(PLANET_ID)?.[1] ?? "";
const places = new Map<string, Promise<Place | null>>();

async function loadPlace(naturalId: string): Promise<Place | null> {
  const m = naturalId.match(PLANET_ID);
  if (m) {
    const [planet, star] = await Promise.all([fio.planet(naturalId), fio.star(m[1])]);
    return {
      id: naturalId, system: m[1], isPlanet: true, starMass: star.Mass,
      orbit: {
        a: planet.OrbitSemiMajorAxis, e: planet.OrbitEccentricity, i: planet.OrbitInclination,
        O: planet.OrbitRightAscension, w: planet.OrbitPeriapsis, mass: planet.Mass,
      },
    };
  }
  const station = (await fio.stations()).find((s) => s.NaturalId === naturalId);
  if (!station) return null;
  const star = await fio.star(station.SystemNaturalId);
  return {
    id: naturalId, system: station.SystemNaturalId, isPlanet: false, starMass: star.Mass,
    circular: STATION_ORBITS[naturalId],
  };
}

function place(naturalId: string): Promise<Place | null> {
  if (!places.has(naturalId)) {
    const p = loadPlace(naturalId).catch(() => { places.delete(naturalId); return null; });
    places.set(naturalId, p);
  }
  return places.get(naturalId)!;
}

// ---- 星图与选路 ----

interface StarMap {
  /** 星系编号 → 坐标（地图单位，12 个单位 = 1 秒差距） */
  at: Map<string, [number, number, number]>;
  /** 星系编号 → 用 FTL 一跳能到的星系 */
  next: Map<string, string[]>;
}
let starMap: Promise<StarMap> | null = null;

function loadStarMap(): Promise<StarMap> {
  starMap ??= fio.systemStars().then((list) => {
    const byId = new Map(list.map((s) => [s.SystemId, s.NaturalId]));
    const at: StarMap["at"] = new Map();
    const next: StarMap["next"] = new Map();
    for (const s of list) {
      at.set(s.NaturalId, [s.PositionX, s.PositionY, s.PositionZ]);
      next.set(s.NaturalId, (s.Connections ?? []).map((c) => byId.get(c.ConnectingId) ?? "").filter(Boolean));
    }
    return { at, next };
  }).catch((e) => { starMap = null; throw e; });
  return starMap;
}

const parsecs = (map: StarMap, a: string, b: string) => {
  const p = map.at.get(a), q = map.at.get(b);
  return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 12 : 0;
};

interface Plan { hops: Hop[]; notes: string[]; found: boolean }

/**
 * 两个星系之间怎么走。游戏的选路规则不公开，这里按观察到的行为推测：
 *   「最少跳数」取步数最少的走法，一座星门算一步；「最短 FTL」取 FTL 里程最短的，星门不计里程；
 *   并列时取更快的。船比星门的体积上限大，或者这一站没勾「星门」，就不走那座星门。
 */
async function plan(
  from: string, to: string, ship: ShipSpec, reactor: number, preference: FtlPreference,
  useGateways: boolean, links: GatewayLink[],
): Promise<Plan> {
  if (from === to) return { hops: [], notes: [], found: true };
  let map: StarMap;
  try { map = await loadStarMap(); } catch { return { hops: [], notes: [], found: false }; }
  const notes: string[] = [];
  const speed = ship.ftlMaxSpeed ? ftlSpeed(ship, reactor) : 0;
  const charge = ship.ftlMaxSpeed ? ftlCharge(ship, reactor) : 0;

  interface Edge { to: string; pc: number; gate?: GatewayLink }
  const gateEdges = new Map<string, Edge[]>();
  let tooBig = 0;
  if (useGateways) {
    for (const g of links) {
      if (ship.volume > 0 && ship.volume > g.maxVolume) { tooBig++; continue; }
      const a = systemOf(g.from), b = systemOf(g.to);
      if (!a || !b || a === b) continue;
      (gateEdges.get(a) ?? gateEdges.set(a, []).get(a)!).push({ to: b, pc: parsecs(map, a, b), gate: g });
    }
  }

  // Dijkstra：主键按偏好（步数或 FTL 里程），并列看时间
  const key = (steps: number, ftlPc: number, seconds: number) =>
    (preference === "LEAST_JUMPS" ? steps : ftlPc) * 1e9 + seconds;
  const best = new Map<string, { cost: number; steps: number; ftlPc: number; seconds: number; prev?: string; via?: Edge }>();
  best.set(from, { cost: 0, steps: 0, ftlPc: 0, seconds: 0 });
  const open = new Set([from]);
  const done = new Set<string>();
  while (open.size) {
    let cur = "";
    for (const s of open) if (!cur || best.get(s)!.cost < best.get(cur)!.cost) cur = s;
    open.delete(cur);
    if (cur === to) break;
    done.add(cur);
    const state = best.get(cur)!;
    const edges: Edge[] = [...(gateEdges.get(cur) ?? [])];
    if (speed) for (const n of map.next.get(cur) ?? []) edges.push({ to: n, pc: parsecs(map, cur, n) });
    for (const e of edges) {
      if (done.has(e.to)) continue;
      const seconds = state.seconds + (e.gate ? GATE_FIXED_SECONDS + GATE_SECONDS_PER_PARSEC * e.pc : e.pc / speed + charge);
      const steps = state.steps + 1;
      const ftlPc = state.ftlPc + (e.gate ? 0 : e.pc);
      const cost = key(steps, ftlPc, seconds);
      const old = best.get(e.to);
      if (!old || cost < old.cost) {
        best.set(e.to, { cost, steps, ftlPc, seconds, prev: cur, via: e });
        open.add(e.to);
      }
    }
  }
  if (!best.has(to)) return { hops: [], notes, found: false };

  const path: Edge[] = [];
  for (let s = to; s !== from;) { const b = best.get(s)!; path.unshift(b.via!); s = b.prev!; }
  const hops: Hop[] = [];
  for (const e of path) {
    if (!e.gate) { hops.push({ kind: "ftl", parsecs: e.pc }); continue; }
    const [a, b] = await Promise.all([place(e.gate.from), place(e.gate.to)]);
    if (!a || !b) return { hops: [], notes, found: false };
    hops.push({ kind: "gate", parsecs: e.pc, from: a, to: b, label: `${e.gate.from} → ${e.gate.to}` });
  }
  if (hops.some((h) => h.kind === "gate")) {
    notes.push("走不走星门由游戏选路决定，这里按推测的规则选了星门；游戏里实际路线可能不同");
    if (!ship.volume) notes.push("不知道这艘船的体积，没法判断过不过得了星门（重新复制一次船只参数即可）");
  } else if (useGateways && tooBig && gateEdges.size === 0) {
    notes.push("这艘船的体积超过了所有星门的上限，只能用 FTL");
  } else if (useGateways && tooBig) {
    notes.push(`有 ${tooBig} 座星门因为船太大用不了`);
  }
  return { hops, notes, found: true };
}

export interface RouteLeg extends LegEstimate {
  /** 这一段飞到第几站（下标）；循环路线回到第一站的那段是 0 */
  toIndex: number;
  /** 出发时船上的 STL 燃料 */
  fuelBefore: number;
}

export interface RouteEstimate {
  legs: RouteLeg[];
  /** 一圈（或一趟）的总时间，含等待步骤；有估不出的段时为 null */
  totalSeconds: number | null;
  totalFuel: number;
}

const WAIT: Record<string, number> = { SECONDS: 1, MINUTES: 60, HOURS: 3600, DAYS: 86400 };

/**
 * cargoAfter[i] = 离开第 i 站时船上的货（吨），来自 compile 的结果。
 * 燃料：出发时按满油箱；遇到 STL 加油步骤就加（加到满 / 加指定数量）。循环路线多走一圈取稳定状态。
 */
export async function estimateRoute(
  game: GameRoute, cargoAfter: number[], ship: ShipSpec, nowSec: number, links: GatewayLink[],
): Promise<RouteEstimate> {
  const stops = game.waypoints;
  const n = stops.length;
  if (n < 2) return { legs: [], totalSeconds: 0, totalFuel: 0 };
  const where = await Promise.all(stops.map((w) => place(w.destination.naturalId.trim())));

  let fuel = ship.stlCapacity;
  let t = nowSec;
  const dwell = (i: number) => {
    let wait = 0;
    for (const s of stops[i].steps) {
      if (s.type === "WAIT") wait += s.amount * (WAIT[s.unit] ?? 1);
      if (s.type === "REFUEL" && s.fuel === "STL") {
        fuel = s.maximum.type === "CAPACITY" ? ship.stlCapacity : Math.min(ship.stlCapacity, fuel + s.maximum.units);
      }
    }
    return wait;
  };

  let legs: RouteLeg[] = [];
  let total: number | null = 0;
  const rounds = game.repeats ? 2 : 1;
  for (let round = 0; round < rounds; round++) {
    legs = [];
    total = 0;
    // 第一圈从第 0 站出发；循环路线最后还要飞回第 0 站
    const order = game.repeats ? [...Array(n).keys()].map((i) => (i + 1) % n) : [...Array(n - 1).keys()].map((i) => i + 1);
    if (round === 0) t += dwell(0);
    for (const to of order) {
      const from = (to - 1 + n) % n;
      const a = where[from];
      const b = where[to];
      let est: LegEstimate;
      if (!a || !b) {
        est = { seconds: 0, stlFuel: 0, parts: [], caveats: [], unknown: "认不出这一段的起点或终点，估不了。" };
      } else {
        const stop = stops[to];
        const route = await plan(a.system, b.system, ship, stop.reactorUsageFactor,
          stop.preferences.ftlPreference, stop.preferences.useGateways, links);
        est = estimateLeg({
          ship, from: a, to: b,
          fuelUsage: stop.fuelUsageFactor, reactorUsage: stop.reactorUsageFactor,
          cargo: cargoAfter[from] ?? 0, stlFuel: fuel, ftlFuel: ship.ftlCapacity,
          departSec: t, hops: route.hops, noRoute: !route.found, routeNotes: route.notes,
        });
      }
      legs.push({ ...est, toIndex: to, fuelBefore: fuel });
      if (est.unknown) total = null;
      else {
        fuel = Math.max(0, fuel - est.stlFuel);
        t += est.seconds;
        if (total != null) total += est.seconds;
      }
      const wait = dwell(to);
      t += wait;
      if (total != null) total += wait;
    }
  }
  return { legs, totalSeconds: total, totalFuel: legs.reduce((s, l) => s + (l.unknown ? 0 : l.stlFuel), 0) };
}
