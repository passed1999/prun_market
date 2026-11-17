/*
 * PrUn Price Guard —— 内容脚本
 *
 *   1. CXPO（下单）窗口里点 BUY 时，拿限价和参考价比；超过设定的阈值就拦下这次点击并提醒。
 *      参考价 = Refined PrUn 在 MAT 窗口里显示的「Refined PrUn Price」，数据同源、算法相同，
 *      但本扩展自己取数，不依赖 rprun；两者同时装也不冲突。
 *   2. XIT SET-PRICE-GUARD 窗口：设置阈值（只有这一条指令，例：XIT SET-PRICE-GUARD REL 20 UNIT 20 TOTAL 10000）。
 *
 * 只看限价：成交价不会高于限价，所以限价没超就一定没超。
 * 拦截的是点击事件本身，所以 rprun 的 XIT ACT 自动下单也会被拦。
 * 界面的 class 名取自 2026-11 的游戏版本与 rprun 源码；游戏更新后若找不到输入框，买单会被拦下并说明原因。
 */
(() => {
  "use strict";
  if (window.__prunPriceGuard) return;
  window.__prunPriceGuard = true;

  const Core = globalThis.PriceGuardCore;
  const ext = globalThis.__pgExt ?? globalThis.browser ?? globalThis.chrome;
  const PRICES_URL = "https://refined-prun.github.io/refined-prices/all.json";
  const PRICE_POLL_MS = 5 * 60 * 1000;
  const BYPASS_MS = 15 * 1000;

  let settings = Core.normalize(null);
  let applied = {}; // 窗口 id → 已经执行过的指令，避免刷新页面时重复执行
  let prices = { at: 0, index: null, error: "" };

  // ---------- 小工具 ----------

  const q = (root, name) => root.querySelector(`[class*="${name}"]`);
  const cmdOf = (frame) => { const c = q(frame, "TileFrame__cmd"); return c ? c.textContent.trim() : ""; };
  const num = (text) => {
    const cleaned = String(text ?? "").replace(/[,\s]/g, "");
    return cleaned === "" ? NaN : Number(cleaned);
  };
  const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtPrice = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function setClass(node, cls) { if (node.className !== cls) node.className = cls; }
  function setHidden(node, hidden) { if (node.hidden !== hidden) node.hidden = hidden; }

  const refSourceText = (cx) => `${settings.exchange === "LOCAL" ? cx || "下单的交易所" : settings.exchange} · ${settings.method}`;

  // ---------- 存储与参考价 ----------

  function saveSettings(next) {
    settings = Core.normalize(next);
    ext.storage.local.set({ settings }).catch(() => {});
    refreshAll();
  }

  async function loadPrices() {
    try {
      const res = await ext.runtime.sendMessage({ type: "pg-prices" });
      if (!res || !res.index) throw new Error((res && res.error) || "后台没有回应");
      prices = { at: res.at, index: res.index, error: res.error || "" };
    } catch (first) {
      // 后台不可用（比如扩展刚被重新加载）：直接取一次
      try {
        const response = await fetch(PRICES_URL, { cache: "no-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        prices = { at: Date.now(), index: Core.buildIndex(await response.json()), error: "" };
      } catch (second) {
        prices = { ...prices, error: String((second && second.message) || second) };
      }
    }
    refreshAll();
  }

  function pricesStatus() {
    if (!prices.index) return prices.error ? `参考价读取失败：${prices.error}` : "参考价正在读取…";
    const minutes = Math.max(0, Math.round((Date.now() - prices.at) / 60000));
    const count = Object.keys(prices.index.UNIVERSE || {}).length;
    return `参考价：${count} 种材料，${minutes} 分钟前更新`
      + (prices.error ? `（最近一次更新失败：${prices.error}，用的是旧数据）` : "");
  }

  // ---------- CXPO：判断一笔买单 ----------

  /**
   * 返回 { block, level, text, key }。
   *   block  点 BUY 时要不要拦
   *   level  ok / warn / over / off —— 提示条的颜色
   *   key    这一笔的指纹（材料 + 限价 + 数量），放行只对同一笔有效
   */
  function inspect(frame, form) {
    const m = /^CXPO\s+([A-Z0-9]+)\.([A-Z0-9]+)/i.exec(cmdOf(frame));
    if (!m) return null;
    const ticker = m[1].toUpperCase();
    const cx = m[2].toUpperCase();
    if (!settings.enabled) return { block: false, level: "off", text: "价格提醒已关闭（XIT SET-PRICE-GUARD ON 开启）", key: "" };

    const inputs = form.querySelectorAll("input");
    const qtyInput = inputs[0];
    const priceInput = inputs[1];
    if (!qtyInput || !priceInput) {
      return { block: true, level: "warn", text: "找不到数量 / 限价输入框，游戏界面可能更新了，无法判断价格。", key: `${ticker}|?` };
    }
    const qty = num(qtyInput.value);
    const priceText = priceInput.value.trim();
    let price = num(priceText);
    let fromPlaceholder = false;
    if (priceText === "") {
      // rprun 的自动限价：鼠标停在 BUY 上时，占位符就是它将要填进去的价
      const hint = num(priceInput.placeholder);
      if (Number.isFinite(hint) && hint > 0) { price = hint; fromPlaceholder = true; }
    }
    const key = `${ticker}.${cx}|${Number.isFinite(price) ? price : priceText}|${Number.isFinite(qty) ? qty : ""}`;

    const ref = Core.refPrice(prices.index, ticker, settings.exchange, settings.method, cx);
    const refText = ref === null ? "" : `参考价 ${fmtPrice(ref)}（${refSourceText(cx)}）`;

    if (priceText === "" && !fromPlaceholder) {
      // 占位符是 Auto：rprun 会先把价填进去而不下单，放它过去，下一次点击再判断
      const rprunWillFill = /^auto$/i.test(priceInput.placeholder || "");
      return {
        block: !rprunWillFill, level: "ok", key,
        text: `还没填限价，填了才能判断。${refText}`,
      };
    }
    if (!Number.isFinite(price) || price <= 0) {
      return { block: true, level: "warn", text: `限价「${priceText}」读不懂，无法判断价格。`, key };
    }
    if (!prices.index) {
      return { block: true, level: "warn", text: `${pricesStatus()}。没有参考价，无法判断价格。`, key };
    }
    if (ref === null) {
      return { block: true, level: "warn", text: `${ticker} 在 ${refSourceText(cx)} 没有参考价，无法判断价格。`, key };
    }

    const r = Core.evaluate(price, qty, ref, settings);
    const sign = r.over >= 0 ? "+" : "−";
    let text = `${refText}，限价 ${fmtPrice(price)}：${sign}${fmt(Math.abs(r.over))}（${sign}${fmt(Math.abs(r.relPct))}%）`;
    if (r.over > 0 && Number.isFinite(qty) && qty > 0) text += `，整单多付 ${fmt(r.overTotal)}`;
    if (r.ok) return { block: false, level: "ok", text, key };

    const why = r.reasons.map((x) => {
      if (x.kind === "rel") return `高出 ${fmt(x.actual)}% > 相对值 ${fmt(x.limit)}%`;
      if (x.kind === "unit") return `单价高出 ${fmt(x.actual)} > 单价绝对值 ${fmt(x.limit)}`;
      return `整单多付 ${fmt(x.actual)} > 总价绝对值 ${fmt(x.limit)}`;
    });
    return { block: true, level: "over", text: `${text}。超过阈值：${why.join("；")}`, key, ticker, cx };
  }

  // ---------- CXPO：提示条 ----------

  const forms = new Map(); // form → { frame, box, textEl, passBtn, blockedKey, bypass }

  function attachForm(frame, form) {
    let st = forms.get(form);
    if (!st) {
      const box = el("div", "pg-box");
      const textEl = el("span", "pg-box-text");
      const passBtn = el("button", "pg-pass", "本次放行");
      passBtn.type = "button";
      passBtn.hidden = true;
      passBtn.title = "只放行现在这一笔（材料、限价、数量都不变），15 秒内再点一次 BUY";
      box.append(textEl, passBtn);
      st = { frame, box, textEl, passBtn, blockedKey: "", bypass: null };
      forms.set(form, st);
      passBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const info = inspect(st.frame, form);
        if (!info) return;
        st.bypass = { key: info.key, until: Date.now() + BYPASS_MS };
        updateForm(form);
      });
    }
    st.frame = frame;
    if (!st.box.isConnected) form.appendChild(st.box);
    updateForm(form);
  }

  function updateForm(form) {
    const st = forms.get(form);
    if (!st) return;
    const info = inspect(st.frame, form);
    if (!info) { setHidden(st.box, true); return; }
    setHidden(st.box, false);
    const bypassed = st.bypass && st.bypass.key === info.key && st.bypass.until > Date.now();
    if (st.bypass && !bypassed) st.bypass = null;
    if (st.blockedKey && st.blockedKey !== info.key) st.blockedKey = "";
    const blockedNow = info.block && st.blockedKey === info.key && !bypassed;

    let text = info.text;
    if (bypassed) text = `已放行这一笔，${Math.ceil((st.bypass.until - Date.now()) / 1000)} 秒内再点一次 BUY。${info.text}`;
    else if (blockedNow) text = `已拦截，没有下单。${info.text}`;
    setText(st.textEl, text);
    setClass(st.box, `pg-box pg-${bypassed ? "warn" : info.level}${blockedNow ? " pg-blocked" : ""}`);
    setHidden(st.passBtn, !blockedNow);
  }

  // ---------- CXPO：拦截 BUY ----------

  function onClick(e) {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest("button");
    if (!btn || !/Button__success/.test(btn.className)) return;
    const frame = btn.closest('[class*="TileFrame__frame"]');
    if (!frame || !/^CXPO\s/i.test(cmdOf(frame))) return;
    const form = q(frame, "ComExPlaceOrderForm__form");
    if (!form) return;
    attachForm(frame, form);
    const st = forms.get(form);
    const info = inspect(frame, form);
    if (!info || !info.block) return;
    if (st.bypass && st.bypass.key === info.key && st.bypass.until > Date.now()) {
      st.bypass = null; // 放行只管一次
      st.blockedKey = "";
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    st.blockedKey = info.key;
    updateForm(form);
    toast(`${cmdOf(frame)}：已拦截，没有下单。${info.text}`, () => release(frame, form, btn, info.key));
  }

  /**
   * 弹出提醒上的「取消本次拦截」：把刚才被拦下的那一笔照原样下出去。
   * 只认被拦时的那一笔：材料、限价、数量有一样变了就不下，返回说明文字。
   */
  function release(frame, form, btn, key) {
    const st = forms.get(form);
    if (!st || !btn.isConnected || !form.isConnected) return "下单窗口已经关掉了，没有下单。";
    const info = inspect(frame, form);
    if (!info || info.key !== key) return "限价或数量在拦截之后改过了，没有下单。请回到下单窗口重新点 BUY。";
    st.bypass = { key, until: Date.now() + BYPASS_MS };
    btn.click();
    updateForm(form);
    return "";
  }

  let toastHost = null;
  /** onRelease：点「取消本次拦截」时调用；返回非空文字表示没做成，显示在提醒里 */
  function toast(text, onRelease) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = el("div", "pg-toasts");
      document.body.appendChild(toastHost);
    }
    const t = el("div", "pg-toast");
    const textEl = el("span", "pg-toast-text", text);
    const actions = el("span", "pg-toast-actions");
    const close = el("button", "pg-toast-btn", "知道了");
    close.type = "button";
    close.addEventListener("click", () => t.remove());
    if (onRelease) {
      const go = el("button", "pg-toast-btn pg-toast-go", "取消本次拦截");
      go.type = "button";
      go.title = "照被拦下时的限价和数量，把这一笔下出去";
      go.addEventListener("click", () => {
        const problem = onRelease();
        if (!problem) { t.remove(); return; }
        textEl.textContent = problem;
        go.remove();
      });
      actions.appendChild(go);
    }
    actions.appendChild(close);
    t.append(textEl, actions);
    toastHost.appendChild(t);
    while (toastHost.children.length > 4) toastHost.firstChild.remove();
    setTimeout(() => t.remove(), 20000);
  }

  // ---------- XIT SET-PRICE-GUARD 设置面板 ----------

  const panels = new Map(); // frame → { root, sync, message, error }

  const THRESHOLDS = [
    { key: "rel", label: "相对值", unit: "%", fallback: 20, cmd: "REL", desc: "限价比参考价高出的百分比超过它就拦截" },
    { key: "unit", label: "单价绝对值", unit: "", fallback: 20, cmd: "UNIT", desc: "每件比参考价贵出的金额超过它就拦截" },
    { key: "total", label: "总价绝对值", unit: "", fallback: 10000, cmd: "TOTAL", desc: "整单比按参考价买多付的金额（贵出的单价 × 数量）超过它就拦截" },
  ];

  function buildPanel(state) {
    const root = el("div", "pg-panel");
    const msg = el("div", "pg-msg");
    root.appendChild(msg);

    const master = el("label", "pg-row pg-master");
    const masterBox = el("input");
    masterBox.type = "checkbox";
    master.append(masterBox, el("span", "pg-label", "启用价格提醒"), el("span", "pg-desc", "买单限价超过下面任何一项启用的阈值，就拦截并提醒"));
    masterBox.addEventListener("change", () => saveSettings({ ...settings, enabled: masterBox.checked }));
    root.appendChild(master);

    const rows = THRESHOLDS.map((t) => {
      const row = el("div", "pg-row");
      const box = el("input");
      box.type = "checkbox";
      const input = el("input", "pg-num");
      input.type = "text";
      input.inputMode = "decimal";
      input.spellcheck = false;
      const head = el("label", "pg-head");
      head.append(box, el("span", "pg-label", t.label));
      row.append(head, input, el("span", "pg-unit", t.unit), el("span", "pg-desc", `${t.desc}（XIT SET-PRICE-GUARD ${t.cmd} ${t.fallback}）`));
      box.addEventListener("change", () => {
        const typed = Core.parseAmount(input.value);
        saveSettings({ ...settings, [t.key]: box.checked ? (Number.isFinite(typed) ? typed : t.fallback) : null });
      });
      input.addEventListener("change", () => {
        const typed = Core.parseAmount(input.value);
        input.classList.toggle("pg-bad", !Number.isFinite(typed));
        if (Number.isFinite(typed)) saveSettings({ ...settings, [t.key]: typed });
      });
      root.appendChild(row);
      return { t, box, input };
    });

    const refRow = el("div", "pg-row");
    const exchange = el("select");
    const method = el("select");
    const exchangeNames = { UNIVERSE: "UNIVERSE（全部交易所，rprun 默认）", LOCAL: "LOCAL（下单所在的交易所）" };
    const methodNames = { DEFAULT: "DEFAULT（7 日均价优先，rprun 默认）", ASK: "ASK（卖一）", BID: "BID（买一）", AVG: "AVG（均价）", VWAP7D: "VWAP7D（7 日成交均价）", VWAP30D: "VWAP30D（30 日成交均价）" };
    for (const x of Core.EXCHANGES) { const o = el("option", "", exchangeNames[x] || x); o.value = x; exchange.appendChild(o); }
    for (const x of Core.METHODS) { const o = el("option", "", methodNames[x] || x); o.value = x; method.appendChild(o); }
    exchange.addEventListener("change", () => saveSettings({ ...settings, exchange: exchange.value }));
    method.addEventListener("change", () => saveSettings({ ...settings, method: method.value }));
    refRow.append(el("span", "pg-head pg-label", "参考价"), exchange, method);
    root.appendChild(refRow);
    root.appendChild(el("div", "pg-desc pg-note", "要和 MAT 窗口里的 Refined PrUn Price 一致，这里就选和 rprun 的 XIT SET → pricing 相同的交易所与算法（rprun 默认 UNIVERSE · DEFAULT）。"));

    const status = el("div", "pg-status");
    root.appendChild(status);

    const help = el("div", "pg-help");
    help.appendChild(el("div", "pg-label", "设置指令（只有 XIT SET-PRICE-GUARD 一条，后面可以跟任意多组「项目 值」）"));
    for (const text of Core.USAGE) help.appendChild(el("div", "pg-desc", text));
    root.appendChild(help);

    state.root = root;
    state.sync = () => {
      setText(msg, state.message || "");
      setClass(msg, `pg-msg${state.error ? " pg-err" : state.message ? " pg-okmsg" : ""}`);
      setHidden(msg, !state.message);
      masterBox.checked = settings.enabled;
      for (const { t, box, input } of rows) {
        const value = settings[t.key];
        box.checked = value !== null;
        if (document.activeElement !== input && value !== null) {
          input.value = String(value);
          input.classList.remove("pg-bad");
        }
      }
      exchange.value = settings.exchange;
      method.value = settings.method;
      setText(status, pricesStatus());
    };
  }

  function mountSettings(frame, fullCommand, cmd) {
    let state = panels.get(frame);
    if (!state) {
      state = { root: null, sync: null, message: "", error: false };
      panels.set(frame, state);
      runCommand(frame, fullCommand, cmd, state);
      buildPanel(state);
    }
    if (!state.root.isConnected) {
      // XIT 的内容区是一整块「绿幕」；rprun 不认识这条指令时会往里写一句报错，一并清掉
      const view = q(frame, "ScrollView__view");
      const host = view ? view.firstElementChild || view : q(frame, "TileFrame__anchor");
      if (!host) return;
      if (host !== view) {
        host.textContent = "";
        host.removeAttribute("style");
        host.style.width = "100%";
        host.style.height = "100%";
      }
      host.appendChild(state.root);
    }
    const title = q(frame, "TileFrame__title");
    if (title) setText(title, "PRICE GUARD 价格提醒设置");
    state.sync();
  }

  /** 带参数的指令只在窗口第一次出现时执行一次；刷新页面后同一个窗口不会再执行 */
  function runCommand(frame, fullCommand, cmd, state) {
    const result = Core.applyCommand(settings, cmd);
    if (result.error) { state.message = result.message; state.error = true; return; }
    if (!result.changed) return;
    const tileId = frame.parentElement ? frame.parentElement.getAttribute("data-prun-id") : null;
    if (tileId && applied[tileId] === fullCommand) {
      state.message = "这个窗口的指令之前已经执行过，这次没有重复执行。下面是当前的设置。";
      return;
    }
    state.message = result.message;
    if (tileId) {
      applied[tileId] = fullCommand;
      const ids = Object.keys(applied);
      for (const id of ids.slice(0, Math.max(0, ids.length - 50))) delete applied[id];
      ext.storage.local.set({ applied }).catch(() => {});
    }
    saveSettings(result.settings);
  }

  // ---------- 找窗口 ----------

  function scan() {
    for (const frame of document.querySelectorAll('[class*="TileFrame__frame"]')) {
      const fullCommand = cmdOf(frame);
      const xit = /^XIT\s+(.*)$/i.exec(fullCommand);
      if (xit) {
        const cmd = Core.parseCommand(xit[1]);
        if (cmd) mountSettings(frame, fullCommand, cmd);
      } else if (/^CXPO\s/i.test(fullCommand)) {
        const form = q(frame, "ComExPlaceOrderForm__form");
        if (form) attachForm(frame, form);
      }
    }
  }

  function refreshAll() {
    for (const [form] of forms) {
      if (!form.isConnected) forms.delete(form); else updateForm(form);
    }
    for (const [frame, state] of panels) {
      if (!frame.isConnected) panels.delete(frame); else if (state.sync) state.sync();
    }
  }

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scan(); }, 100);
  }

  async function start() {
    try {
      const stored = await ext.storage.local.get(["settings", "applied", "prices"]);
      settings = Core.normalize(stored.settings);
      if (stored.applied && typeof stored.applied === "object") applied = stored.applied;
      if (stored.prices && stored.prices.index) prices = { at: stored.prices.at, index: stored.prices.index, error: "" };
    } catch (e) {
      // 读不到存储就用默认设置
    }
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.settings) settings = Core.normalize(changes.settings.newValue);
      if (changes.prices && changes.prices.newValue && changes.prices.newValue.index) {
        prices = { at: changes.prices.newValue.at, index: changes.prices.newValue.index, error: "" };
      }
      if (changes.settings || changes.prices) refreshAll();
    });

    // 捕获阶段、挂在 window 上：比游戏和 rprun 的点击处理都早
    window.addEventListener("click", onClick, true);
    new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
    setInterval(refreshAll, 1000);
    loadPrices();
    setInterval(loadPrices, PRICE_POLL_MS);
  }
  start();

  // 给调试与自动化测试用
  window.__prunPriceGuardApi = { inspect, scan, get settings() { return settings; }, get prices() { return prices; } };
})();
