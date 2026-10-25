/**
 * 把 {交易所, 口径} 解析成具体单价。
 *
 *   BID / ASK / AVG   FIO /exchange/all 的 Bid / Ask / PriceAverage
 *   PP7D / PP30D      PRUNplanner 公开行情的 vwap_7d / vwap_30d（成交额加权；它取「今天 + 前 N 天」
 *                     共 N+1 根日线，与 FIO 日线严格 N 根的算法差约 0.4%）
 *   UNIVERSE          不挑交易所：六个交易所的 30 日成交量加权平均；30 天内没成交的材料给不出价
 */
import { fio, pp } from "../data/sources";
import type { ExchangeCode, PriceSource } from "../api/types";

export const EXCHANGES: readonly ExchangeCode[] = ["AI1", "CI1", "CI2", "IC1", "NC1", "NC2"];
/** 比价与套利只看这几个：以 2 结尾的（CI2 / NC2）没什么人去 */
export const COMPARED_EXCHANGES: readonly ExchangeCode[] = ["AI1", "CI1", "IC1", "NC1"];

export async function universePrices(): Promise<Record<string, number>> {
  const value: Record<string, number> = {};
  const traded: Record<string, number> = {};
  for (const row of await pp.exchanges()) {
    const vwap = row.vwap_30d, volume = row.sum_traded_30d;
    if (!vwap || !volume) continue;
    value[row.ticker] = (value[row.ticker] ?? 0) + vwap * volume;
    traded[row.ticker] = (traded[row.ticker] ?? 0) + volume;
  }
  const out: Record<string, number> = {};
  for (const [t, v] of Object.entries(value)) if (traded[t]) out[t] = v / traded[t];
  return out;
}

/** {ticker: 单价}；解析不到的 ticker 不出现 */
export async function resolvePrices(
  tickers: string[], exchange: ExchangeCode, source: PriceSource,
): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  if (!tickers.length) return prices;
  const wanted = new Set(tickers);

  if (source === "UNIVERSE") {
    const universe = await universePrices();
    for (const t of tickers) if (t in universe) prices[t] = universe[t];
    return prices;
  }

  if (source === "PP7D" || source === "PP30D") {
    const field = source === "PP7D" ? "vwap_7d" : "vwap_30d";
    for (const row of await pp.exchanges()) {
      if (row.exchange_code !== exchange || !wanted.has(row.ticker)) continue;
      const v = row[field];
      if (v) prices[row.ticker] = v;
    }
    return prices;
  }

  const field = source === "BID" ? "Bid" : source === "AVG" ? "PriceAverage" : "Ask";
  for (const row of await fio.exchangeAll()) {
    if (row.ExchangeCode !== exchange || !wanted.has(row.MaterialTicker)) continue;
    const v = row[field];
    if (v != null) prices[row.MaterialTicker] = v;
  }
  return prices;
}
