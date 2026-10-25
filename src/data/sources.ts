/**
 * 三个公开数据源，经本站 /api/* 代理（见 worker/index.ts），进程内再记一份：
 * 页面切来切去不重复下载；刷新浏览器后靠 HTTP 缓存（代理给了 max-age）。
 *
 *   fio    rest.fnar.net           材料 / 建筑 / 配方 / 工人需求 / 行情 / 挂单簿
 *   pp     api.prunplanner.org     公开行情（vwap_7d / vwap_30d / 日成交）
 *   stats  prun.raylu.net/stats    月度全服产量与公司榜（PMMG 的 PrUn Financial Reports，MIT）
 */
import { getJson } from "../api/client";
import type {
  FioBuilding, FioExchangeFullRow, FioExchangeRow, FioMaterial, FioRecipe, FioWorkforceNeeds,
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

export const fio = {
  materials: () => cached<FioMaterial[]>("/api/fio/material/allmaterials"),
  buildings: () => cached<FioBuilding[]>("/api/fio/building/allbuildings"),
  recipes: () => cached<FioRecipe[]>("/api/fio/recipes/allrecipes"),
  workforceNeeds: () => cached<FioWorkforceNeeds[]>("/api/fio/global/workforceneeds"),
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
