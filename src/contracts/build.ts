/**
 * 把一份材料清单写成 Refined PrUn 认的两种 json（字段名对照 rprun 源码 2026-11 的版本）：
 *
 *   XIT ACT 包       { global: { name }, groups: [...], actions: [...] }
 *                    组：Manual（数量写在包里，不带价格）或 Paste（执行时粘贴「代码,数量,单价」）
 *                    动作：CX Buy / MTRA / CONT Ship / CONT Trade
 *   合同 json        CONTD 界面的导入框（contd-import-export）读的那种：
 *                    { type: BUY | SELL | SHIP, currency, deadline, location | origin + destination
 *                      + payment + autoProvision, materials: [{ ticker, amount, price? }] }
 *
 * 单价都是「每件」的价。合同里的单价游戏最多收两位小数，范围 0.01 – 100,000,000。
 */

/** rprun 里表示「执行时再选」的固定字符串 */
export const CONFIGURE = "Configure on Execution";
export const MIN_PRICE = 0.01;
export const MAX_PRICE = 100_000_000;
export const MIN_DAYS = 1;
export const MAX_DAYS = 99;

export const CURRENCIES = ["AIC", "CIS", "ICA", "NCC", "ECD"] as const;
export const EXCHANGE_CURRENCY: Record<string, string> = {
  AI1: "AIC", CI1: "CIS", CI2: "CIS", IC1: "ICA", NC1: "NCC", NC2: "NCC",
};

export interface Line { ticker: string; amount: number; price?: number }

// ---- 价格 ----

/** 合同单价：两位小数，夹在游戏允许的范围里；给不出价时为 undefined */
export function contractPrice(v: number | null | undefined): number | undefined {
  if (v == null || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(MAX_PRICE, Math.max(MIN_PRICE, Math.round(v * 100) / 100));
}

/**
 * Paste 组的单价：rprun 只收不超过 3 位有效数字、不超过两位小数的价（多了它直接报错，不替你取整）。
 */
export function pastePrice(v: number): number {
  const three = Number(v.toPrecision(3));
  return Math.max(MIN_PRICE, Math.round(three * 100) / 100);
}

/** Paste 组执行时要粘贴的内容：每行「代码,数量[,单价]」 */
export function pasteText(lines: Line[]): string {
  return lines.map((l) => (l.price === undefined ? `${l.ticker},${l.amount}` : `${l.ticker},${l.amount},${pastePrice(l.price)}`)).join("\n");
}

// ---- ACT 包 ----

export type ActionType = "CX Buy" | "MTRA" | "CONT Ship" | "CONT Trade";
export const ACTION_TYPES: ActionType[] = ["CX Buy", "MTRA", "CONT Ship", "CONT Trade"];

/** 页面上一个动作的全部可填项；写出时只取该类型用到的 */
export interface ActionForm {
  id: string;
  type: ActionType;
  // CX Buy
  exchange: string;
  useCXInv: boolean;
  buyPartial: boolean;
  allowUnfilled: boolean;
  /** 把价格表里的单价当作限价写进 priceLimits */
  priceLimits: boolean;
  // MTRA
  origin: string;
  dest: string;
  // CONT Ship / CONT Trade
  currency: string;
  daysToFulfill: number;
  contOrigin: string;
  contDest: string;
  paymentPerTon: number;
  autoProvision: boolean;
  contTradeType: "BUYING" | "SELLING";
  contLocation: string;
}

export function newAction(type: ActionType, id: string, currency = "AIC"): ActionForm {
  return {
    id, type,
    exchange: CONFIGURE, useCXInv: true, buyPartial: false, allowUnfilled: false, priceLimits: false,
    origin: CONFIGURE, dest: CONFIGURE,
    currency, daysToFulfill: 3, contOrigin: CONFIGURE, contDest: CONFIGURE, paymentPerTon: 0, autoProvision: false,
    contTradeType: "BUYING", contLocation: CONFIGURE,
  };
}

/** 包里的名字只用英文字母、数字和连字符：插件遇到别的字符会出问题 */
export function ascii(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const days = (v: number) => Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(Number(v)) || 3));

export interface ActPackOptions {
  name: string;
  groupName: string;
  groupType: "Manual" | "Paste";
  actions: ActionForm[];
}

export interface Built {
  json: unknown;
  /** Paste 组执行时要粘贴的内容 */
  paste?: string;
  warnings: string[];
}

