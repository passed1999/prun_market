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

interface Empire { sites: Row[]; storage: Row[]; workforce: Row[]; production: Row[]; at: number; who: string }
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
  const [sites, storage, workforce, production] = await Promise.all([
    get("/sites"), get("/storage"), get("/workforce"), get("/production"),
  ]);
  cache = { sites, storage, workforce, production, at: Date.now(), who };
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

export async function resupply(spec: ResupplySpec, force = true): Promise<ResupplyResult> {
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

  const materials: Record<string, number> = {};
  const lines: BurnLine[] = [];
  for (const [ticker, net] of Object.entries(daily)) {
    if (net > -1e-9) continue;
    const have = stock[ticker] ?? 0;
    // 先减一个很小的数再取整：浮点累加出来的 300.0000001 不该变成 301
    const need = Math.max(0, Math.ceil(-net * spec.days - 1e-6) - (spec.deductStock ? have : 0));
    lines.push({ ticker, daily: net, stock: have, daysLeft: have / -net, need });
    if (need > 0) materials[ticker] = need;
  }
  lines.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  return { materials, lines, planetName: String(site.PlanetName ?? spec.planet) };
}
