// node --test extension/test
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../price-guard/core.js");

// 2026-11-17 的 NA 行情（refined-prices），游戏里 rprun 显示 Refined PrUn Price = 25.2
const NA = [
  { MaterialTicker: "NA", ExchangeCode: "AI1", PriceAverage: 25.1, Ask: 26.5, Bid: 25.1, VWAP7D: 25.62, Traded7D: 7242, VWAP30D: 25.4, Traded30D: 91337 },
  { MaterialTicker: "NA", ExchangeCode: "CI1", PriceAverage: 25.1, Ask: 25.2, Bid: 25.1, VWAP7D: 25.11, Traded7D: 9575, VWAP30D: 25.12, Traded30D: 68933 },
  { MaterialTicker: "NA", ExchangeCode: "CI2", PriceAverage: 25, Ask: 25.1, Bid: 25, VWAP7D: null, Traded7D: null, VWAP30D: 25, Traded30D: 7000 },
  { MaterialTicker: "NA", ExchangeCode: "IC1", PriceAverage: 25.1, Ask: 25.3, Bid: 25.1, VWAP7D: 25.11, Traded7D: 27725, VWAP30D: 25.22, Traded30D: 119465 },
  { MaterialTicker: "NA", ExchangeCode: "NC1", PriceAverage: 25.1, Ask: 25.7, Bid: 25.1, VWAP7D: 25.14, Traded7D: 40641, VWAP30D: 25.95, Traded30D: 195868 },
  { MaterialTicker: "NA", ExchangeCode: "NC2", PriceAverage: 25.1, Ask: 25.1, Bid: 25, VWAP7D: 25.1, Traded7D: 87, VWAP30D: 25.04, Traded30D: 1338 },
];
const index = Core.buildIndex(NA);

test("参考价与 rprun 在 MAT 里显示的一致", () => {
  const ref = Core.refPrice(index, "NA", "UNIVERSE", "DEFAULT");
  assert.equal(ref.toFixed(1), "25.2");
  assert.equal(Core.refPrice(index, "na", "NC1", "ASK"), 25.7);
  assert.equal(Core.refPrice(index, "NA", "LOCAL", "VWAP7D", "ai1"), 25.62);
  // CI2 没有 7 日均价：DEFAULT 退到 30 日；指定 VWAP7D 则没有参考价
  assert.equal(Core.refPrice(index, "NA", "CI2", "DEFAULT"), 25);
  assert.equal(Core.refPrice(index, "NA", "CI2", "VWAP7D"), null);
  assert.equal(Core.refPrice(index, "XXX", "UNIVERSE", "DEFAULT"), null);
  assert.equal(Core.refPrice(null, "NA", "UNIVERSE", "DEFAULT"), null);
});

test("三种阈值各自生效，任何一项超过就拦", () => {
  const s = (o) => Core.normalize({ rel: null, unit: null, total: null, ...o });
  // 相对值：参考 25，限价 30 = +20%，刚好不超；30.01 超
  assert.equal(Core.evaluate(30, 100, 25, s({ rel: 20 })).ok, true);
  assert.deepEqual(Core.evaluate(30.01, 100, 25, s({ rel: 20 })).reasons.map((r) => r.kind), ["rel"]);
  // 单价绝对值
  assert.equal(Core.evaluate(45, 1, 25, s({ unit: 20 })).ok, true);
  assert.equal(Core.evaluate(45.5, 1, 25, s({ unit: 20 })).ok, false);
  // 总价绝对值：多付 = 5 × 数量
  assert.equal(Core.evaluate(30, 2000, 25, s({ total: 10000 })).ok, true);
  assert.equal(Core.evaluate(30, 2001, 25, s({ total: 10000 })).ok, false);
  // 都启用：只报超过的那几项
  const r = Core.evaluate(60, 10, 25, s({ rel: 20, unit: 20, total: 10000 }));
  assert.deepEqual(r.reasons.map((x) => x.kind), ["rel", "unit"]);
  // 比参考价便宜永远放行；阈值全关也放行
  assert.equal(Core.evaluate(10, 1e9, 25, s({ rel: 0, unit: 0, total: 0 })).ok, true);
  assert.equal(Core.evaluate(1000, 1000, 25, s({})).ok, true);
});

test("XIT SET-PRICE-GUARD：只有一条指令，后面跟「项目 值」", () => {
  for (const other of ["SET", "SET FIN", "BURN", "SET-REL 20", "SET-PRICE-GUARDIAN"]) {
    assert.equal(Core.parseCommand(other), null, other);
  }
  assert.deepEqual(Core.parseCommand("set-price-guard_rel_20"), { args: ["rel", "20"] });
  assert.deepEqual(Core.parseCommand("SET-PRICE-GUARD"), { args: [] });

  const run = (text, from) => Core.applyCommand(from || Core.DEFAULTS, Core.parseCommand(text));
  assert.equal(run("SET-PRICE-GUARD REL 15%").settings.rel, 15);
  assert.equal(run("SET-PRICE-GUARD UNIT 20").settings.unit, 20);
  assert.equal(run("SET-PRICE-GUARD TOTAL 10,000").settings.total, 10000);
  assert.equal(run("SET-PRICE-GUARD REL OFF").settings.rel, null);
  assert.equal(run("SET-PRICE-GUARD OFF").settings.enabled, false);
  assert.equal(run("SET-PRICE-GUARD ON", { enabled: false }).settings.enabled, true);
  assert.equal(run("SET-PRICE-GUARD REF ASK").settings.exchange, "UNIVERSE");

  // 一条指令里写多项
  const all = run("SET-PRICE-GUARD REL 20 UNIT 20 TOTAL 10000 REF NC1 VWAP30D OFF");
  assert.equal(all.error, false);
  assert.deepEqual(all.settings, { enabled: false, rel: 20, unit: 20, total: 10000, exchange: "NC1", method: "VWAP30D" });
  // REL OFF 关的是相对值，不是总开关
  assert.deepEqual(run("SET-PRICE-GUARD REL OFF TOTAL 500").settings, { ...Core.normalize(null), rel: null, total: 500 });

  // 不带参数只开面板；有一处写错整条都不执行
  assert.equal(run("SET-PRICE-GUARD").changed, false);
  for (const bad of ["SET-PRICE-GUARD REL abc", "SET-PRICE-GUARD REL -5", "SET-PRICE-GUARD TOTAL 1e9", "SET-PRICE-GUARD REF MOON",
    "SET-PRICE-GUARD WHAT 1", "SET-PRICE-GUARD REL", "SET-PRICE-GUARD UNIT 5 REL x", "SET-PRICE-GUARD 20"]) {
    const r = run(bad);
    assert.equal(r.error, true, bad);
    assert.equal(r.changed, false, bad);
    assert.deepEqual(r.settings, Core.normalize(null), bad);
  }
});
