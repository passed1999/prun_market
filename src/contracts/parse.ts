/**
 * 从「随便什么 json」里找材料清单。认得的形状：
 *
 *   { "RAT": 300, "DW": 400 }                         直接写的「材料: 数量」
 *   [{ ticker, amount, price? }, ...]                 rprun 合同 json 的 materials，FIO 的各种清单
 *   本工具的材料组（prun-matgroup，会去掉被排除的材料）
 *   XIT ACT 包 / PRUNplanner 购物车（groups[].materials）
 *
 * 做法是把整棵树走一遍，凡是长成上面两种形状的节点都算一份清单，所以嵌在别的结构里也找得到。
 */
import { activeMaterials, type MaterialGroup } from "../routes/model";

export interface MaterialSource {
  /** 给人看的名字：组名，或者它在 json 里的位置 */
  name: string;
  materials: Record<string, number>;
  /** 文件里自带的单价（只有合同 json 这类才有） */
  prices: Record<string, number>;
}

export class ParseError extends Error {}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** 材料代码：1–4 位字母数字（游戏里最长 3 位，留一点余量） */
const TICKER = /^[A-Za-z0-9]{1,4}$/;
const TICKER_KEYS = ["ticker", "Ticker", "MaterialTicker", "CommodityTicker", "material", "Material"];
const AMOUNT_KEYS = ["amount", "Amount", "MaterialAmount", "quantity", "Quantity", "units", "Units", "count", "Count"];
const PRICE_KEYS = ["price", "Price"];

function pick(o: Json, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

const emptySource = (name: string): MaterialSource => ({ name, materials: {}, prices: {} });

function add(src: MaterialSource, ticker: string, amount: unknown, price?: unknown) {
  const key = ticker.trim().toUpperCase();
  const qty = Math.round(Number(amount));
  if (!TICKER.test(key) || !Number.isFinite(qty) || qty <= 0) return;
  src.materials[key] = (src.materials[key] ?? 0) + qty;
  const p = Number(price);
  if (price !== undefined && Number.isFinite(p) && p > 0) src.prices[key] = p;
}

/** { "RAT": 300, ... }：键全是材料代码、值全是数字 */
function fromMap(o: Json, name: string): MaterialSource | null {
  const entries = Object.entries(o);
  if (!entries.length) return null;
  if (!entries.every(([k, v]) => TICKER.test(k.trim()) && typeof v !== "boolean" && v !== "" && Number.isFinite(Number(v)) && !isObj(v) && !Array.isArray(v) && v !== null)) return null;
  const src = emptySource(name);
  for (const [k, v] of entries) add(src, k, v);
  return Object.keys(src.materials).length ? src : null;
}

/** [{ ticker, amount, price? }, ...] */
function fromList(list: unknown[], name: string): MaterialSource | null {
  if (!list.length || !list.every(isObj)) return null;
  const src = emptySource(name);
  for (const row of list as Json[]) {
    const ticker = pick(row, TICKER_KEYS);
    const amount = pick(row, AMOUNT_KEYS);
    if (typeof ticker !== "string" || amount === undefined) return null;
    add(src, ticker, amount, pick(row, PRICE_KEYS));
  }
  return Object.keys(src.materials).length ? src : null;
}

function walk(node: unknown, name: string, out: MaterialSource[], depth: number) {
  if (depth > 8) return;
  if (Array.isArray(node)) {
    const src = fromList(node, name);
    if (src) { out.push(src); return; }
    node.forEach((child, i) => {
      const label = isObj(child) && typeof child.name === "string" && child.name ? child.name : `${name}[${i + 1}]`;
      walk(child, label, out, depth + 1);
    });
    return;
  }
  if (!isObj(node)) return;
  const src = fromMap(node, name);
  if (src) { out.push(src); return; }
  const own = typeof node.name === "string" && node.name ? node.name : "";
  for (const [key, child] of Object.entries(node)) {
    if (typeof child !== "object" || child === null) continue;
    // 「materials」这种键本身没信息量，用所在对象的名字
    const label = key === "materials" || key === "Materials" ? (own || name) : (own ? `${own} / ${key}` : key);
    walk(child, label, out, depth + 1);
  }
}

export function extractMaterials(text: string, fallbackName = "粘贴的内容"): MaterialSource[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ParseError("这不是合法的 JSON。");
  }
  if (isObj(data) && data.format === "prun-matgroup" && isObj(data.materials)) {
    const src = emptySource(typeof data.name === "string" && data.name ? data.name : fallbackName);
    for (const [t, n] of Object.entries(activeMaterials(data as unknown as MaterialGroup))) add(src, t, n);
    if (Object.keys(src.materials).length) return [src];
  }
  const root = isObj(data) && isObj(data.global) && typeof data.global.name === "string" ? data.global.name : fallbackName;
  const out: MaterialSource[] = [];
  walk(data, root, out, 0);
  if (!out.length) throw new ParseError("这段 json 里没找到材料清单（「材料: 数量」或带 ticker / amount 的列表）。");
  return out;
}

/** 把选中的几份清单并成一份：数量相加，单价取后出现的 */
export function mergeSources(sources: MaterialSource[]): MaterialSource {
  const merged = emptySource(sources.map((s) => s.name).join(" + "));
  for (const s of sources) {
    for (const [t, n] of Object.entries(s.materials)) merged.materials[t] = (merged.materials[t] ?? 0) + n;
    Object.assign(merged.prices, s.prices);
  }
  return merged;
}