export function buildActPack(lines: Line[], o: ActPackOptions): Built {
  const warnings: string[] = [];
  const name = ascii(o.name) || "contract";
  const group = ascii(o.groupName) || "materials";
  if (!lines.length) warnings.push("材料清单是空的。");

  const unpriced = lines.filter((l) => l.price === undefined).map((l) => l.ticker);
  const used = new Map<string, number>();
  const actions = o.actions.map((a) => {
    const slug = a.type.toLowerCase().replace(/\s+/g, "-");
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    const base = { type: a.type, name: `${slug}-${n}`, group };
    switch (a.type) {
      case "CX Buy": {
        const out: Record<string, unknown> = {
          ...base, exchange: a.exchange || CONFIGURE,
          useCXInv: a.useCXInv, buyPartial: a.buyPartial, allowUnfilled: a.allowUnfilled,
        };
        if (a.priceLimits && o.groupType === "Manual") {
          out.priceLimits = Object.fromEntries(lines.filter((l) => l.price !== undefined).map((l) => [l.ticker, l.price]));
        }
        return out;
      }
      case "MTRA":
        return { ...base, origin: a.origin.trim() || CONFIGURE, dest: a.dest.trim() || CONFIGURE };
      case "CONT Ship":
        return {
          ...base, contOrigin: a.contOrigin.trim() || CONFIGURE, contDest: a.contDest.trim() || CONFIGURE,
          currency: a.currency, paymentPerTon: Math.max(0, Number(a.paymentPerTon) || 0),
          daysToFulfill: days(a.daysToFulfill), autoProvision: a.autoProvision,
        };
      default:
        return {
          ...base, contTradeType: a.contTradeType, contLocation: a.contLocation.trim() || CONFIGURE,
          currency: a.currency, daysToFulfill: days(a.daysToFulfill),
        };
    }
  });

  const hasTrade = o.actions.some((a) => a.type === "CONT Trade");
  if (hasTrade && o.groupType === "Manual") {
    warnings.push("CONT Trade 要每种材料都有单价，而 Manual 组存不了价格，执行时会报错。请把材料组类型改成 Paste。");
  }
  if (o.groupType === "Paste") {
    if (hasTrade && unpriced.length) warnings.push(`这些材料没有单价，CONT Trade 会拒绝执行：${unpriced.join("、")}`);
    const rounded = lines.filter((l) => l.price !== undefined && pastePrice(l.price) !== l.price).map((l) => l.ticker);
    if (rounded.length) warnings.push(`Paste 组的单价最多 3 位有效数字，这些材料的价被取整了：${rounded.join("、")}`);
  }

  const groups = o.groupType === "Paste"
    ? [{ type: "Paste", name: group }]
    : [{ type: "Manual", name: group, materials: Object.fromEntries(lines.map((l) => [l.ticker, l.amount])) }];
  return {
    json: { global: { name }, groups, actions },
    paste: o.groupType === "Paste" ? pasteText(lines) : undefined,
    warnings,
  };
}

// ---- 合同 json ----

export type ContractType = "BUY" | "SELL" | "SHIP";

export interface ContractOptions {
  type: ContractType;
  currency: string;
  deadline: number;
  location: string;
  origin: string;
  destination: string;
  /** SHIP 的运费总额 */
  payment: number;
  autoProvision: boolean;
}

export function buildContract(lines: Line[], o: ContractOptions): Built {
  const warnings: string[] = [];
  if (!lines.length) warnings.push("材料清单是空的。");
  const out: Record<string, unknown> = { type: o.type, currency: o.currency };
  if (o.type === "SHIP") {
    if (o.origin.trim()) out.origin = o.origin.trim(); else warnings.push("没填起点，导入后要在游戏里自己选。");
    if (o.destination.trim()) out.destination = o.destination.trim(); else warnings.push("没填终点，导入后要在游戏里自己选。");
    out.autoProvision = o.autoProvision;
    const payment = Math.round(Number(o.payment));
    if (payment > 0) out.payment = payment; else warnings.push("没填运费，导入后要在游戏里自己填。");
  } else if (o.location.trim()) {
    out.location = o.location.trim();
  } else {
    warnings.push("没填地点，导入后要在游戏里自己选。");
  }
  out.deadline = days(o.deadline);
  if (o.type === "SHIP") {
    out.materials = lines.map((l) => ({ ticker: l.ticker, amount: l.amount }));
  } else {
    const unpriced = lines.filter((l) => l.price === undefined).map((l) => l.ticker);
    if (unpriced.length) warnings.push(`这些材料没有单价，导入后价格那一格是空的：${unpriced.join("、")}`);
    out.materials = lines.map((l) => (l.price === undefined
      ? { ticker: l.ticker, amount: l.amount }
      : { ticker: l.ticker, amount: l.amount, price: l.price }));
  }
  return { json: out, warnings };
}
