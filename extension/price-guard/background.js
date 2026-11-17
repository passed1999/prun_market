/*
 * 后台：替内容脚本取参考价（refined-prices），整理后缓存在扩展的本地存储里，所有标签页共用。
 * Chrome / Edge 里它是 service worker，Firefox 里是事件页（core.js 由 manifest 先载入）。
 */
if (typeof importScripts === "function" && !globalThis.PriceGuardCore) {
  importScripts("core.js");
}

(() => {
  "use strict";
  const ext = globalThis.browser ?? globalThis.chrome;
  const Core = globalThis.PriceGuardCore;
  const PRICES_URL = "https://refined-prun.github.io/refined-prices/all.json";
  const MAX_AGE_MS = 15 * 60 * 1000;

  let inflight = null;

  async function refresh() {
    const response = await fetch(PRICES_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = { at: Date.now(), index: Core.buildIndex(await response.json()) };
    await ext.storage.local.set({ prices });
    return prices;
  }

  async function getPrices() {
    const { prices } = await ext.storage.local.get("prices");
    if (prices && prices.index && Date.now() - prices.at < MAX_AGE_MS) return prices;
    try {
      inflight ||= refresh().finally(() => { inflight = null; });
      return await inflight;
    } catch (e) {
      // 上游一时取不到：有旧的就先用旧的，并说明是旧的
      if (prices && prices.index) return { ...prices, error: String((e && e.message) || e) };
      throw e;
    }
  }

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "pg-prices") return undefined;
    getPrices().then(
      (prices) => sendResponse(prices),
      (e) => sendResponse({ error: String((e && e.message) || e) }),
    );
    return true;
  });
})();
