/**
 * 航行时间与 STL 耗油的估算。
 *
 * 游戏不公开公式，时间由服务器算。下面的式子是 2026-11 用游戏里的「蓝图试飞」向服务器取了约 40 个样本
 * 反推出来的（两艘不同引擎的蓝图、空载 / 满载、油箱 300–1500、燃料用量 1%–100%），
 * 给定航段长度时与服务器的结果相差不超过几秒：
 *
 *   a        = 推力(kN) / 当前总质量(t)                 数值上直接配「公里」用
 *   本段燃料  = 下限 + 用量% ×（船上现有 STL 燃料 − 起降预留 − 下限）     ← 是「现有燃料」的百分比
 *   tb       = 燃料 × 0.06 / 引擎流量(t/s) / 2，上限 √(D/a)             单侧加速时间
 *   航行时间  = tb + D / (a × tb)
 *   起降时间  ≈ 44.8 × √(d/a)，耗油 ≈ 0.455 × 时间 × 流量 / 0.06
 *   跃迁      速度 = ftlMaxSpeed ×（0.5625 + 0.3R + 0.1375R²），每跳前充能 = 基础 + 档位比例 × 最大超充
 *
 * 做不到精确的部分（所以界面上一律写「约」）：
 *   - 航段长度 D：行星位置按轨道根数算，和游戏一致（差一个停泊轨道的半径，约几千公里）；
 *     但停泊轨道与跃迁点每次航班随机，空间站的轨道没有公开数据
 *   - 起降的路程 d：随停泊轨道变，实测 2000–9000 km，这里取典型值
 *   - 燃料下限：实测 3–6 个单位，随质量变，规律没找出来，按质量近似（只在用量很低时有影响）
 *   - 跃迁速度曲线只在一艘蓝图上取过样；FTL 耗油不估
 *   - 星门：时间是定值加按距离算，准；但走不走星门由游戏选路决定，这里的选路规则是推测的
 */

export interface Vec { x: number; y: number; z: number }

/** 轨道根数：a 米，角度弧度，mass 千克 */
export interface Orbit { a: number; e: number; i: number; O: number; w: number; mass: number }

export interface ShipSpec {
  name: string;
  /** 空重 t（不含货与燃料） */
  emptyMass: number;
  /** 推力 kN = 加速度 × 质量 */
  thrust: number;
  /** 引擎满推力时的燃料流量 t/s（游戏里的 stlFuelFlowRate / 蓝图的 STL_USAGE） */
  flowRate: number;
  stlCapacity: number;
  ftlCapacity: number;
  cargoWeight: number;
  cargoVolume: number;
  /** 船体体积 m³，过星门有上限；0 = 不知道 */
  volume: number;
  /** 秒差距 / 秒；0 = 没有 FTL */
  ftlMaxSpeed: number;
  chargeTime: number;
  overchargeTime: number;
  minReactor: number;
}

const G = 6.67384e-11;
const REFERENCE_TIME = 1451690603;
/** 行星运动比现实快 20 倍（游戏的 planetaryMotionFactor） */
const MOTION_FACTOR = 20;
export const SF_WEIGHT = 0.06;
export const FF_WEIGHT = 0.05;
/** 燃料下限：空船约 3，实测 2545 t 时约 6；规律不确定，按质量的 1.5 次方近似 */
const minFuel = (mass: number) => 3 * Math.max(1, (mass / 1545) ** 1.5);
const LANDING_K = 44.8;
const LANDING_THROTTLE = 0.455;
/** 起降路程的典型值 km */
export const TYPICAL_LANDING_KM = 4500;

/** 行星在给定现实时刻（秒）的位置，公里，恒星在原点。与游戏客户端同一套算法。 */
export function orbitPosition(o: Orbit, starMass: number, tSec: number): Vec {
  const world = REFERENCE_TIME + (tSec - REFERENCE_TIME) * MOTION_FACTOR;
  const mu = G * (starMass + o.mass);
  const M = Math.sqrt(mu / o.a ** 3) * world;
  let E = o.e < 0.8 ? M : Math.PI;
  for (let n = 0, d = 1; Math.abs(d) > 1e-13 && n < 100; n++) {
    d = (M + o.e * Math.sin(E) - E) / (1 - o.e * Math.cos(E));
    E += d;
  }
  const nu = 2 * Math.atan(Math.sqrt((1 + o.e) / (1 - o.e)) * Math.tan(E / 2));
  const r = (o.a * (1 - o.e * o.e)) / (1 + o.e * Math.cos(nu));
  const rz = (v: number[], t: number) => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t), v[2]];
  const rx = (v: number[], t: number) => [v[0], v[1] * Math.cos(t) - v[2] * Math.sin(t), v[1] * Math.sin(t) + v[2] * Math.cos(t)];
  const v = rz(rx(rz([r * Math.cos(nu), r * Math.sin(nu), 0], o.w), o.i), o.O);
  return { x: v[1] / 1e3, y: v[0] / 1e3, z: v[2] / 1e3 };
}

