/**
 * 用玩家自己的 FIO 账号算「把某个基地补到 N 天要带多少」。
 *
 * 浏览器直接访问 rest.fnar.net（它允许跨域），用户名和 API key 只存在这台电脑的浏览器里，
 * 不经过本站的服务端，也不会进共享缓存。
 *
 * 算法与 prun_selfplanner 的 services/burn.py 同一口径（那边已与游戏内 XIT BURN 逐行对过）：
 *
 *   净日变化 = 产线产出/天 − 产线消耗/天 − 工人消耗/天
 *   补给量   = ceil(净日消耗 × 天数) − 基地库存（可选）      只留正数
 *
 *   工人：/workforce 的 UnitsPerInterval 已按人口折算成每日用量，不要再乘人口
 *   产线：只看排队中的订单（帝国里有循环单时只看循环的），当作一个反复轮转的周期，
 *         每单每天跑 Capacity / Σ排队时长 次；队列空了才退回按正在跑的订单算。
 *         DurationMs 已含效率；Inputs / Outputs 用订单自己的（倍数订单查不到配方表）
 *   库存：/storage 里 Type == 'STORE' 且 AddressableId == 该基地 SiteId 的那条，
 *         只数 Type == 'INVENTORY' 的条目；仓库和船上的货不算
 */
import { reactive, watch } from "vue";

import type { ResupplySpec } from "./model";

const BASE = "https://rest.fnar.net";
const KEY = "prun-market.fio.account";
const DAY_MS = 86_400_000;
const FRESH_MS = 5 * 60_000;

export class FioError extends Error {}

function loadAccount(): { username: string; apiKey: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { username: String(saved.username ?? ""), apiKey: String(saved.apiKey ?? "") };
  } catch {
    return { username: "", apiKey: "" };
  }
}

export const account = reactive(loadAccount());
watch(account, () => {
  try { localStorage.setItem(KEY, JSON.stringify(account)); } catch { /* 隐私模式 */ }
  cache = null;
});

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Empire {
  sites: Row[]; storage: Row[]; workforce: Row[]; production: Row[];
  /** 在空间站 / 星球上租的仓库；取不到就当没有 */
  warehouses: Row[];
  at: number; who: string;
}
let cache: Empire | null = null;

