import * as market from "@services/market";
import * as arbitrage from "@services/arbitrage";
import * as profit from "@services/profit";

export async function run(month: string) {
  return {
    snapshot: await market.snapshot(month),
    material_rat: await market.material("RAT", month),
    material_ins: await market.material("INS", month),
    companies: await market.topCompanies(month, 100),
    arb_fio_bid: await arbitrage.opportunities("FIO", "bid"),
    arb_fio_avg: await arbitrage.opportunities("FIO", "avg"),
    arb_pp_bid: await arbitrage.opportunities("PRUNPLANNER", "bid"),
    arb_pp_avg: await arbitrage.opportunities("PRUNPLANNER", "avg"),
    book: await arbitrage.book("RAT", "NC1", "CI1"),
    profit_rat: await profit.analyze("RAT", { exchange: "NC1", price_source: "ASK", sell_exchange: "NC1", sell_price_source: "BID" }),
    profit_bse: await profit.analyze("BSE", { exchange: "CI1", price_source: "AVG", sell_exchange: "AI1", sell_price_source: "UNIVERSE" }),
  };
}