/**
 * 两点之间的航程：游戏用一段椭圆弧——焦点一个在恒星，另一个是恒星关于两点连线中垂线的镜像，
 * 取较短的那段弧。照客户端的算法移植。
 */
export function transferDistance(start: Vec, target: Vec): number {
  const ox = start.x, oy = start.y, ix = target.x, iy = target.y;
  const ax = ix - ox, ay = iy - oy;
  const sx = (ox + ix) / 2, sy = (oy + iy) / 2;
  const ux = -ay, uy = ax;
  const uu = ux * ux + uy * uy;
  if (uu < 1) return Math.abs(target.z - start.z);
  const px = -sx, py = -sy;
  const k = (px * ux + py * uy) / uu;
  // 恒星（原点）关于中垂线的镜像 = 第二焦点
  const fx = px + (k * ux - px) * 2 + sx, fy = py + (k * uy - py) * 2 + sy;
  const y = Math.hypot(ox, oy), g = Math.hypot(fx - ox, fy - oy);
  const A = (y + g) / 2;
  const B = Math.sqrt(Math.max(0, (y + g) ** 2 - (fx * fx + fy * fy))) / 2;
  const cx = fx / 2, cy = fy / 2;
  const alpha = Math.atan2(-fy, fx) < 0 ? Math.atan2(-fy, fx) + 2 * Math.PI : Math.atan2(-fy, fx);
  const local = (x: number, yy: number) => {
    const dx = x - cx, dy = yy - cy;
    // 绕 z 轴转 alpha
    const lx = dx * Math.cos(alpha) - dy * Math.sin(alpha), ly = dx * Math.sin(alpha) + dy * Math.cos(alpha);
    let t = Math.atan2(ly / (B || 1), lx / A);
    if (t < 0) t += 2 * Math.PI;
    return t;
  };
  const tA = local(ox, oy), tB = local(ix, iy);
  const forward = tA < tB ? tB - tA : 2 * Math.PI - (tA - tB);
  const arc = (span: number, sign: number) => {
    const N = 600;
    let sum = 0, lx = A * Math.cos(tA), ly = B * Math.sin(tA);
    for (let n = 1; n <= N; n++) {
      const t = tA + sign * (span * n) / N;
      const x = A * Math.cos(t), yy = B * Math.sin(t);
      sum += Math.hypot(x - lx, yy - ly);
      lx = x; ly = yy;
    }
    return sum;
  };
  const planar = Math.min(arc(forward, 1), arc(2 * Math.PI - forward, -1));
  return Math.hypot(planar, target.z - start.z);
}

export interface Burn { time: number; fuel: number; capped: boolean }

/** 一段 STL 航行：给定路程、质量、可烧的燃料 */
export function stlTransit(ship: ShipSpec, mass: number, distanceKm: number, fuel: number): Burn {
  const a = ship.thrust / mass;
  const cap = Math.sqrt(distanceKm / a);
  const want = (Math.max(fuel, 0.5) * SF_WEIGHT) / ship.flowRate / 2;
  const tb = Math.min(want, cap);
  return { time: tb + distanceKm / (a * tb), fuel, capped: want >= cap };
}

/** 起飞或降落 */
export function landing(ship: ShipSpec, mass: number, km = TYPICAL_LANDING_KM): Burn {
  const time = LANDING_K * Math.sqrt(km / (ship.thrust / mass));
  return { time, fuel: Math.ceil((LANDING_THROTTLE * time * ship.flowRate) / SF_WEIGHT), capped: false };
}

/** 这一趟 STL 部分总共能烧多少：燃料用量是「船上现有燃料扣掉起降预留之后」的百分比 */
export function stlBudget(usage: number, aboard: number, reserved: number, mass = 1545): number {
  const top = aboard - reserved;
  const low = minFuel(mass);
  if (top <= low) return Math.max(0, top);
  return Math.ceil(low + usage * (top - low));
}

export function ftlSpeed(ship: ShipSpec, reactor: number): number {
  const r = Math.min(1, Math.max(ship.minReactor, reactor));
  return ship.ftlMaxSpeed * (0.5625 + 0.3 * r + 0.1375 * r * r);
}
export function ftlCharge(ship: ShipSpec, reactor: number): number {
  const r = Math.min(1, Math.max(ship.minReactor, reactor));
  const x = ship.minReactor < 1 ? (r - ship.minReactor) / (1 - ship.minReactor) : 0;
  return ship.chargeTime + x * ship.overchargeTime;
}

