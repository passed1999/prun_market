/**
 * 三个公开数据源，经本站 /api/* 代理（见 worker/index.ts），进程内再记一份：
 * 页面切来切去不重复下载；刷新浏览器后靠 HTTP 缓存（代理给了 max-age）。
 *
 *   fio    rest.fnar.net           材料 / 建筑 / 配方 / 工人需求 / 行情 / 挂单簿
 *   pp     api.prunplanner.org     公开行情（vwap_7d / vwap_30d / 日成交）
 *   stats  prun.raylu.net/stats    月度全服产量与公司榜（PMMG 的 PrUn Financial Reports，MIT）
 */
import { getJson, getText } from "../api/client";
import type {
  FioBuilding, FioExchangeFullRow, FioExchangeRow, FioMaterial, FioPlanetName, FioPlanetOrbit, FioRecipe,
  FioSystemStar, FioStation,
  FioWorkforceNeeds,
  PpExchangeRow, StatsCompanies, StatsKnownCompanies, StatsProduction, StatsUniverse,
} from "../api/types";

const memo = new Map<string, Promise<unknown>>();

function cached<T>(path: string, force = false, transform?: (raw: unknown) => T): Promise<T> {
  if (force || !memo.has(path)) {
    const p = getJson<unknown>(path, force)
      .then((raw) => (transform ? transform(raw) : (raw as T)))
      .catch((e) => { memo.delete(path); throw e; });
    memo.set(path, p);
  }
  return memo.get(path) as Promise<T>;
}

// ---- FIO ----

export interface SlimExchangeRow {
  ticker: string;
  exchange: string;
  bid: number | null;
  ask: number | null;
  traded: number | null;
  volume_amount: number | null;
  /** [单价, 数量]；数量 null = 做市商单 */
  buying: [number, number | null][];
  selling: [number, number | null][];
}

/** 原始 5.6MB；只留套利要用的字段与 [单价, 数量] 形式的挂单，别把整份留在内存里 */
function slimFull(raw: unknown): SlimExchangeRow[] {
  return (raw as FioExchangeFullRow[]).map((r) => ({
    ticker: r.MaterialTicker,
    exchange: r.ExchangeCode,
    bid: r.Bid,
    ask: r.Ask,
    traded: r.Traded,
    volume_amount: r.VolumeAmount,
    buying: (r.BuyingOrders ?? []).filter((o) => o.ItemCost).map((o) => [o.ItemCost, o.ItemCount ?? null]),
    selling: (r.SellingOrders ?? []).filter((o) => o.ItemCost).map((o) => [o.ItemCost, o.ItemCount ?? null]),
  }));
}

/** 资源在星球上的形态，决定用哪种采集建筑 */
export type ResourceForm = "MINERAL" | "LIQUID" | "GASEOUS";
/** ticker → 形态 → 各星球的浓度（0–1），由高到低，只留前 50 颗 */
export type PlanetResources = Record<string, Partial<Record<ResourceForm, number[]>>>;

const RESOURCE_KEEP = 50;

/** /csv/planetresources：Key,Planet,Ticker,Type,Factor */
function parsePlanetResources(csv: string): PlanetResources {
  const out: PlanetResources = {};
  for (const line of csv.split("\n").slice(1)) {
    const [, , ticker, form, factor] = line.split(",");
    const value = Number(factor);
    if (!ticker || !(value > 0)) continue;
    if (form !== "MINERAL" && form !== "LIQUID" && form !== "GASEOUS") continue;
    ((out[ticker] ??= {})[form] ??= []).push(value);
  }
  for (const forms of Object.values(out)) {
    for (const form of Object.keys(forms) as ResourceForm[]) {
      forms[form] = forms[form]!.sort((a, b) => b - a).slice(0, RESOURCE_KEEP);
    }
  }
  return out;
}

/** 某种资源在某颗星球上的一处矿点 */
export interface ResourceSite {
  planet: string;
  form: ResourceForm;
  /** 浓度 0–1 */
  factor: number;
}
/** ticker → 所有有这种资源的星球，浓度由高到低 */
export type ResourceSites = Record<string, ResourceSite[]>;

function parseResourceSites(csv: string): ResourceSites {
  const out: ResourceSites = {};
  for (const line of csv.split("\n").slice(1)) {
    const [, planet, ticker, form, factor] = line.trim().split(",");
    const value = Number(factor);
    if (!ticker || !planet || !(value > 0)) continue;
    if (form !== "MINERAL" && form !== "LIQUID" && form !== "GASEOUS") continue;
    (out[ticker] ??= []).push({ planet, form, factor: value });
  }
  for (const sites of Object.values(out)) sites.sort((a, b) => b.factor - a.factor);
  return out;
}