async function get(path: string): Promise<Row[]> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}/${encodeURIComponent(account.username.trim())}`, {
      headers: { Authorization: account.apiKey.trim(), accept: "application/json" },
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new FioError("连不上 FIO，请稍后重试。");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new FioError("FIO 不认这个用户名和 API key，请检查是否填对。");
  }
  if (resp.status === 204) return [];
  if (!resp.ok) throw new FioError("FIO 返回了错误，请稍后重试。");
  const data = await resp.json().catch(() => null);
  return Array.isArray(data) ? data : [];
}

async function empire(force = false): Promise<Empire> {
  const who = `${account.username.trim().toLowerCase()}|${account.apiKey.trim()}`;
  if (!account.username.trim() || !account.apiKey.trim()) {
    throw new FioError("先填 FIO 的用户名和 API key。");
  }
  if (!force && cache && cache.who === who && Date.now() - cache.at < FRESH_MS) return cache;
  const [sites, storage, workforce, production, warehouses] = await Promise.all([
    get("/sites"), get("/storage"), get("/workforce"), get("/production"),
    get("/sites/warehouses").catch(() => [] as Row[]),
  ]);
  cache = { sites, storage, workforce, production, warehouses, at: Date.now(), who };
  return cache;
}

export interface Base { naturalId: string; name: string }

export async function listBases(force = false): Promise<Base[]> {
  const e = await empire(force);
  return e.sites
    .map((s) => ({ naturalId: String(s.PlanetIdentifier ?? ""), name: String(s.PlanetName ?? "") }))
    .filter((b) => b.naturalId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 各个地点现在的库存：{ 星球编号或空间站代码: { 材料: 数量 } }。没有基地也没有仓库的地方不在里面 */
export type Stocks = Record<string, Record<string, number>>;

/**
 * 路线里「装满」的步骤能装多少，要看当地库存里现在有多少。
 * 有基地的星球取基地库存，否则取在那里租的仓库（空间站只有仓库）。
 */
export async function localStocks(force = false): Promise<Stocks> {
  const e = await empire(force);
  const out: Stocks = {};
  const take = (where: string, store: Row | undefined) => {
    if (!where || !store || out[where]) return;
    const have: Record<string, number> = {};
    for (const item of store.StorageItems ?? []) {
      if (item.Type !== "INVENTORY" || !item.MaterialTicker) continue;
      have[item.MaterialTicker] = (have[item.MaterialTicker] ?? 0) + item.MaterialAmount;
    }
    out[where] = have;
  };
  for (const s of e.sites) {
    take(String(s.PlanetIdentifier ?? ""), e.storage.find((x) => x.Type === "STORE" && x.AddressableId === s.SiteId));
  }
  for (const w of e.warehouses) {
    take(String(w.LocationNaturalId ?? ""), e.storage.find((x) => x.StorageId === w.StoreId));
  }
  return out;
}

/** 一条产线上每个计入的订单及其每日执行次数 */
function lineRates(line: Row, recurring: boolean): [Row, number][] {
  const orders: Row[] = line.Orders ?? [];
  const queued = orders.filter((o) => o.StartedEpochMs == null && (!recurring || o.Recurring));
  const capacity = line.Capacity || 1;
  if (queued.length) {
    if (queued.some((o) => !(o.DurationMs > 0))) return [];
    const days = queued.reduce((n, o) => n + o.DurationMs, 0) / DAY_MS;
    return queued.map((o) => [o, capacity / days]);
  }
  return orders
    .filter((o) => o.StartedEpochMs != null && !o.IsHalted && o.DurationMs > 0)
    .map((o) => [o, DAY_MS / o.DurationMs]);
}

export interface BurnLine { ticker: string; daily: number; stock: number; daysLeft: number | null; need: number }

export interface ResupplyResult {
  /** 实际按几天算的（cargo 模式下是反推出来的） */
  days: number;
  materials: Record<string, number>;
  lines: BurnLine[];
  planetName: string;
}

/** 一个基地每种材料的净日变化（负 = 消耗） */
function dailyNet(
  e: Empire, planet: string, includeLuxuries: boolean, used?: Record<string, number>,
): Record<string, number> {
  const daily: Record<string, number> = {};
  // used：只累计消耗的那一半（工人 + 产线投入），给「留一天用量」用
  const add = (ticker: string, n: number) => {
    daily[ticker] = (daily[ticker] ?? 0) + n;
    if (used && n < 0) used[ticker] = (used[ticker] ?? 0) - n;
  };

  const wf = e.workforce.find((w) => w.PlanetNaturalId === planet);
  for (const group of wf?.Workforces ?? []) {
    for (const need of group.WorkforceNeeds ?? []) {
      if (!includeLuxuries && need.Essential === false) continue;
      add(need.MaterialTicker, -(need.UnitsPerInterval ?? 0));
    }
  }

  // 整个帝国只要有一条循环订单，每条线就只看循环的
  const recurring = e.production.some((l) => (l.Orders ?? []).some((o: Row) => o.Recurring));
  for (const line of e.production.filter((l) => l.PlanetNaturalId === planet)) {
    for (const [order, rate] of lineRates(line, recurring)) {
      for (const item of order.Inputs ?? []) add(item.MaterialTicker, -item.MaterialAmount * rate);
      for (const item of order.Outputs ?? []) add(item.MaterialTicker, item.MaterialAmount * rate);
    }
  }
  return daily;
}

export interface Product {
  ticker: string;
  /** 净日产出 */
  daily: number;
  /** 这个基地自己每天还要用掉多少（工人 + 产线投入）；0 = 只产不用 */
  usedDaily: number;
}

/** 一个基地的产物：净日变化为正的材料（产出来全被自己用掉的不算），产量大的在前 */
export async function baseProducts(planet: string): Promise<Product[]> {
  const e = await empire();
  if (!e.sites.some((s) => s.PlanetIdentifier === planet)) {
    throw new FioError(`FIO 的数据里你在 ${planet} 没有基地，取不到产物。`);
  }
  const used: Record<string, number> = {};
  return Object.entries(dailyNet(e, planet, true, used))
    .filter(([, n]) => n > 1e-9)
    .map(([ticker, daily]) => ({ ticker, daily, usedDaily: used[ticker] ?? 0 }))
    .sort((a, b) => b.daily - a.daily);
}

export type Sizes = Record<string, { weight: number; volume: number }>;

/** 一个基地在消耗的材料和现有库存，补给组的数量都从这里算 */
interface Burn {
  spec: ResupplySpec;
  burning: [string, number][];
  stock: Record<string, number>;
  planetName: string;
  /** 被排除的材料照样算出数量（界面上要能看到、能恢复），只是装货舱时不占地方 */
  skip: Set<string>;
}

async function burnOf(spec: ResupplySpec, force: boolean, excluded: string[]): Promise<Burn> {
  const e = await empire(force);
  const site = e.sites.find((s) => s.PlanetIdentifier === spec.planet);
  if (!site) throw new FioError(`FIO 的数据里没有 ${spec.planetName || spec.planet} 这个基地。`);
  const daily = dailyNet(e, spec.planet, spec.includeLuxuries);
  const stock: Record<string, number> = {};
  const store = e.storage.find((s) => s.Type === "STORE" && s.AddressableId === site.SiteId);
  for (const item of store?.StorageItems ?? []) {
    if (item.Type !== "INVENTORY" || !item.MaterialTicker) continue;
    stock[item.MaterialTicker] = (stock[item.MaterialTicker] ?? 0) + item.MaterialAmount;
  }
  return {
    spec, stock, skip: new Set(excluded),
    burning: Object.entries(daily).filter(([, net]) => net < -1e-9),
    planetName: String(site.PlanetName ?? spec.planet),
  };
}

// 先减一个很小的数再取整：浮点累加出来的 300.0000001 不该变成 301
const needAt = (b: Burn, net: number, ticker: string, days: number) =>
  Math.max(0, Math.ceil(-net * days - 1e-6) - (b.spec.deductStock ? (b.stock[ticker] ?? 0) : 0));

/**
 * 几个基地共用同一个天数 T，取装得下（重量和体积都不超）的最大的 T（上限 3650 天）。
 * 带的量 = max(0, ceil(日消耗 × T) − 库存)，随 T 只增不减，所以二分即可。
 */
function fitDays(burns: Burn[], sizes: Sizes, maxWeight: number, maxVolume: number): number {
  const carried = burns.flatMap((b) => b.burning.filter(([t]) => !b.skip.has(t)).map(([t, net]) => ({ b, t, net })));
  const unknown = [...new Set(carried.map((c) => c.t).filter((t) => !sizes[t]))];
  if (unknown.length) throw new FioError(`${unknown.join("、")} 的重量体积还没取到，稍后再试一次。`);
  const fits = (days: number) => {
    let weight = 0;
    let volume = 0;
    for (const { b, t, net } of carried) {
      const n = needAt(b, net, t, days);
      weight += n * sizes[t].weight;
      volume += n * sizes[t].volume;
    }
    return weight <= maxWeight + 1e-6 && volume <= maxVolume + 1e-6;
  };
  if (!fits(0)) return 0;
  let low = 0;
  let high = 3650;
  if (fits(high)) return high;
  for (let n = 0; n < 60; n++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; }
  return low;
}

function resultAt(b: Burn, days: number): ResupplyResult {
  const materials: Record<string, number> = {};
  const lines: BurnLine[] = [];
  for (const [ticker, net] of b.burning) {
    const have = b.stock[ticker] ?? 0;
    const need = needAt(b, net, ticker, days);
    lines.push({ ticker, daily: net, stock: have, daysLeft: have / -net, need });
    if (need > 0) materials[ticker] = need;
  }
  lines.sort((x, y) => (x.daysLeft ?? 0) - (y.daysLeft ?? 0));
  return { days, materials, lines, planetName: b.planetName };
}

/**
 * 「补到 N 天」直接按 N 算。
 * 「装满货舱」：所有材料共用同一个天数，取这个货舱装得下的最大天数（见 fitDays）。
 * 扣库存时这相当于把每种材料都补到同一个剩余天数，已经堆得多的就不带了。
 */
export async function resupply(
  spec: ResupplySpec, sizes: Sizes = {}, force = true, excluded: string[] = [],
): Promise<ResupplyResult> {
  const b = await burnOf(spec, force, excluded);
  let days = spec.days;
  if (spec.mode === "cargo") {
    const maxWeight = spec.cargoWeight ?? 0;
    const maxVolume = spec.cargoVolume ?? 0;
    if (!(maxWeight > 0) || !(maxVolume > 0)) throw new FioError("先填货舱的载重和容积。");
    days = fitDays([b], sizes, maxWeight, maxVolume);
  }
  return resultAt(b, days);
}

/**
 * 塞满：几个补给组一起分给定的剩余空间，都补到同一个天数，取装得下的最大天数。
 * 返回的结果和 groups 一一对应。
 */
export async function resupplyFill(
  groups: { spec: ResupplySpec; excluded: string[] }[], sizes: Sizes, room: { weight: number; volume: number },
  force = true,
): Promise<{ days: number; results: ResupplyResult[] }> {
  const burns: Burn[] = [];
  // 同一份 FIO 数据：只有第一次按 force 取，后面的用刚取到的
  for (const [i, g] of groups.entries()) burns.push(await burnOf(g.spec, force && i === 0, g.excluded));
  const days = fitDays(burns, sizes, Math.max(0, room.weight), Math.max(0, room.volume));
  return { days, results: burns.map((b) => resultAt(b, days)) };
}