// ---- 一整段：从一个 waypoint 到下一个 ----

export interface Place {
  /** 星球编号或空间站代码，用来判断是不是同一个地方 */
  id: string;
  /** 行星有轨道根数；空间站只有个别测过位置的能算 */
  orbit?: Orbit;
  /** 近圆轨道的空间站：半径 km、某一现实时刻的相位 */
  circular?: { radiusKm: number; theta0: number; t0: number };
  starMass: number;
  system: string;
  isPlanet: boolean;
}

export function placePosition(p: Place, tSec: number): Vec | null {
  if (p.orbit) return orbitPosition(p.orbit, p.starMass, tSec);
  if (p.circular) {
    const n = Math.sqrt((G * p.starMass) / (p.circular.radiusKm * 1e3) ** 3) * MOTION_FACTOR;
    const th = p.circular.theta0 + n * (tSec - p.circular.t0);
    // 与行星同向：游戏坐标里 x、y 互换，角度从 y 轴量起
    return { x: p.circular.radiusKm * Math.sin(th), y: p.circular.radiusKm * Math.cos(th), z: 0 };
  }
  return null;
}

/**
 * 星系之间的一步。星门（2026-11 取样，三艘蓝图、两座星门）：
 *   飞进星门 10 秒 + 锁定 600 秒 + 跃迁 1200 秒/秒差距 + 脱离 600 秒 + 飞出 10 秒，共耗 40 SF，
 *   不耗 FTL 燃料，与船、载重、燃料用量、反应堆用量都无关；星门在行星轨道上，从一颗行星通到另一颗。
 */
export type Hop =
  | { kind: "ftl"; parsecs: number }
  | { kind: "gate"; parsecs: number; from: Place; to: Place; label: string };

export const GATE_FIXED_SECONDS = 1220;
export const GATE_SECONDS_PER_PARSEC = 1200;
const GATE_FUEL = 40;

export interface LegInput {
  ship: ShipSpec;
  from: Place;
  to: Place;
  /** 0–1 */
  fuelUsage: number;
  reactorUsage: number;
  /** 出发时船上的货 t、STL 燃料、FTL 燃料 */
  cargo: number;
  stlFuel: number;
  ftlFuel: number;
  departSec: number;
  /** 跨星系时依次要走的每一步；同星系为空 */
  hops: Hop[];
  /** 跨星系但没找到路 */
  noRoute?: boolean;
  /** 关于选路的提醒（比如船太大过不了某座星门） */
  routeNotes?: string[];
}

export interface LegEstimate {
  seconds: number;
  stlFuel: number;
  /** 分项，给悬停提示用 */
  parts: { label: string; seconds: number; fuel: number }[];
  /** 哪些地方是估的 */
  caveats: string[];
  /** 完全没法估时的原因 */
  unknown?: string;
}

type Item =
  | { t: "known"; a: Place; b: Place }
  | { t: "out"; from: Place }
  | { t: "in"; to: Place }
  | { t: "gate"; hop: Extract<Hop, { kind: "gate" }> }
  | { t: "ftl"; parsecs: number[] };

