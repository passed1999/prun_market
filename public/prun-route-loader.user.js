// ==UserScript==
// @name         PrUn Route Loader
// @namespace    prun-market
// @version      0.4.0
// @description  把路线编辑器导出的 json 半自动配置到游戏里的 RT（每点一下执行一步）
// @match        https://apex.prosperousuniverse.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 工作方式
 *   1. 读入路线编辑器「导出给游戏」得到的 json（format: prun-route-game）
 *   2. 从游戏页面自己的状态里读出目标路线现在的样子，和 json 逐项比，列出还差哪些操作
 *   3. 你每点一次「执行下一步」，脚本替你在 RT 界面上做一个操作（填表 + 点一次保存 / 添加 / 删除）
 *   4. 做完后重新读状态再比。所以中途停下、刷新页面、手动改过，都可以接着做
 *
 * 一次点击只对应一次发给服务器的操作，脚本不会自己连续执行。
 * 脚本只动你在面板里选中的那一条路线，不会删除路线，不会分配船。
 *
 * 界面结构与字段在 2026-11 的游戏版本上实测；游戏更新后若某一步找不到按钮，脚本会停下并说明卡在哪。
 */
(function () {
  "use strict";
  if (window.__prunRouteLoader) return;
  window.__prunRouteLoader = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  class StepError extends Error {}

  async function waitFor(check, what, timeout = 8000) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > end) throw new StepError(`等了 ${timeout / 1000} 秒也没等到：${what}`);
      await sleep(120);
    }
  }

  // ---------- 读游戏状态 ----------

  let store = null;
  function getStore() {
    if (store) return store;
    const root = document.getElementById("container");
    const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer"));
    const stack = key ? [root[key]] : [];
    let seen = 0;
    while (stack.length && seen++ < 5000) {
      const f = stack.pop();
      if (!f) continue;
      const p = f.memoizedProps;
      if (p && p.store && typeof p.store.getState === "function") { store = p.store; break; }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    if (!store) throw new StepError("读不到游戏状态，可能游戏还没加载完，或者游戏更新后结构变了。");
    return store;
  }

  function rawRoutes() {
    const items = getStore().getState().getIn(["fleet", "routes", "items"]);
    return items ? Object.values(items.toJS()) : [];
  }

  const amt = (a) => ({ type: a && a.type === "CAPACITY" ? "CAPACITY" : "ABSOLUTE", units: (a && a.units) || 0 });
  const pct = (f) => Math.round(f * 100);

  function normStep(s) {
    switch (s.type) {
      case "LOAD":
        return { type: "LOAD", material: s.material.ticker, minimum: amt(s.minimum), maximum: amt(s.maximum), retain: s.retain || 0 };
      case "UNLOAD":
        return { type: "UNLOAD", material: s.material.ticker, minimum: amt(s.minimum), maximum: amt(s.maximum) };
      case "REFUEL":
        return { type: "REFUEL", fuel: s.fuel, source: s.source, minimum: amt(s.minimum), maximum: amt(s.maximum) };
      case "WAIT":
        return { type: "WAIT", amount: s.amount, unit: s.unit };
      default:
        return { type: s.type };
    }
  }

  /** 游戏里的路线 → 和 json 同样的形状 */
  function currentRoute(naturalId) {
    const r = rawRoutes().find((x) => x.naturalId === naturalId);
    if (!r) return null;
    return {
      naturalId: r.naturalId,
      name: r.name || "",
      repeats: !!r.repeats,
      waypoints: (r.waypoints || []).map((w) => {
        const last = w.destination.lines[w.destination.lines.length - 1];
        return {
          destination: { naturalId: last.entity ? last.entity.naturalId : "", name: last.entity ? last.entity.name : "" },
          fuel: pct(w.fuelUsageFactor),
          reactor: pct(w.reactorUsageFactor),
          ftlPreference: w.preferences.ftlPreference,
          useGateways: !!w.preferences.useGateways,
          steps: (w.steps || []).map(normStep),
        };
      }),
    };
  }

  function normTarget(json) {
    if (!json || json.format !== "prun-route-game" || !Array.isArray(json.waypoints)) {
      throw new StepError("这不是路线编辑器「导出给游戏」的文件。");
    }
    return {
      name: String(json.name || ""),
      repeats: !!json.repeats,
      waypoints: json.waypoints.map((w) => ({
        destination: { naturalId: String(w.destination.naturalId || ""), name: String(w.destination.name || "") },
        fuel: pct(w.fuelUsageFactor == null ? 0.25 : w.fuelUsageFactor),
        reactor: pct(w.reactorUsageFactor == null ? 0.5 : w.reactorUsageFactor),
        ftlPreference: (w.preferences && w.preferences.ftlPreference) || "LEAST_JUMPS",
        useGateways: !w.preferences || w.preferences.useGateways !== false,
        steps: (w.steps || []).map((s) => {
          if (s.type === "LOAD" || s.type === "UNLOAD") {
            return normStep({ ...s, material: { ticker: String(s.material).toUpperCase() } });
          }
          return normStep(s);
        }),
      })),
    };
  }

  // ---------- 比较，列出还差的操作 ----------

  const amtEq = (a, b) => a.type === b.type && (a.type === "CAPACITY" || a.units === b.units);
  function stepEq(a, b) {
    if (a.type !== b.type) return false;
    switch (a.type) {
      case "LOAD": return a.material === b.material && amtEq(a.minimum, b.minimum) && amtEq(a.maximum, b.maximum) && a.retain === b.retain;
      case "UNLOAD": return a.material === b.material && amtEq(a.minimum, b.minimum) && amtEq(a.maximum, b.maximum);
      case "REFUEL": return a.fuel === b.fuel && a.source === b.source && amtEq(a.minimum, b.minimum) && amtEq(a.maximum, b.maximum);
      case "WAIT": return a.amount === b.amount && a.unit === b.unit;
      default: return true;
    }
  }
  /** 游戏里点「添加」后得到的默认步骤 */
  const FRESH = {
    LOAD: { type: "LOAD", material: "DW", minimum: { type: "ABSOLUTE", units: 1 }, maximum: { type: "ABSOLUTE", units: 100 }, retain: 0 },
    UNLOAD: { type: "UNLOAD", material: "DW", minimum: { type: "ABSOLUTE", units: 1 }, maximum: { type: "ABSOLUTE", units: 100 } },
    REFUEL: { type: "REFUEL", fuel: "STL", source: "LOCAL_STORE", minimum: { type: "ABSOLUTE", units: 100 }, maximum: { type: "CAPACITY", units: 0 } },
    WAIT: { type: "WAIT", amount: 1, unit: "MINUTES" },
    LOAD_SHIPMENT: { type: "LOAD_SHIPMENT" },
    UNLOAD_SHIPMENT: { type: "UNLOAD_SHIPMENT" },
  };
  const sameDest = (a, b) => a.naturalId.toUpperCase() === b.naturalId.toUpperCase();
  const wpSettingsEq = (a, b) => a.fuel === b.fuel && a.reactor === b.reactor
    && a.ftlPreference === b.ftlPreference && a.useGateways === b.useGateways;

  const STEP_NAME = { LOAD: "装货", UNLOAD: "卸货", REFUEL: "加油", WAIT: "等待", LOAD_SHIPMENT: "装运单", UNLOAD_SHIPMENT: "卸运单" };
  const showAmt = (a, capWord) => (a.type === "CAPACITY" ? capWord : String(a.units));
  function describe(s) {
    switch (s.type) {
      case "LOAD": return `装 ${s.material} ${showAmt(s.minimum, "装满")}–${showAmt(s.maximum, "装满")}${s.retain ? `，留 ${s.retain}` : ""}`;
      case "UNLOAD": return `卸 ${s.material} ${showAmt(s.minimum, "全部")}–${showAmt(s.maximum, "全部")}`;
      case "REFUEL": return `加油 ${s.fuel}（${s.source === "LOCAL_STORE" ? "当地仓库" : "船上货舱"}）${showAmt(s.minimum, "加满")}–${showAmt(s.maximum, "加满")}`;
      case "WAIT": return `等待 ${s.amount} ${{ SECONDS: "秒", MINUTES: "分钟", HOURS: "小时", DAYS: "天" }[s.unit]}`;
      default: return STEP_NAME[s.type];
    }
  }
  const destText = (d) => (d.name && d.name !== d.naturalId ? `${d.name} (${d.naturalId})` : d.naturalId);

  /** 还差哪些操作，按执行顺序。cur 为 null 表示路线还没建 */
  function plan(target, cur) {
    const acts = [];
    const c = cur ? JSON.parse(JSON.stringify(cur)) : { name: "", repeats: false, waypoints: [] };
    if (!cur) acts.push({ kind: "create", label: "新建一条路线" });
    if (target.name && c.name !== target.name) acts.push({ kind: "rename", label: `改名为「${target.name}」` });

    target.waypoints.forEach((tw, i) => {
      const n = i + 1;
      let cw = c.waypoints[i];
      if (!cw) {
        acts.push({ kind: "addWaypoint", i, label: `添加第 ${n} 站：${destText(tw.destination)}` });
        cw = { destination: tw.destination, fuel: 25, reactor: 50, ftlPreference: "LEAST_JUMPS", useGateways: true, steps: [] };
      }
      if (!sameDest(cw.destination, tw.destination) || !wpSettingsEq(cw, tw)) {
        const what = [];
        if (!sameDest(cw.destination, tw.destination)) what.push(`目的地改为 ${destText(tw.destination)}`);
        if (cw.fuel !== tw.fuel) what.push(`燃料 ${tw.fuel}%`);
        if (cw.reactor !== tw.reactor) what.push(`反应堆 ${tw.reactor}%`);
        if (cw.ftlPreference !== tw.ftlPreference) what.push(tw.ftlPreference === "LEAST_JUMPS" ? "最少跳数" : "最短 FTL");
        if (cw.useGateways !== tw.useGateways) what.push(tw.useGateways ? "走星门" : "不走星门");
        acts.push({ kind: "editWaypoint", i, label: `第 ${n} 站：${what.join("，")}` });
      }
      let common = 0;
      while (common < cw.steps.length && common < tw.steps.length && cw.steps[common].type === tw.steps[common].type) common++;
      for (let j = cw.steps.length - 1; j >= common; j--) {
        acts.push({ kind: "deleteStep", i, j, label: `第 ${n} 站：删掉第 ${j + 1} 步（${describe(cw.steps[j])}）` });
      }
      for (let j = 0; j < common; j++) {
        if (!stepEq(cw.steps[j], tw.steps[j])) {
          acts.push({ kind: "editStep", i, j, label: `第 ${n} 站第 ${j + 1} 步：改成 ${describe(tw.steps[j])}` });
        }
      }
      for (let j = common; j < tw.steps.length; j++) {
        const ts = tw.steps[j];
        acts.push({ kind: "addStep", i, j, label: `第 ${n} 站：添加第 ${j + 1} 步（${STEP_NAME[ts.type]}）` });
        if (!stepEq(FRESH[ts.type], ts)) {
          acts.push({ kind: "editStep", i, j, label: `第 ${n} 站第 ${j + 1} 步：改成 ${describe(ts)}` });
        }
      }
    });
    for (let i = c.waypoints.length - 1; i >= target.waypoints.length; i--) {
      acts.push({ kind: "deleteWaypoint", i, label: `删掉多出来的第 ${i + 1} 站（${destText(c.waypoints[i].destination)}）` });
    }
    if (c.repeats !== target.repeats) acts.push({ kind: "toggleLoop", label: target.repeats ? "打开循环" : "关闭循环" });
    return acts;
  }

  // ---------- 操作游戏界面 ----------

  function setValue(el, value) {
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype
      : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const windows = () => Array.from(document.querySelectorAll('[class*="Window__window"]'));
  const cmdOf = (w) => { const c = w.querySelector('[class*="TileFrame__cmd"]'); return c ? c.textContent.trim() : ""; };
  const findWindow = (cmd) => windows().find((w) => cmdOf(w).toUpperCase() === cmd.toUpperCase());

  async function openBuffer(cmd) {
    const existing = findWindow(cmd);
    if (existing) return existing;
    const newBtn = Array.from(document.querySelectorAll("div, span, button"))
      .find((e) => e.children.length === 0 && e.textContent.trim() === "NEW BFR");
    if (!newBtn) throw new StepError("找不到「NEW BFR」按钮，没法打开窗口。");
    newBtn.click();
    const input = await waitFor(() => document.querySelector('[class*="PanelSelector__input"]'), "新窗口的命令输入框");
    setValue(input, cmd);
    await sleep(150);
    input.closest("form").requestSubmit();
    return waitFor(() => findWindow(cmd), `窗口 ${cmd}`);
  }

  async function routeWindow(naturalId) {
    const w = await openBuffer(`RT ${naturalId}`);
    // 编辑表单开着的时候路线内容不在页面里：先把上次没关的表单取消掉
    await waitFor(() => w.querySelector('[class*="Route__header"]') || overlayForm(w), "路线内容");
    const stale = overlayForm(w);
    if (stale) {
      const cancel = buttonByText(stale, "cancel");
      if (cancel) cancel.click();
      await waitFor(() => w.querySelector('[class*="Route__header"]'), "路线内容");
    }
    return w;
  }

  const overlayForm = (w) => w.querySelector('[class*="Overlay__children"] form');
  const buttonByText = (root, text) => Array.from(root.querySelectorAll("button"))
    .find((b) => b.textContent.trim().toLowerCase() === text.toLowerCase());

  function waypointEl(w, i) {
    const el = w.querySelectorAll('[class*="Waypoint__container"]')[i];
    if (!el) throw new StepError(`界面上找不到第 ${i + 1} 站。`);
    return el;
  }
  function stepEl(w, i, j) {
    const el = waypointEl(w, i).querySelectorAll('[class*="Step__container"]')[j];
    if (!el) throw new StepError(`界面上找不到第 ${i + 1} 站的第 ${j + 1} 步。`);
    return el;
  }

  /** 表单里标题是 label 的那一行 */
  function field(form, label) {
    const rows = Array.from(form.querySelectorAll('[class*="forms__form-component"]'));
    const row = rows.find((r) => { const l = r.querySelector("label"); return l && l.textContent.trim() === label; });
    if (!row) throw new StepError(`表单里找不到「${label}」这一项。`);
    return row;
  }
  /** 单选：让第 index 个选项处于选中 */
  async function chooseRadio(form, label, index) {
    const items = field(form, label).querySelectorAll('[class*="RadioItem__container"]');
    const item = items[index];
    if (!item) throw new StepError(`「${label}」没有第 ${index + 1} 个选项。`);
    const active = () => !!item.querySelector('[class*="RadioItem__active"]');
    if (!active()) { item.click(); await sleep(150); }
  }
  /** 开关：只有一个选项的单选，点一下翻转 */
  async function setToggle(item, on) {
    const active = () => !!item.querySelector('[class*="RadioItem__active"]');
    if (active() !== on) { item.click(); await sleep(150); }
  }
  async function setAmount(form, label, name, amount) {
    await chooseRadio(form, label, amount.type === "CAPACITY" ? 1 : 0);
    if (amount.type === "ABSOLUTE") {
      const input = await waitFor(() => form.querySelector(`input[name="${name}"]`), `「${label}」的数量框`);
      setValue(input, String(amount.units));
    }
  }

  /** 带下拉建议的搜索框：填字、等建议、点中符合条件的那条 */
  async function pickSuggestion(input, text, match, what) {
    setValue(input, "");
    await sleep(150);
    input.focus();
    // 页面不在前台时 focus() 不触发事件，建议列表就不出来；补发一次
    input.dispatchEvent(new FocusEvent("focus"));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    setValue(input, text);
    const li = await waitFor(() => {
      const box = document.getElementById(input.getAttribute("aria-controls"));
      return box && Array.from(box.querySelectorAll("li")).find(match);
    }, `${what} 的搜索结果`, 6000);
    li.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    li.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    li.click();
    await sleep(400);
  }

  const PLANET_ID = /^[A-Z]{2}-\d{3}[a-z]$/;
  async function pickDestination(input, dest) {
    const isPlanet = PLANET_ID.test(dest.naturalId);
    const text = isPlanet || !dest.name ? dest.naturalId : dest.name;
    await pickSuggestion(input, text, (li) => {
      const t = li.textContent.trim();
      if (t.includes("->")) return false; // 星门
      return isPlanet ? t.endsWith(`(${dest.naturalId})`) : t.toLowerCase().startsWith(text.toLowerCase());
    }, destText(dest));
  }
  async function pickMaterial(input, ticker) {
    await pickSuggestion(input, ticker, (li) => {
      const leaf = Array.from(li.querySelectorAll("*")).find((e) => e.children.length === 0 && e.textContent.trim());
      return leaf && leaf.textContent.trim() === ticker;
    }, `材料 ${ticker}`);
  }

  /** 滑块是 rc-slider，没有输入框：直接调它外层表单项的 onChange */
  function setSlider(slider, value) {
    const key = Object.keys(slider).find((k) => k.startsWith("__reactFiber"));
    let f = key && slider[key];
    for (let n = 0; n < 12 && f; n++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p.onChange === "function" && "onBlur" in p && "value" in p) { p.onChange(value); return; }
    }
    throw new StepError("滑块的结构和预期不一样，没法设置燃料 / 反应堆用量。");
  }

  async function saveForm(w, form, done, what) {
    const save = buttonByText(form, "save");
    if (!save) throw new StepError("表单里找不到 save 按钮。");
    save.click();
    try {
      await waitFor(done, what);
    } catch (e) {
      if (overlayForm(w)) throw new StepError(`${e.message}。表单还开着，请看一下游戏里表单上的提示。`);
      throw e;
    }
  }

  const ADD_BUTTON = { LOAD: "Load", UNLOAD: "Unload", REFUEL: "Refuel", WAIT: "Wait", LOAD_SHIPMENT: "Load shipment", UNLOAD_SHIPMENT: "Unload shipment" };

  async function fillStep(form, ts) {
    if (ts.type === "LOAD" || ts.type === "UNLOAD") {
      await pickMaterial(form.querySelector('input[class*="MaterialSelector__input"]'), ts.material);
      await setAmount(form, "Minimum", "minimum.units", ts.minimum);
      await setAmount(form, "Maximum", "maximum.units", ts.maximum);
      if (ts.type === "LOAD") setValue(form.querySelector('input[name="retain"]'), String(ts.retain));
    } else if (ts.type === "REFUEL") {
      await chooseRadio(form, "Tank", ts.fuel === "FTL" ? 1 : 0);
      await chooseRadio(form, "Fuel source", ts.source === "LOCAL_STORE" ? 1 : 0);
      await setAmount(form, "Minimum", "minimum.units", ts.minimum);
      await setAmount(form, "Maximum", "maximum.units", ts.maximum);
    } else if (ts.type === "WAIT") {
      setValue(form.querySelector('select[name="unit"]'), ts.unit);
      await sleep(100);
      setValue(form.querySelector('input[name="amount"]'), String(ts.amount));
    }
    await sleep(200);
  }

  /** 执行一个操作：做完界面动作后，等游戏状态里出现对应的变化才算成 */
  async function execute(act, target, state) {
    if (act.kind === "create") {
      const list = await openBuffer("RT");
      const before = new Set(rawRoutes().map((r) => r.naturalId));
      const btn = await waitFor(() => buttonByText(list, "create route"), "CREATE ROUTE 按钮");
      btn.click();
      const made = await waitFor(() => rawRoutes().find((r) => !before.has(r.naturalId)), "新路线出现");
      state.routeId = made.naturalId;
      return;
    }
    const id = state.routeId;
    const w = await routeWindow(id);
    const cur = () => currentRoute(id);
    const tw = act.i != null ? target.waypoints[act.i] : null;

    switch (act.kind) {
      case "rename": {
        let input = w.querySelector('input[class*="Route__input"]');
        if (!input) {
          const name = w.querySelector('[class*="Route__name"] span') || w.querySelector('[class*="Route__name"]');
          name.click();
          input = await waitFor(() => w.querySelector('input[class*="Route__input"]'), "路线名字的输入框");
        }
        input.focus();
        setValue(input, target.name);
        await sleep(150);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        await waitFor(() => cur().name === target.name, "名字改好");
        return;
      }
      case "addWaypoint": {
        const count = cur().waypoints.length;
        const input = field(w, "Waypoint").querySelector('input[class*="AddressSelector__input"]');
        await pickDestination(input, tw.destination);
        const btn = buttonByText(w, "add waypoint");
        if (!btn || /disabled/i.test(btn.className)) throw new StepError(`目的地 ${destText(tw.destination)} 没选上。`);
        btn.click();
        await waitFor(() => cur().waypoints.length === count + 1, "新的一站出现");
        if (!sameDest(cur().waypoints[count].destination, tw.destination)) {
          throw new StepError(`加上去的目的地不是 ${destText(tw.destination)}，请手动改一下再继续。`);
        }
        return;
      }
      case "editWaypoint": {
        waypointEl(w, act.i).querySelector('button[title="Edit waypoint"]').click();
        const form = await waitFor(() => overlayForm(w), "waypoint 的编辑表单");
        const now = cur().waypoints[act.i];
        if (!sameDest(now.destination, tw.destination)) {
          await pickDestination(form.querySelector('input[class*="AddressSelector__input"]'), tw.destination);
        }
        const sliders = form.querySelectorAll(".rc-slider");
        if (now.fuel !== tw.fuel) setSlider(sliders[0], tw.fuel);
        if (now.reactor !== tw.reactor) setSlider(sliders[1], tw.reactor);
        const pref = form.querySelector('[class*="RoutePreferencesSelect__container"]');
        setValue(pref.querySelector("select"), tw.ftlPreference);
        await setToggle(pref.querySelector('[class*="RadioItem__container"]'), tw.useGateways);
        await sleep(200);
        await saveForm(w, form, () => {
          const x = cur().waypoints[act.i];
          return sameDest(x.destination, tw.destination) && wpSettingsEq(x, tw);
        }, "waypoint 的设置保存");
        return;
      }
      case "deleteWaypoint": {
        const count = cur().waypoints.length;
        waypointEl(w, act.i).querySelector('button[title="Delete waypoint"]').click();
        await waitFor(() => cur().waypoints.length === count - 1, "这一站被删掉");
        return;
      }
      case "addStep": {
        const count = cur().waypoints[act.i].steps.length;
        const type = tw.steps[act.j].type;
        const btn = Array.from(waypointEl(w, act.i).querySelectorAll('[class*="Waypoint__commandsSteps"] button'))
          .find((b) => b.textContent.trim() === ADD_BUTTON[type]);
        if (!btn) throw new StepError(`找不到添加「${STEP_NAME[type]}」的按钮。`);
        btn.click();
        await waitFor(() => cur().waypoints[act.i].steps.length === count + 1, "新步骤出现");
        return;
      }
      case "deleteStep": {
        const count = cur().waypoints[act.i].steps.length;
        stepEl(w, act.i, act.j).querySelector('button[title="Delete step"]').click();
        await waitFor(() => cur().waypoints[act.i].steps.length === count - 1, "这一步被删掉");
        return;
      }
      case "editStep": {
        const ts = tw.steps[act.j];
        stepEl(w, act.i, act.j).querySelector('button[title="Edit step"]').click();
        const form = await waitFor(() => overlayForm(w), "步骤的编辑表单");
        await fillStep(form, ts);
        await saveForm(w, form, () => {
          const s = cur().waypoints[act.i].steps[act.j];
          return s && stepEq(s, ts);
        }, "步骤保存");
        return;
      }
      case "toggleLoop": {
        const item = field(w, "Loop").querySelector('[class*="RadioItem__container"]');
        item.click();
        await waitFor(() => cur().repeats === target.repeats, "循环开关生效");
        return;
      }
      default:
        throw new StepError("不认识的操作。");
    }
  }

  // ---------- 面板 ----------

  const state = { target: null, routeId: "", busy: false, lastKey: "", repeats: 0 };
  const NEW = "__new__";

  const css = `
  #prl-toggle{position:fixed;right:8px;bottom:34px;z-index:99998;background:#f7a600;color:#222;border:0;border-radius:3px;
    padding:3px 8px;font:bold 11px sans-serif;cursor:pointer;opacity:.85}
  #prl{position:fixed;right:8px;bottom:60px;z-index:99999;width:340px;max-height:70vh;display:flex;flex-direction:column;gap:6px;
    background:#1c2026;color:#ddd;border:1px solid #f7a600;border-radius:4px;padding:8px;font:12px/1.5 sans-serif;box-shadow:0 6px 20px #000a}
  #prl h4{margin:0;font-size:13px;color:#f7a600;display:flex;gap:8px;align-items:center}
  #prl h4 .dim{flex:1;text-align:right;font-weight:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #prl h4 .min{padding:0 8px;line-height:16px;font-weight:bold}
  #prl textarea{width:100%;box-sizing:border-box;background:#14171c;color:#ddd;border:1px solid #555;font:11px monospace;resize:vertical}
  #prl [hidden]{display:none!important}
  #prl button,#prl select{background:#2b3038;color:#eee;border:1px solid #555;padding:3px 8px;font-size:12px;cursor:pointer}
  #prl select{width:100%}
  #prl button.go{background:#f7a600;color:#222;border-color:#f7a600;font-weight:bold;padding:6px 8px}
  #prl button:disabled{opacity:.4;cursor:default}
  #prl .row{display:flex;gap:6px;align-items:center}
  #prl .next{background:#262b33;padding:4px 6px;border-left:3px solid #f7a600}
  #prl .dim{color:#8a8f99}
  #prl .err{color:#f08a8a}
  #prl .ok{color:#8fcf9f}
  #prl ol{margin:0;padding-left:22px;overflow-y:auto;flex:1;min-height:0;color:#9aa3b0}
  #prl ol li:first-child{color:#fff}`;

  let panel, els, toggleBtn;

  function build() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const toggle = document.createElement("button");
    toggle.id = "prl-toggle";
    toggle.textContent = "路线导入";
    toggle.onclick = () => { if (panel.hidden) restore(); else minimize(); };
    document.body.appendChild(toggle);
    toggleBtn = toggle;

    panel = document.createElement("div");
    panel.id = "prl";
    panel.hidden = true;
    panel.innerHTML = `
      <h4><span>路线导入</span><span class="dim" data-el="file-name"></span>
        <button data-el="min" class="min" title="最小化（Esc）。进度不会丢，再点右下角的按钮就回来">—</button></h4>
      <div class="row"><button data-el="open">选择 json 文件…</button><button data-el="paste">粘贴 json…</button>
        <button data-el="reload" title="重新读游戏里的状态">刷新</button>
        <button data-el="ships" title="复制你所有船的参数（质量、推力、油箱、货舱、FTL），到路线编辑器里粘贴导入，用来估航行时间">复制船只参数</button>
        <input data-el="file" type="file" accept=".json,application/json" hidden></div>
      <div data-el="paste-box" hidden>
        <textarea data-el="paste-text" rows="5" spellcheck="false" placeholder="把路线编辑器里复制的 json 粘贴到这里"></textarea>
        <button data-el="paste-go">读入</button></div>
      <label data-el="target-row" hidden>写到哪条路线
        <select data-el="route"></select></label>
      <div data-el="msg" class="dim">先选择路线编辑器「导出给游戏」得到的文件。</div>
      <div data-el="next" class="next" hidden></div>
      <button data-el="go" class="go" hidden>执行下一步</button>
      <ol data-el="list"></ol>`;
    document.body.appendChild(panel);
    els = {};
    panel.querySelectorAll("[data-el]").forEach((e) => { els[e.dataset.el] = e; });

    const load = (text, label) => {
      let ok = true;
      try {
        state.target = normTarget(JSON.parse(text));
        state.routeId = "";
        state.lastKey = "";
        els["file-name"].textContent = label;
        say("");
      } catch (e) {
        ok = false;
        state.target = null;
        say(e instanceof StepError ? e.message : "这不是合法的 JSON。", "err");
      }
      refresh();
      return ok;
    };
    els.open.onclick = () => els.file.click();
    els.reload.onclick = () => refresh();
    els.min.onclick = minimize;
    els.ships.onclick = copyShips;
    els.paste.onclick = () => {
      els["paste-box"].hidden = !els["paste-box"].hidden;
      if (!els["paste-box"].hidden) els["paste-text"].focus();
    };
    els["paste-go"].onclick = () => {
      const text = els["paste-text"].value.trim();
      if (!text) return;
      if (load(text, "粘贴的内容")) { els["paste-text"].value = ""; els["paste-box"].hidden = true; }
    };
    els.file.onchange = async () => {
      const file = els.file.files[0];
      els.file.value = "";
      if (file) load(await file.text(), file.name);
    };
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); minimize(); } });
    els.route.onchange = () => { state.routeId = els.route.value === NEW ? "" : els.route.value; state.lastKey = ""; say(""); refresh(); };
    els.go.onclick = step;
  }

  /** 最小化只是藏起来：读入的路线和进度都还在；按钮上显示还剩几步 */
  function minimize() {
    panel.hidden = true;
    updateToggle();
  }
  function restore() {
    panel.hidden = false;
    refresh();
    updateToggle();
  }
  function updateToggle() {
    const left = state.target && state.plan ? state.plan.length : 0;
    toggleBtn.textContent = panel.hidden && left ? `路线导入 · 剩 ${left} 步` : "路线导入";
  }

  function say(text, cls) {
    els.msg.textContent = text;
    els.msg.className = cls || "dim";
  }

  /** 路线编辑器估航行时间要用的船只参数，全部来自游戏自己的数据 */
  function collectShips() {
    const st = getStore().getState();
    const ships = Object.values(st.getIn(["fleet", "ships"]).toJS().data || {});
    const stores = st.getIn(["storage", "stores"]).toJS();
    const blueprints = Object.values(st.getIn(["blueprints", "blueprints", "items"]).toJS() || {});
    let missingFtl = 0;
    const list = ships.map((s) => {
      const cargo = stores[s.idShipStore] || {};
      const stl = stores[s.idStlFuelStore] || {};
      const ftl = stores[s.idFtlFuelStore] || {};
      const bp = blueprints.find((b) => b.naturalId === s.blueprintNaturalId);
      const perf = (bp && bp.performance) || null;
      if (!perf && s.reactorPower) missingFtl++;
      return {
        name: s.name || s.registration,
        registration: s.registration,
        emptyMass: s.operatingEmptyMass,
        thrust: Math.round(s.acceleration * s.mass),
        flowRate: s.stlFuelFlowRate,
        stlCapacity: Math.round((stl.weightCapacity || 0) / 0.06),
        ftlCapacity: Math.round((ftl.weightCapacity || 0) / 0.05),
        cargoWeight: cargo.weightCapacity || 0,
        cargoVolume: cargo.volumeCapacity || 0,
        volume: s.volume || 0,
        ftlMaxSpeed: perf ? perf.ftlMaxSpeed : 0,
        chargeTime: perf ? perf.emitterChargeTime : 0,
        overchargeTime: perf ? perf.maxOverchargeTime : 0,
        minReactor: perf ? perf.minReactorUsage : 1,
      };
    });
    // 星门清单：只有在游戏里打开过 GTW 才有。已连通的单向连接，带能过的最大船体积
    const gws = st.getIn(["data", "items", "gateways"]);
    const all = gws ? gws.toJS() : {};
    const planetOf = (g) => {
      const line = g && g.address && g.address.lines.find((l) => l.type === "PLANET");
      return line && line.entity ? line.entity.naturalId : "";
    };
    const gateways = Object.values(all)
      .filter((g) => g.linkStatus === "ESTABLISHED" && g.outgoingLink && all[g.outgoingLink])
      .map((g) => ({ from: planetOf(g), to: planetOf(all[g.outgoingLink]), maxVolume: g.maxShipVolume || 0 }))
      .filter((g) => g.from && g.to);
    return { json: { format: "prun-ships", version: 1, ships: list, gateways }, missingFtl, gateways: gateways.length };
  }
  async function copyShips() {
    try {
      const { json, missingFtl, gateways } = collectShips();
      if (!json.ships.length) { say("游戏里还没读到你的船，先打开一次 FLT。", "err"); return; }
      const text = JSON.stringify(json, null, 2);
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        els["paste-box"].hidden = false;
        els["paste-text"].value = text;
        els["paste-text"].select();
        say("浏览器不让写剪贴板：参数已放进下面的文本框，请手动复制。", "err");
        return;
      }
      say(`已复制 ${json.ships.length} 艘船的参数${gateways ? `和 ${gateways} 条星门连接` : "（没带星门清单：想更新星门就先打开一次 GTW）"}，到路线编辑器里「粘贴导入」。`
        + (missingFtl ? `其中 ${missingFtl} 艘没带上 FTL 参数：先在游戏里打开一次 BLU 再复制。` : ""), missingFtl ? "err" : "ok");
    } catch (e) {
      say(e instanceof StepError ? e.message : "读船只参数时出错了。", "err");
    }
  }

  function assignedShips(naturalId) {
    try {
      const items = getStore().getState().getIn(["fleet", "routeExecutions", "items"]);
      return items ? Object.values(items.toJS()).filter((x) => x.route && x.route.naturalId === naturalId).length : 0;
    } catch { return 0; }
  }

  function refresh() {
    const t = state.target;
    els["target-row"].hidden = !t;
    els.next.hidden = els.go.hidden = !t;
    els.list.innerHTML = "";
    if (!t) return;
    let routes;
    try {
      routes = rawRoutes();
    } catch (e) {
      say(e.message, "err");
      return;
    }
    els.route.innerHTML = "";
    const opt = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; els.route.appendChild(o); };
    opt(NEW, "新建一条路线");
    for (const r of routes) opt(r.naturalId, `覆盖 ${r.naturalId}${r.name ? `「${r.name}」` : ""}（${(r.waypoints || []).length} 站）`);
    els.route.value = state.routeId && routes.some((r) => r.naturalId === state.routeId) ? state.routeId : NEW;

    const acts = plan(t, state.routeId ? currentRoute(state.routeId) : null);
    state.plan = acts;
    if (!acts.length) {
      els.next.hidden = els.go.hidden = true;
      say(`${state.routeId} 已经和文件完全一致。`, "ok");
      return;
    }
    els.next.textContent = `下一步：${acts[0].label}`;
    els.go.textContent = `执行下一步（还剩 ${acts.length} 步）`;
    els.go.disabled = state.busy;
    for (const a of acts.slice(0, 200)) {
      const li = document.createElement("li");
      li.textContent = a.label;
      els.list.appendChild(li);
    }
    if (!els.msg.textContent || els.msg.className === "dim") {
      const ships = state.routeId ? assignedShips(state.routeId) : 0;
      say(ships
        ? `有 ${ships} 艘船正在跑这条路线，改动要等它跑完当前这一圈才生效。`
        : state.routeId ? "会把这条路线改成和文件一致，多出来的站和步骤会被删掉。" : "");
    }
  }

  async function step() {
    if (state.busy || !state.plan || !state.plan.length) return;
    const act = state.plan[0];
    const key = `${state.routeId}|${act.kind}|${act.i}|${act.j}`;
    state.repeats = key === state.lastKey ? state.repeats + 1 : 0;
    state.lastKey = key;
    if (state.repeats >= 2) {
      say(`「${act.label}」做了两次，游戏里还是没变成想要的样子。请手动处理这一步，再点「刷新」。`, "err");
      return;
    }
    state.busy = true;
    els.go.disabled = true;
    say(`正在执行：${act.label}`);
    try {
      await execute(act, state.target, state);
      say(`完成：${act.label}`, "ok");
    } catch (e) {
      say(e instanceof StepError ? `没做成：${e.message}` : `没做成：出了意料之外的错误（${e && e.message}）。`, "err");
    } finally {
      state.busy = false;
      refresh();
      els.go.focus();
    }
  }

  function start() {
    if (!document.getElementById("container")) { setTimeout(start, 1000); return; }
    build();
  }
  start();

  // 给调试与自动化测试用
  window.__prunRouteLoaderApi = { plan, normTarget, currentRoute, state, refresh, step, rawRoutes };
})();
