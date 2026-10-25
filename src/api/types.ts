// 与 prun_selfplanner 的 web/src/api/types.ts 同名同形（snake_case），只留三页用到的部分。

export type ExchangeCode = "AI1" | "CI1" | "CI2" | "IC1" | "NC1" | "NC2";
export type PriceSource = "BID" | "ASK" | "AVG" | "PP7D" | "PP30D" | "UNIVERSE";

// ---- 全服市场 ----

export interface MarketUniverseMonth {
  month: string;
  label: string;
  /** 全服日产值 */
  volume: number;
  bases: number;
  companies: number;
}

/** exact 只来自配方且上游唯一；approx 含等权拆分或估算的工人消费；partial 还有建造/造船没算 */
export type MarketConfidence = "exact" | "approx" | "partial";

export interface MarketMaterialRow {
  ticker: string;
  category: string;
  amount: number;
  volume: number;
  line_consumption: number;
  workforce_consumption: number;
  net_flow: number;
  confidence: MarketConfidence;
  historical_consumed: number | null;
  producer_count: number;
  /** 前四大生产商占比 */
  cr4: number;
  /** Σ 份额²，0–1，越大越集中 */
  hhi: number;
}

export interface MarketSnapshot {
  month: string;
  label: string;
  months: string[];
  consumed_until: string | null;
  universe: MarketUniverseMonth[];
  materials: MarketMaterialRow[];
  workforce_estimate: Record<string, number>;
}

export interface MarketProducer {
  company_id: string;
  name: string;
  corp: string;
  amount: number;
  share: number;
}

export interface MarketRecipeUse {
  recipe_id: string;
  building_ticker: string;
  daily_amount: number;
}

export interface MarketMaterialPoint {
  month: string;
  label: string;
  amount: number;
  volume: number;
  demand: number;
  consumed: number | null;
}

export interface MarketMaterial {
  ticker: string;
  month: string;
  label: string;
  latest: MarketMaterialRow;
  series: MarketMaterialPoint[];
  producers: MarketProducer[];
  consumed_by: MarketRecipeUse[];
  made_by: MarketRecipeUse[];
}

export interface MarketCompany {
  company_id: string;
  name: string;
  corp: string;
  volume: number;
  rank: number;
}

// ---- 套利 ----

export type QuoteSource = "FIO" | "PRUNPLANNER";
export type ArbitrageSell = "bid" | "avg";

export interface ArbitrageOpportunity {
  ticker: string;
  category: string;
  buy_exchange: ExchangeCode;
  sell_exchange: ExchangeCode;
  buy_price: number;
  sell_price: number;
  spread: number;
  margin: number;
  same_currency: boolean;
  quantity: number | null;
  cost: number | null;
  weight: number | null;
  volume: number | null;
  profit: number | null;
  unlimited: boolean;
  daily_traded: number | null;
}

export interface ArbitrageResult {
  source: QuoteSource;
  sell: ArbitrageSell;
  exchanges: ExchangeCode[];
  opportunities: ArbitrageOpportunity[];
  warnings: string[];
}

/** count 为 null：这一档有做市商单，不限量 */
export interface BookLevel {
  price: number;
  count: number | null;
}

export interface ArbitrageBook {
  ticker: string;
  buy_exchange: ExchangeCode;
  sell_exchange: ExchangeCode;
  asks: BookLevel[];
  bids: BookLevel[];
}

// ---- 面积利润 ----

export interface ProfitLine {
  ticker: string;
  amount: number;
}

export interface ProfitRecipe {
  recipe_id: string;
  building: string;
  area: number;
  outputs: ProfitLine[];
  inputs: ProfitLine[];
  workforce: ProfitLine[];
  build_cost: number;
  build_unpriced: string[];
}

export interface ProfitAnalysis {
  ticker: string;
  exchange: ExchangeCode;
  price_source: PriceSource;
  sell_exchange: ExchangeCode;
  sell_price_source: PriceSource;
  recipes: ProfitRecipe[];
  buy_prices: Record<string, number>;
  sell_prices: Record<string, number>;
  categories: Record<string, string>;
  daily_traded: number | null;
}

// ---- 上游原始数据（只列用到的字段）----

export interface FioMaterial {
  Ticker: string;
  CategoryName: string;
  Weight: number;
  Volume: number;
}

export interface FioBuilding {
  Ticker: string;
  AreaCost: number;
  Pioneers: number;
  Settlers: number;
  Technicians: number;
  Engineers: number;
  Scientists: number;
  BuildingCosts: { CommodityTicker: string; Amount: number }[] | null;
}

export interface FioRecipe {
  BuildingTicker: string;
  StandardRecipeName: string;
  TimeMs: number;
  Inputs: { Ticker: string; Amount: number }[] | null;
  Outputs: { Ticker: string; Amount: number }[] | null;
}

export interface FioWorkforceNeeds {
  WorkforceType: string;
  Needs: { MaterialTicker: string; Amount: number }[] | null;
}

/** /exchange/all 的一行（/exchange/full 也含这些字段）*/
export interface FioExchangeRow {
  MaterialTicker: string;
  ExchangeCode: string;
  Bid: number | null;
  Ask: number | null;
  PriceAverage: number | null;
  Supply: number | null;
  Demand: number | null;
  Traded: number | null;
  VolumeAmount: number | null;
}

export interface FioOrder {
  ItemCost: number;
  /** null = 做市商单，不限量 */
  ItemCount: number | null;
}

export interface FioExchangeFullRow extends FioExchangeRow {
  BuyingOrders: FioOrder[] | null;
  SellingOrders: FioOrder[] | null;
}

/** PRUNplanner 公开行情 /data/exchanges/ 的一行 */
export interface PpExchangeRow {
  ticker: string;
  exchange_code: string;
  bid: number | null;
  ask: number | null;
  vwap_daily: number | null;
  traded_daily: number | null;
  vwap_7d: number | null;
  vwap_30d: number | null;
  sum_traded_30d: number | null;
  avg_traded_7d: number | null;
}

export type StatsUniverse = Record<string, {
  volume: number; profit: number | null; bases: number; companies: number;
} | null>;
export type StatsProduction = Record<string, {
  amount: number; volume: number; consumed?: number | null; profit?: number | null;
}>;
export interface StatsCompanies {
  totals: Record<string, { volume: number; volumeRank: number }>;
  individual: Record<string, Record<string, { amount: number; volume: number; rank: number }>>;
}
export type StatsKnownCompanies = Record<string, { Username?: string; Corporation?: string }>;