let resourceCsv: Promise<string> | null = null;
const planetResourceCsv = () => resourceCsv ??= getText("/api/fio/csv/planetresources")
  .catch((e) => { resourceCsv = null; throw e; });
let planetResources: Promise<PlanetResources> | null = null;
let resourceSites: Promise<ResourceSites> | null = null;

export const fio = {
  planetResources: () => planetResources ??= planetResourceCsv()
    .then(parsePlanetResources)
    .catch((e) => { planetResources = null; throw e; }),
  resourceSites: () => resourceSites ??= planetResourceCsv()
    .then(parseResourceSites)
    .catch((e) => { resourceSites = null; throw e; }),
  materials: () => cached<FioMaterial[]>("/api/fio/material/allmaterials"),
  buildings: () => cached<FioBuilding[]>("/api/fio/building/allbuildings"),
  recipes: () => cached<FioRecipe[]>("/api/fio/recipes/allrecipes"),
  workforceNeeds: () => cached<FioWorkforceNeeds[]>("/api/fio/global/workforceneeds"),
  planets: () => cached<FioPlanetName[]>("/api/fio/planet/allplanets"),
  stations: () => cached<FioStation[]>("/api/fio/exchange/station"),
  planet: (id: string) => cached<FioPlanetOrbit>(`/api/fio/planet/${id}`),
  star: (system: string) => cached<{ Mass: number }>(`/api/fio/systemstars/star/${system}`),
  systemStars: () => cached<FioSystemStar[]>("/api/fio/systemstars"),
  exchangeAll: (force = false) => cached<FioExchangeRow[]>("/api/fio/exchange/all", force),
  exchangeFull: (force = false) => cached<SlimExchangeRow[]>("/api/fio/exchange/full", force, slimFull),
};

// ---- PRUNplanner 公开行情 ----

export const pp = {
  exchanges: (force = false) => cached<PpExchangeRow[]>("/api/pp/data/exchanges/", force),
};

// ---- 全服月报 ----

export interface SlimCompanies {
  totals: Record<string, { volume: number; rank: number }>;
  by_ticker: Record<string, {
    producer_count: number;
    total_amount: number;
    cr4: number;
    hhi: number;
    top: { company_id: string; amount: number }[];
  }>;
}

/** 3.4MB 的每公司每材料明细压成两张索引：公司日产值与名次；每种材料前 20 家 + 全量算的 CR4 / HHI */
function slimCompanies(raw: unknown): SlimCompanies {
  const data = raw as StatsCompanies;
  const byTicker = new Map<string, [string, number][]>();
  for (const [companyId, materials] of Object.entries(data.individual ?? {})) {
    for (const [ticker, row] of Object.entries(materials)) {
      const amount = Number(row.amount) || 0;
      if (amount > 0) {
        if (!byTicker.has(ticker)) byTicker.set(ticker, []);
        byTicker.get(ticker)!.push([companyId, amount]);
      }
    }
  }
  const out: SlimCompanies["by_ticker"] = {};
  for (const [ticker, rows] of byTicker) {
    rows.sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((s, r) => s + r[1], 0);
    out[ticker] = {
      producer_count: rows.length,
      total_amount: total,
      cr4: total ? rows.slice(0, 4).reduce((s, r) => s + r[1], 0) / total : 0,
      hhi: total ? rows.reduce((s, r) => s + (r[1] / total) ** 2, 0) : 0,
      top: rows.slice(0, 20).map(([company_id, amount]) => ({ company_id, amount })),
    };
  }
  const totals: SlimCompanies["totals"] = {};
  for (const [c, v] of Object.entries(data.totals ?? {})) {
    totals[c] = { volume: Number(v.volume) || 0, rank: Number(v.volumeRank) || 0 };
  }
  return { totals, by_ticker: out };
}

export type KnownCompanies = Record<string, { name: string; corp: string }>;

function slimKnown(raw: unknown): KnownCompanies {
  const out: KnownCompanies = {};
  for (const [cid, v] of Object.entries(raw as StatsKnownCompanies)) {
    if (v && typeof v === "object") out[cid] = { name: v.Username ?? "", corp: v.Corporation ?? "" };
  }
  return out;
}

export const stats = {
  universe: (force = false) => cached<StatsUniverse>("/api/stats/universe-data.json", force),
  production: (month: string, force = false) =>
    cached<StatsProduction>(`/api/stats/prod-data-${month}.json`, force),
  companies: (month: string, force = false) =>
    cached<SlimCompanies>(`/api/stats/company-data-${month}.json`, force, slimCompanies),
  knownCompanies: (force = false) =>
    cached<KnownCompanies>("/api/stats/knownCompanies.json", force, slimKnown),
};
