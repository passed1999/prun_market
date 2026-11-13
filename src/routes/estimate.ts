/** 沿着路线一站一站估时间与 STL 耗油：取轨道数据，跟踪船上的货与燃料。公式见 flight.ts。 */
import { fio } from "../data/sources";
import type { GameRoute } from "./model";
import type { LegEstimate, Place, ShipSpec } from "./flight";
import { estimateLeg } from "./flight";

/**
 * 空间站的轨道没有公开数据。Moria 站是从游戏的试飞结果里量出来的（2026-11-12）：
 * 位置 (-34477936, 191430568) km，近圆轨道，推算 70 分钟后的航程偏差约 0.8%。其余站还没量。
 */
const STATION_ORBITS: Record<string, { radiusKm: number; theta0: number; t0: number }> = {
  MOR: { radiusKm: Math.hypot(-34477936.03, 191430567.75), theta0: Math.atan2(-34477936.03, 191430567.75), t0: 1794545254.257 },
};

const PLANET_ID = /^([A-Z]{2}-\d{3})[a-z]$/;
const places = new Map<string, Promise<Place | null>>();

async function loadPlace(naturalId: string): Promise<Place | null> {
  const m = naturalId.match(PLANET_ID);
  if (m) {
    const [planet, star] = await Promise.all([fio.planet(naturalId), fio.star(m[1])]);
    return {
      system: m[1], isPlanet: true, starMass: star.Mass,
      orbit: {
        a: planet.OrbitSemiMajorAxis, e: planet.OrbitEccentricity, i: planet.OrbitInclination,
        O: planet.OrbitRightAscension, w: planet.OrbitPeriapsis, mass: planet.Mass,
      },
    };
  }
  const station = (await fio.stations()).find((s) => s.NaturalId === naturalId);
  if (!station) return null;
  const star = await fio.star(station.SystemNaturalId);
  return { system: station.SystemNaturalId, isPlanet: false, starMass: star.Mass, circular: STATION_ORBITS[naturalId] };
}

function place(naturalId: string): Promise<Place | null> {
  if (!places.has(naturalId)) {
    const p = loadPlace(naturalId).catch(() => { places.delete(naturalId); return null; });
    places.set(naturalId, p);
  }
  return places.get(naturalId)!;
}

async function jumps(a: string, b: string): Promise<number[]> {
  if (a === b) return [];
  try {
    // FIO 的距离是地图单位，12 个单位 = 1 秒差距
    return (await fio.jumpRoute(a, b)).map((j) => j.Distance / 12);
  } catch {
    return [];
  }
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
  game: GameRoute, cargoAfter: number[], ship: ShipSpec, nowSec: number,
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
    if (round === 0) { const w = dwell(0); t += w; }
    for (const to of order) {
      const from = (to - 1 + n) % n;
      const a = where[from];
      const b = where[to];
      let est: LegEstimate;
      if (!a || !b) {
        est = { seconds: 0, stlFuel: 0, parts: [], caveats: [], unknown: "认不出这一段的起点或终点，估不了。" };
      } else {
        est = estimateLeg({
          ship, from: a, to: b,
          fuelUsage: stops[to].fuelUsageFactor, reactorUsage: stops[to].reactorUsageFactor,
          cargo: cargoAfter[from] ?? 0, stlFuel: fuel, ftlFuel: ship.ftlCapacity,
          departSec: t, jumps: await jumps(a.system, b.system),
          useGateways: stops[to].preferences.useGateways,
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
