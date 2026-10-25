/**
 * 跨交易所套利：同一种材料，在一个交易所买入、到另一个交易所卖出有差价可赚。
 * 从 prun_selfplanner 的 services/arbitrage.py 移植。
 *
 * 两种卖法：
 *     bid  卖给对方交易所的买单，立即成交
 *     avg  按对方交易所的日成交均价挂卖单，等成交
 * 买入一律吃本交易所的卖单（卖一价起）。不做「按买一价挂买单」：价差大、成交少的票，
 * 买一价是压价单，从没人按它卖出过，拿它当买入价算出来的利润是假的。
 *
 * 只看 AI1 / CI1 / IC1 / NC1。
 *
 * 行情来源（报价与日均价同出一处，不混用）：
 *     FIO          /exchange/full：报价 + 完整挂单簿。日均价 = VolumeAmount / Traded，近 24 小时滚动口径
 *     PRUNPLANNER  /data/exchanges/：日均价 = vwap_daily，UTC 当日 0 点起算
 * 可套利数量一律按 FIO 的挂单簿逐档算（PRUNplanner 没有挂单簿）。
 *
 * 各交易所币种不同（AI1=AIC、CI1=CIS、IC1=ICA、NC1=NCC），数据源都不给汇率，按 1:1 直接比；
 * 交易手续费与运输不计。
 */
import { fio, pp } from "../data/sources";
import type { SlimExchangeRow } from "../data/sources";
import type {
  ArbitrageBook, ArbitrageOpportunity, ArbitrageResult, ArbitrageSell, BookLevel, ExchangeCode, QuoteSource,
} from "../api/types";
import { COMPARED_EXCHANGES } from "./prices";

export const CURRENCY: Record<string, string> = { AI1: "AIC", CI1: "CIS", IC1: "ICA", NC1: "NCC" };
const BOOK_LEVELS = 15;

/** [单价, 数量]；数量 Infinity = 做市商单 */
type Level = [number, number];

/** 同价挂单合并成一档，按价格排好 */
export function levels(orders: [number, number | null][], descending: boolean): Level[] {
  const merged = new Map<number, number>();
  for (const [price, count] of orders) {
    merged.set(price, (merged.get(price) ?? 0) + (count == null ? Infinity : count));
  }
  return [...merged.entries()].sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
}

interface Walk { qty: number; cost: number; profit: number; unlimited: boolean }

/** 卖单从低往高、买单从高往低逐档撮合，直到卖价 ≥ 买价 */
export function walk(asksIn: Level[], bidsIn: Level[]): Walk {
  const asks = asksIn.map((l) => [...l] as Level);
  const bids = bidsIn.map((l) => [...l] as Level);
  let qty = 0, cost = 0, profit = 0, i = 0, j = 0;
  while (i < asks.length && j < bids.length && asks[i][0] < bids[j][0]) {
    const take = Math.min(asks[i][1], bids[j][1]);
    if (!Number.isFinite(take)) return { qty, cost, profit, unlimited: true };
    qty += take;
    cost += take * asks[i][0];
    profit += take * (bids[j][0] - asks[i][0]);
    asks[i][1] -= take;
    bids[j][1] -= take;
    if (asks[i][1] <= 0) i++;
    if (bids[j][1] <= 0) j++;
  }
  return { qty, cost, profit, unlimited: false };
}

/** 卖价低于 price 的卖单从低往高买、按 price 卖出，最多买 cap（按均价卖时 = 对方交易所的日成交量） */
export function below(asks: Level[], price: number, cap = Infinity): Walk {
  let qty = 0, cost = 0, profit = 0;
  for (const [ask, count] of asks) {
    if (ask >= price || qty >= cap) break;
    const take = Math.min(count, cap - qty);
    if (!Number.isFinite(take)) return { qty, cost, profit, unlimited: true };
    qty += take;
    cost += take * ask;
    profit += take * (price - ask);
  }
  return { qty, cost, profit, unlimited: false };
}

interface Quote { bid: number | null; ask: number | null; avg: number | null; traded: number | null }
type Books = Map<string, [Level[], Level[]]>;
const key = (ticker: string, cx: string) => `${ticker}.${cx}`;

async function books(force: boolean): Promise<{ rows: SlimExchangeRow[]; books: Books }> {
  const rows = (await fio.exchangeFull(force)).filter(
    (r) => r.ticker && (COMPARED_EXCHANGES as readonly string[]).includes(r.exchange));
  const out: Books = new Map();
  for (const r of rows) out.set(key(r.ticker, r.exchange), [levels(r.selling, false), levels(r.buying, true)]);
  return { rows, books: out };
}

