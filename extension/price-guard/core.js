/*
 * 价格提醒的纯计算部分：参考价、阈值判断、XIT SET-PRICE-GUARD 指令解析。不碰页面，也不碰扩展 API。
 * 内容脚本、后台脚本、node 测试共用这一份。
 */
(function (root) {
  "use strict";

  const METHODS = ["DEFAULT", "ASK", "BID", "AVG", "VWAP7D", "VWAP30D"];
  /** UNIVERSE = 各交易所合起来（rprun 的默认）；LOCAL = 下单所在的那个交易所 */
  const EXCHANGES = ["UNIVERSE", "LOCAL", "AI1", "CI1", "CI2", "IC1", "NC1", "NC2"];

  /** rel / unit / total 为 null 表示这一项不启用 */
  const DEFAULTS = Object.freeze({
    enabled: true,
    rel: 20,
    unit: null,
    total: null,
    exchange: "UNIVERSE",
    method: "DEFAULT",
  });

  const present = (v) => v !== null && v !== undefined && Number.isFinite(v);

  /** 与 rprun 的 weightedAverage 同一口径：缺值的交易所不参与 */
  function weightedAverage(items, value, weight) {
    let sum = null;
    let weights = null;
    for (const item of items) {
      const v = value(item);
      const w = weight ? weight(item) : 1;
      if (!present(v) || !present(w)) continue;
      sum = (sum ?? 0) + v * w;
      weights = (weights ?? 0) + w;
    }
    if (sum === null || weights === null || weights === 0) return null;
    return sum / weights;
  }

  const pick = (v) => (present(v) ? v : null);

  /**
   * refined-prices 的 all.json → { 交易所: { 材料: { ask, bid, avg, v7, v30, t7, t30 } } }，
   * 并按 rprun 的算法补上 UNIVERSE。
   */
  function buildIndex(raw) {
    const index = {};
    const tickers = new Set();
    for (const r of Array.isArray(raw) ? raw : []) {
      if (!r || !r.ExchangeCode || !r.MaterialTicker) continue;
      const cx = (index[r.ExchangeCode] ||= {});
      cx[r.MaterialTicker] = {
        ask: pick(r.Ask),
        bid: pick(r.Bid),
        avg: pick(r.PriceAverage),
        v7: pick(r.VWAP7D),
        v30: pick(r.VWAP30D),
        t7: pick(r.Traded7D),
        t30: pick(r.Traded30D),
      };
      tickers.add(r.MaterialTicker);
    }
    const codes = Object.keys(index);
    const universe = {};
    for (const t of tickers) {
      const infos = codes.map((c) => index[c][t]).filter(Boolean);
      universe[t] = {
        ask: weightedAverage(infos, (x) => x.ask),
        bid: weightedAverage(infos, (x) => x.bid),
        avg: weightedAverage(infos, (x) => x.avg),
        v7: weightedAverage(infos, (x) => x.v7, (x) => x.t7),
        v30: weightedAverage(infos, (x) => x.v30, (x) => x.t30),
        t7: null,
        t30: null,
      };
    }
    index.UNIVERSE = universe;
    return index;
  }

  /**
   * 参考价（即 MAT 窗口里的 Refined PrUn Price）。没有数据时返回 null。
   * localCx：下单所在的交易所，exchange 为 LOCAL 时用它。
   */
  function refPrice(index, ticker, exchange, method, localCx) {
    if (!index || !ticker) return null;
    const code = exchange === "LOCAL" ? String(localCx || "").toUpperCase() : exchange;
    const info = index[code] && index[code][String(ticker).toUpperCase()];
    if (!info) return null;
    let price;
    switch (method) {
      case "ASK": price = info.ask; break;
      case "BID": price = info.bid; break;
      case "AVG": price = info.avg; break;
      case "VWAP7D": price = info.v7; break;
      case "VWAP30D": price = info.v30; break;
      default: price = info.v7 ?? info.v30 ?? info.avg ?? info.ask ?? info.bid;
    }
    return present(price) && price > 0 ? price : null;
  }

  const EPS = 1e-9;

  /**
   * 判断一笔买单超没超。任何一项启用的阈值被超过就算超。
   *   rel   单价比参考价高出的百分比
   *   unit  单价比参考价高出的金额
   *   total 整单比按参考价买多付的金额（高出的单价 × 数量）
   */
  function evaluate(price, qty, ref, settings) {
    const over = price - ref;
    const relPct = (over / ref) * 100;
    const overTotal = over * (present(qty) && qty > 0 ? qty : 0);
    const reasons = [];
    if (over > EPS) {
      if (present(settings.rel) && relPct > settings.rel + EPS) {
        reasons.push({ kind: "rel", limit: settings.rel, actual: relPct });
      }
      if (present(settings.unit) && over > settings.unit + EPS) {
        reasons.push({ kind: "unit", limit: settings.unit, actual: over });
      }
      if (present(settings.total) && overTotal > settings.total + EPS) {
        reasons.push({ kind: "total", limit: settings.total, actual: overTotal });
      }
    }
    return { ok: reasons.length === 0, over, relPct, overTotal, reasons };
  }

  function normalize(s) {
    const out = { ...DEFAULTS, ...(s && typeof s === "object" ? s : {}) };
    out.enabled = out.enabled !== false;
    for (const k of ["rel", "unit", "total"]) {
      out[k] = present(out[k]) && out[k] >= 0 ? out[k] : null;
    }
    if (!EXCHANGES.includes(out.exchange)) out.exchange = DEFAULTS.exchange;
    if (!METHODS.includes(out.method)) out.method = DEFAULTS.method;
    return out;
  }

  // ---------- XIT SET-PRICE-GUARD ----------

  /** 只有这一条指令；后面可以跟任意多组「项目 值」 */
  const COMMAND = "SET-PRICE-GUARD";
  const USAGE = [
    "XIT SET-PRICE-GUARD —— 只打开设置面板",
    "XIT SET-PRICE-GUARD REL 20 UNIT 20 TOTAL 10000 —— 相对值（%）、单价绝对值、总价绝对值，写哪项改哪项",
    "XIT SET-PRICE-GUARD REL OFF —— 数值换成 OFF 就是关掉那一项",
    "XIT SET-PRICE-GUARD REF UNIVERSE VWAP7D —— 参考价的交易所与算法",
    "XIT SET-PRICE-GUARD OFF / ON —— 总开关",
  ];
  const NAMES = ["SET-PRICE-GUARD"];
  const OFF_WORDS = ["OFF", "NONE", "NO", "-", "关", "关闭"];
  const ON_WORDS = ["ON", "YES", "开", "开启"];

  /** "SET-PRICE-GUARD REL 20" / "set-price-guard_rel_20" → { args: ["REL", "20"] }；不是这条指令返回 null */
  function parseCommand(parameter) {
    const parts = String(parameter || "").trim().split(/[_ ]+/g).filter(Boolean);
    if (!parts.length || !NAMES.includes(parts[0].toUpperCase())) return null;
    return { args: parts.slice(1) };
  }

  function parseAmount(text) {
    const cleaned = String(text).replace(/[,，%％\s]/g, "");
    if (cleaned === "" || !/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return NaN;
    return Number(cleaned);
  }

  const LABEL = { rel: "相对值", unit: "单价绝对值", total: "总价绝对值" };

  /**
   * 把指令作用到设置上。返回 { settings, changed, message, error }。
   * 不带参数不改设置（只是打开面板）；有一处写错就整条都不执行。
   */
  function applyCommand(current, cmd) {
    const before = normalize(current);
    const settings = { ...before };
    const fail = (message) => ({ settings: before, changed: false, message, error: true });
    const args = cmd.args;
    if (!args.length) return { settings, changed: false, message: "", error: false };
    const notes = [];

    for (let i = 0; i < args.length; i++) {
      const word = args[i].toUpperCase();
      if (ON_WORDS.includes(word)) { settings.enabled = true; notes.push("价格提醒已开启"); continue; }
      if (OFF_WORDS.includes(word)) { settings.enabled = false; notes.push("价格提醒已关闭，买单不再拦截"); continue; }
      if (word === "REL" || word === "UNIT" || word === "TOTAL") {
        const key = word.toLowerCase();
        const raw = args[++i];
        if (raw === undefined) return fail(`${word} 后面要跟一个数值或 OFF。例：XIT SET-PRICE-GUARD ${word} ${key === "total" ? 10000 : 20}`);
        if (OFF_WORDS.includes(raw.toUpperCase())) { settings[key] = null; notes.push(`${LABEL[key]}已关闭`); continue; }
        const n = parseAmount(raw);
        if (!Number.isFinite(n)) return fail(`${word} 后面的「${raw}」不是数字。例：XIT SET-PRICE-GUARD ${word} ${key === "total" ? 10000 : 20}`);
        settings[key] = n;
        notes.push(`${LABEL[key]}设为 ${n}${key === "rel" ? "%" : ""}`);
        continue;
      }
      if (word === "REF") {
        let taken = 0;
        while (i + 1 < args.length) {
          const u = args[i + 1].toUpperCase();
          if (EXCHANGES.includes(u)) settings.exchange = u;
          else if (METHODS.includes(u)) settings.method = u;
          else break;
          i++;
          taken++;
        }
        if (!taken) return fail(`REF 后面要跟交易所或算法。交易所：${EXCHANGES.join(" / ")}；算法：${METHODS.join(" / ")}`);
        notes.push(`参考价改为 ${settings.exchange} · ${settings.method}`);
        continue;
      }
      return fail(`不认识「${args[i]}」，整条指令没有执行。可以写的项目：REL / UNIT / TOTAL / REF / ON / OFF`);
    }
    return { settings, changed: true, message: `${notes.join("；")}。`, error: false };
  }

  const api = {
    METHODS, EXCHANGES, DEFAULTS, COMMAND, USAGE,
    buildIndex, refPrice, evaluate, normalize, parseCommand, parseAmount, applyCommand,
  };
  root.PriceGuardCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