export function estimateLeg(input: LegInput): LegEstimate {
  const { ship, from, to, hops } = input;
  const caveats: string[] = [...(input.routeNotes ?? [])];
  const parts: LegEstimate["parts"] = [];
  const fail = (unknown: string): LegEstimate => ({ seconds: 0, stlFuel: 0, parts, caveats, unknown });
  const mass = ship.emptyMass + input.cargo + input.stlFuel * SF_WEIGHT + input.ftlFuel * FF_WEIGHT;
  const a = ship.thrust / mass;

  if (from.system !== to.system && (input.noRoute || !hops.length)) {
    return fail(ship.ftlMaxSpeed ? "没查到两个星系之间的路线。" : "这艘船没有 FTL，也没有能用的星门通到那里。");
  }
  if (hops.some((h) => h.kind === "ftl") && !ship.ftlMaxSpeed) return fail("这艘船没有 FTL，到不了别的星系。");

  // 把这一段拆成依次要做的事
  const items: Item[] = [];
  let here = from;
  let adrift = false; // 停在跃迁点上
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    if (h.kind === "gate") {
      if (adrift) { items.push({ t: "in", to: h.from }); adrift = false; }
      else if (here.id !== h.from.id) items.push({ t: "known", a: here, b: h.from });
      items.push({ t: "gate", hop: h });
      here = h.to;
    } else {
      const parsecs = [h.parsecs];
      while (hops[i + 1]?.kind === "ftl") parsecs.push(hops[++i].parsecs);
      if (!adrift) items.push({ t: "out", from: here });
      items.push({ t: "ftl", parsecs });
      adrift = true;
    }
  }
  if (adrift) items.push({ t: "in", to });
  else if (here.id !== to.id) items.push({ t: "known", a: here, b: to });

  const up = from.isPlanet ? landing(ship, mass) : null;
  const down = to.isPlanet ? landing(ship, mass) : null;
  if (up || down) caveats.push("起降按典型路程估，实际随停泊轨道变化（单次可差一两分钟）");
  const gates = items.filter((x) => x.t === "gate").length;
  const reserved = (up?.fuel ?? 0) + (down?.fuel ?? 0) + gates * GATE_FUEL;
  if (input.stlFuel < reserved + 1) return fail("按估算，船上的 STL 燃料不够这一段的起降和过星门。");
  const budget = stlBudget(input.fuelUsage, input.stlFuel, reserved, mass);
  const flights = items.filter((x) => x.t === "known" || x.t === "out" || x.t === "in").length;
  const share = flights ? budget / flights : 0;
  const single = items.length === 1;
  // 实测：分成几段飞时，每段最多烧到全程加减速为止，不会多烧；只有一段时给多少烧多少
  const fly = (km: number) => {
    const useful = (2 * Math.sqrt(km / a) * ship.flowRate) / SF_WEIGHT;
    const fuel = single ? Math.ceil(share) : Math.ceil(Math.min(share, useful));
    return { ...stlTransit(ship, mass, km, fuel), fuel };
  };
  const radius = (p: Place) => (p.orbit ? p.orbit.a / 1e3 : p.circular?.radiusKm ?? 1.5e8);

  let t = input.departSec;
  const push = (label: string, seconds: number, fuel: number) => { parts.push({ label, seconds, fuel }); t += seconds; };
  if (up) push("起飞", up.time, up.fuel);

  for (const item of items) {
    if (item.t === "known") {
      const start = placePosition(item.a, t);
      if (!start || !placePosition(item.b, t)) return fail("这个空间站的轨道位置没有数据，估不了航程。");
      if (!item.a.orbit || !item.b.orbit) caveats.push("空间站的位置按近圆轨道推算，有偏差");
      // 飞得越久目标走得越远：迭代到到达时刻自洽
      let burn = fly(transferDistance(start, placePosition(item.b, t)!));
      for (let n = 0; n < 12; n++) {
        const next = fly(transferDistance(start, placePosition(item.b, t + burn.time)!));
        const done = Math.abs(next.time - burn.time) < 1;
        burn = next;
        if (done) break;
      }
      const label = single
        ? (burn.capped ? "航行（全程加减速，再多给油也不会更快）" : "航行")
        : (item.b.id === to.id ? "飞到目的地" : "飞到星门所在的行星");
      push(label, burn.time, burn.fuel);
    } else if (item.t === "out") {
      // 跃迁点每次随机，只能按轨道半径的量级估
      const burn = fly(Math.max(1e7, radius(item.from) * 0.3));
      push("飞到跃迁点", burn.time, burn.fuel);
    } else if (item.t === "in") {
      const burn = fly(Math.max(1e7, radius(item.to) * 0.6));
      push(item.to.id === to.id ? "从跃迁点飞到目的地" : "从跃迁点飞到星门所在的行星", burn.time, burn.fuel);
    } else if (item.t === "gate") {
      push(`过星门 ${item.hop.label}（${item.hop.parsecs.toFixed(1)} 秒差距）`,
        GATE_FIXED_SECONDS + GATE_SECONDS_PER_PARSEC * item.hop.parsecs, GATE_FUEL);
    } else {
      const total = item.parsecs.reduce((n, d) => n + d, 0);
      push(`跃迁 ${item.parsecs.length} 跳，共 ${total.toFixed(1)} 秒差距`, total / ftlSpeed(ship, input.reactorUsage), 0);
      if (item.parsecs.length > 1) {
        push("跳与跳之间充能", ftlCharge(ship, input.reactorUsage) * (item.parsecs.length - 1), 0);
      }
    }
  }
  if (items.some((x) => x.t === "out" || x.t === "in")) {
    caveats.push("跃迁点的位置每次随机，星系内进出跃迁点的那几段只是量级估计");
  }
  if (gates) caveats.push("过星门要付使用费，这里没算；星门每天能过的船数有上限");
  if (down) push("降落", down.time, down.fuel);
  return {
    seconds: parts.reduce((n, p) => n + p.seconds, 0),
    stlFuel: parts.reduce((n, p) => n + p.fuel, 0),
    parts, caveats,
  };
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${mm} 分`;
  return `${mm} 分钟`;
}