function fioQuotes(rows: SlimExchangeRow[]): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const r of rows) {
    out.set(key(r.ticker, r.exchange), {
      bid: r.bid || null, ask: r.ask || null,
      avg: r.traded && r.volume_amount ? r.volume_amount / r.traded : null,
      traded: r.traded || null,
    });
  }
  return out;
}

async function ppQuotes(force: boolean): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (const r of await pp.exchanges(force)) {
    if (!r.ticker || !(COMPARED_EXCHANGES as readonly string[]).includes(r.exchange_code)) continue;
    out.set(key(r.ticker, r.exchange_code), {
      bid: r.bid || null, ask: r.ask || null,
      avg: r.traded_daily ? r.vwap_daily : null,
      traded: r.traded_daily || null,
    });
  }
  return out;
}

/** 全部卖出价高于卖一价的 (材料, 买入交易所, 卖出交易所)，利润率高的在前 */
export async function opportunities(source: QuoteSource, sell: ArbitrageSell, force = false): Promise<ArbitrageResult> {
  const result: ArbitrageResult = { source, sell, exchanges: [], opportunities: [], warnings: [] };
  const { rows, books: bk } = await books(force);
  const quotes = source === "FIO" ? fioQuotes(rows) : await ppQuotes(force);

  const byTicker = new Map<string, Map<string, Quote>>();
  for (const [k, quote] of quotes) {
    const [ticker, cx] = k.split(".");
    if (!byTicker.has(ticker)) byTicker.set(ticker, new Map());
    byTicker.get(ticker)!.set(cx, quote);
  }
  const seenCx = new Set([...quotes.keys()].map((k) => k.split(".")[1]));
  result.exchanges = COMPARED_EXCHANGES.filter((c) => seenCx.has(c));

  let materials = new Map<string, { CategoryName: string; Weight: number; Volume: number }>();
  try {
    materials = new Map((await fio.materials()).map((m) => [m.Ticker, m]));
  } catch { /* 拿不到就不出重量体积 */ }

  const out: ArbitrageOpportunity[] = [];
  const times = (qty: number, per: number | undefined) => (per == null ? null : qty * per);
  for (const [ticker, perCx] of byTicker) {
    for (const [buyCx, here] of perCx) {
      const buyPrice = here.ask;
      if (!buyPrice) continue;
      const asks = bk.get(key(ticker, buyCx))?.[0] ?? [];
      for (const [sellCx, there] of perCx) {
        const sellPrice = sell === "bid" ? there.bid : there.avg;
        if (sellCx === buyCx || !sellPrice || sellPrice <= buyPrice) continue;
        const w = sell === "bid"
          ? walk(asks, bk.get(key(ticker, sellCx))?.[1] ?? [])
          : below(asks, sellPrice, there.traded ?? 0);
        const spread = sellPrice - buyPrice;
        const mat = materials.get(ticker);
        out.push({
          ticker, category: mat?.CategoryName ?? "",
          buy_exchange: buyCx as ExchangeCode, sell_exchange: sellCx as ExchangeCode,
          buy_price: buyPrice, sell_price: sellPrice,
          spread, margin: spread / buyPrice,
          same_currency: CURRENCY[buyCx] === CURRENCY[sellCx],
          quantity: w.qty, cost: w.cost, profit: w.profit, unlimited: w.unlimited,
          weight: times(w.qty, mat?.Weight), volume: times(w.qty, mat?.Volume),
          daily_traded: sell === "avg" ? there.traded : null,
        });
      }
    }
  }
  out.sort((a, b) => b.margin - a.margin);
  result.opportunities = out;
  return result;
}

function bookLevels(lvs: Level[]): BookLevel[] {
  return lvs.slice(0, BOOK_LEVELS).map(([price, count]) => ({ price, count: Number.isFinite(count) ? count : null }));
}

export async function book(ticker: string, buyCx: ExchangeCode, sellCx: ExchangeCode): Promise<ArbitrageBook> {
  const { books: bk } = await books(false);
  return {
    ticker, buy_exchange: buyCx, sell_exchange: sellCx,
    asks: bookLevels(bk.get(key(ticker, buyCx))?.[0] ?? []),
    bids: bookLevels(bk.get(key(ticker, sellCx))?.[1] ?? []),
  };
}
