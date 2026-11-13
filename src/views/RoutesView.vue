<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import WaypointNode from "../components/routes/WaypointNode.vue";
import { useCatalog } from "../routes/catalog";
import { compile } from "../routes/compile";
import { clearDrag, drag } from "../routes/drag";
import type { RouteEstimate, RouteLeg } from "../routes/estimate";
import { estimateRoute } from "../routes/estimate";
import { formatDuration } from "../routes/flight";
import type { Base } from "../routes/fio";
import { account, baseProducts, FioError, listBases, resupply } from "../routes/fio";
import { copyText, download, ImportError, parseFile, safeName, toText } from "../routes/io";
import type { MaterialGroup, RouteDoc, Step, Waypoint } from "../routes/model";
import { abs, cap, destinationLabel, newGroup, newId, newRoute, newWaypoint } from "../routes/model";
import { relinkGroups, upsertGroup, upsertRoute, workspace } from "../routes/store";

const { materials } = useCatalog();
const tickers = computed(() => Object.keys(materials.value).sort());

const route = computed<RouteDoc>(() =>
  workspace.routes.find((r) => r.id === workspace.activeRouteId) ?? workspace.routes[0]);

const result = computed(() => compile(route.value, workspace.groups, {
  mergeAdjacent: workspace.mergeAdjacent,
  shipWeight: workspace.shipWeight,
  shipVolume: workspace.shipVolume,
  materials: materials.value,
}));
const errors = computed(() => result.value.issues.filter((i) => i.level === "error"));
const stepCount = computed(() => result.value.game.waypoints.reduce((n, w) => n + w.steps.length, 0));
const issuesFor = (wp: Waypoint) => result.value.issues.filter((i) => i.waypointId === wp.id);
const legFor = (wp: Waypoint) => result.value.legs.find((l) => l.waypointId === wp.id);
const looseIssues = computed(() => result.value.issues.filter((i) => !i.waypointId));

const notice = ref("");
const noticeBad = ref(false);
function say(text: string, bad = false) {
  notice.value = text;
  noticeBad.value = bad;
}

// ---- 航行时间估算：选了船才算 ----
const ship = computed(() => workspace.ships.find((x) => x.name === workspace.shipName) ?? null);
const estimate = ref<RouteEstimate | null>(null);
let estimateRun = 0;
let estimateTimer: ReturnType<typeof setTimeout> | undefined;

function pickShip(name: string) {
  workspace.shipName = name;
  const chosen = workspace.ships.find((x) => x.name === name);
  if (chosen) { workspace.shipWeight = chosen.cargoWeight; workspace.shipVolume = chosen.cargoVolume; }
}
watch([ship, result], () => {
  clearTimeout(estimateTimer);
  const run = ++estimateRun;
  if (!ship.value) { estimate.value = null; return; }
  const chosen = ship.value;
  const game = result.value.game;
  const cargo = result.value.legs.map((l) => l.weight);
  estimateTimer = setTimeout(async () => {
    try {
      const got = await estimateRoute(game, cargo, chosen, Date.now() / 1000);
      if (run === estimateRun) estimate.value = got;
    } catch {
      if (run === estimateRun) estimate.value = null;
    }
  }, 250);
}, { immediate: true, deep: true });

function legText(leg: RouteLeg): string {
  return leg.unknown ? "估不了" : `约 ${formatDuration(leg.seconds)} · ${leg.stlFuel} SF`;
}
function legTitle(leg: RouteLeg): string {
  if (leg.unknown) return leg.unknown;
  const lines = leg.parts.map((x) => `${x.label}：${formatDuration(x.seconds)}${x.fuel ? `，${x.fuel} SF` : ""}`);
  lines.push(`出发时油箱里按 ${Math.round(leg.fuelBefore)} SF 算（燃料用量是它的百分比，不是油箱容量的）`);
  lines.push("按现在出发算；行星在动，换个时间出发航程会变");
  return [...lines, ...leg.caveats.map((c) => `注意：${c}`)].join("\n");
}

// ---- 路线 ----
function addRoute() {
  const r = newRoute(`新路线 ${workspace.routes.length + 1}`);
  workspace.routes.push(r);
  workspace.activeRouteId = r.id;
}
function duplicateRoute() {
  const copy: RouteDoc = JSON.parse(JSON.stringify(route.value));
  copy.id = newId();
  copy.name += " 副本";
  workspace.routes.push(copy);
  workspace.activeRouteId = copy.id;
}
function closeRoute(r: RouteDoc) {
  if (!confirm(`从编辑器里移除「${r.name}」？没存下来的修改会丢。`)) return;
  workspace.routes.splice(workspace.routes.indexOf(r), 1);
  if (!workspace.routes.length) workspace.routes.push(newRoute());
  if (!workspace.routes.some((x) => x.id === workspace.activeRouteId)) workspace.activeRouteId = workspace.routes[0].id;
}
function usedGroups(r: RouteDoc): MaterialGroup[] {
  const ids = new Set(r.waypoints.flatMap((w) => w.steps.flatMap((s) => (s.kind === "group" ? [s.groupId] : []))));
  return workspace.groups.filter((g) => ids.has(g.id));
}
async function saveRoute(how: "file" | "copy") {
  if (how === "file") download(`route-${safeName(route.value.name)}.json`, route.value);
  else if (!(await copyText(toText(route.value)))) { say("浏览器不让写剪贴板，请改用存成文件。", true); return; }
  const used = usedGroups(route.value);
  const done = how === "file" ? "路线已存成文件。" : "路线的 json 已复制。";
  say(used.length
    ? `${done}它用到 ${used.length} 个材料组（${used.map((g) => g.name).join("、")}），材料组各自另存。`
    : done);
}
async function exportGame(how: "file" | "copy") {
  if (errors.value.length) {
    say(`还有 ${errors.value.length} 处问题没解决，先改掉标红的地方再导出。`, true);
    return;
  }
  if (how === "file") download(`game-${safeName(route.value.name)}.json`, result.value.game);
  else if (!(await copyText(toText(result.value.game)))) { say("浏览器不让写剪贴板，请改用导出成文件。", true); return; }
  say(`${how === "file" ? "已导出" : "已复制"}：${result.value.game.waypoints.length} 个 waypoint、${stepCount.value} 个步骤。`);
}

/** 用到的补给组如果是很久以前算的，导出的数量就不准了 */
const stale = computed(() => usedGroups(route.value)
  .filter((g) => g.resupply && Date.now() - g.resupply.updatedAt > 6 * 3600_000)
  .map((g) => g.name));

// ---- waypoint：自上而下排，位置由各节点的高度算出来 ----
const LEFT = 150;
const CARD_W = 420;
const GAP = 46;
const TOP = 24;
const heights = reactive<Record<string, number>>({});

const tops = computed(() => {
  const out: number[] = [];
  let y = TOP;
  for (const w of route.value.waypoints) {
    out.push(y);
    y += (heights[w.id] ?? 190) + GAP;
  }
  return { list: out, end: y };
});

function addWaypoint() {
  route.value.waypoints.push(newWaypoint());
}
function removeWaypoint(i: number) {
  const [gone] = route.value.waypoints.splice(i, 1);
  delete heights[gone.id];
  for (const w of route.value.waypoints) {
    for (const s of w.steps) if (s.kind === "mirror" && s.waypointId === gone.id) s.waypointId = "";
  }
}
function moveWaypoint(i: number, delta: number) {
  const list = route.value.waypoints;
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

// ---- 连线 ----
interface Edge { id: string; d: string; kind: "next" | "loop" | "ref"; label?: string; lx?: number; ly?: number }

const edges = computed<Edge[]>(() => {
  const list = route.value.waypoints;
  const y = tops.value.list;
  const h = (w: Waypoint) => heights[w.id] ?? 190;
  const out: Edge[] = [];
  const cx = LEFT + CARD_W / 2;
  for (let i = 0; i + 1 < list.length; i++) {
    out.push({ id: `n${i}`, kind: "next", d: `M ${cx} ${y[i] + h(list[i])} L ${cx} ${y[i + 1] - 2}` });
  }
  if (route.value.repeats && list.length > 1) {
    const y1 = y[list.length - 1] + 18;
    const y0 = y[0] + 18;
    out.push({ id: "loop", kind: "loop", d: `M ${LEFT} ${y1} C ${LEFT - 135} ${y1}, ${LEFT - 135} ${y0}, ${LEFT - 2} ${y0}`,
               label: "循环", lx: LEFT - 108, ly: (y0 + y1) / 2 });
  }
  let n = 0;
  list.forEach((w, i) => {
    for (const s of w.steps) {
      if (s.kind !== "mirror") continue;
      const j = list.findIndex((x) => x.id === s.waypointId);
      if (j < 0) continue;
      const bulge = 46 + 18 * (n++ % 4);
      const y1 = y[j] + Math.min(h(list[j]) - 10, 60);
      const y2 = y[i] + Math.min(h(w) - 10, 90);
      out.push({
        id: `r${s.id}`, kind: "ref",
        d: `M ${LEFT} ${y1} C ${LEFT - bulge} ${y1}, ${LEFT - bulge} ${y2}, ${LEFT - 2} ${y2}`,
        label: `${s.sourceOp === "LOAD" ? "装" : "卸"}→${s.op === "LOAD" ? "装" : "卸"}`,
        lx: LEFT - bulge * 0.75 - 4, ly: (y1 + y2) / 2 + 4,
      });
    }
  });
  return out;
});

// ---- 材料组 ----
const openGroup = ref("");
const draft = ref("");

function showGroup(g: MaterialGroup) {
  openGroup.value = g.id;
  draft.value = Object.entries(g.materials).map(([t, n]) => `${t} ${n}`).join("\n");
}
function toggleGroup(g: MaterialGroup) {
  if (openGroup.value === g.id) openGroup.value = "";
  else showGroup(g);
}
function addGroup() {
  const g = newGroup(`材料组 ${workspace.groups.length + 1}`);
  workspace.groups.push(g);
  showGroup(g);
}
/** 每行「材料 数量」，分隔符随意；同一种材料写多行会相加 */
function applyDraft(g: MaterialGroup) {
  const out: Record<string, number> = {};
  for (const line of draft.value.split(/\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9]+)[\s,:=x×]+(\d+)$/) ?? line.trim().match(/^(\d+)[\s,:=x×]+([A-Za-z0-9]+)$/);
    if (!m) continue;
    const [ticker, qty] = /^\d+$/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const n = Number(qty);
    if (n > 0) out[ticker.toUpperCase()] = (out[ticker.toUpperCase()] ?? 0) + n;
  }
  g.materials = out;
}
function renameGroup(g: MaterialGroup) {
  for (const r of workspace.routes) {
    for (const w of r.waypoints) for (const s of w.steps) if (s.kind === "group" && s.groupId === g.id) s.groupName = g.name;
  }
}
function removeGroup(g: MaterialGroup) {
  const users = workspace.routes.filter((r) => usedGroups(r).includes(g)).map((r) => r.name);
  const extra = users.length ? `路线「${users.join("、")}」还在用它，移除后那些步骤会标红。` : "";
  if (!confirm(`移除材料组「${g.name}」？${extra}`)) return;
  workspace.groups.splice(workspace.groups.indexOf(g), 1);
}
async function copyGroup(g: MaterialGroup) {
  if (await copyText(toText(g))) say(`材料组「${g.name}」的 json 已复制。`);
  else say("浏览器不让写剪贴板，请改用存成文件。", true);
}
function groupSize(g: MaterialGroup): string {
  const kinds = Object.keys(g.materials).length;
  let weight = 0;
  let volume = 0;
  for (const [t, n] of Object.entries(g.materials)) {
    const m = materials.value[t];
    if (m) { weight += m.weight * n; volume += m.volume * n; }
  }
  return Object.keys(materials.value).length
    ? `${kinds} 种 · ${weight.toFixed(1)} t · ${volume.toFixed(1)} m³`
    : `${kinds} 种`;
}
function dragGroup(e: DragEvent, g: MaterialGroup) {
  drag.groupId = g.id;
  e.dataTransfer?.setData("text/plain", g.name);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
}

// ---- FIO：补给组与基地产物 ----
const bases = ref<Base[]>([]);
const fioOpen = ref(!account.username || !account.apiKey);
const busy = ref("");

const fioText = (e: unknown) => (e instanceof FioError ? e.message : "读 FIO 的数据时出了意料之外的错误。");
function fioFailed(e: unknown) {
  say(fioText(e), true);
  if (e instanceof FioError && /用户名|API key/.test(e.message)) fioOpen.value = true;
}
const autoName = (g: MaterialGroup) => `${g.resupply!.planetName || g.resupply!.planet} 补到 ${g.resupply!.days} 天`;

async function loadBases(force = false): Promise<boolean> {
  busy.value = "bases";
  try {
    bases.value = await listBases(force);
    if (!bases.value.length) {
      say("FIO 的数据里没有你的基地。先在游戏里装着 FIO 插件打开一次基地列表。", true);
      return false;
    }
    if (force) say(`已读到 ${bases.value.length} 个基地。`);
    fioOpen.value = false;
    return true;
  } catch (e) {
    fioFailed(e);
    return false;
  } finally {
    busy.value = "";
  }
}
async function addResupplyGroup() {
  if (!(await loadBases())) return;
  // 当前路线里有自己的基地就先选它
  const onRoute = route.value.waypoints.map((w) => w.destination.naturalId);
  const first = bases.value.find((b) => onRoute.includes(b.naturalId)) ?? bases.value[0];
  const g = newGroup("", {}, "FIO 补给");
  g.resupply = { planet: first.naturalId, planetName: first.name, days: 30, includeLuxuries: true, deductStock: true, updatedAt: 0 };
  g.name = autoName(g);
  workspace.groups.push(g);
  showGroup(g);
  await refreshGroup(g);
}
/** 名字还是自动起的那个就跟着参数改，用户自己起过名字就不动 */
function changeSpec(g: MaterialGroup, patch: { planet?: string; days?: number }) {
  const r = g.resupply!;
  const was = autoName(g);
  if (patch.planet) {
    r.planet = patch.planet;
    r.planetName = bases.value.find((b) => b.naturalId === patch.planet)?.name ?? "";
  }
  if (patch.days != null) r.days = Math.max(1, Math.round(patch.days) || 1);
  if (!g.name || g.name === was) { g.name = autoName(g); renameGroup(g); }
  refreshGroup(g);
}
async function refreshGroup(g: MaterialGroup) {
  if (!g.resupply) return;
  busy.value = g.id;
  try {
    const got = await resupply(g.resupply);
    g.materials = got.materials;
    g.resupply.planetName = got.planetName;
    g.resupply.updatedAt = Date.now();
    if (openGroup.value === g.id) showGroup(g);
    const kinds = Object.keys(got.materials).length;
    say(kinds
      ? `「${g.name}」已按 FIO 的最新数据更新：${kinds} 种材料。`
      : `「${g.name}」：${got.planetName} 现有库存已经够 ${g.resupply.days} 天，不用带东西。`);
  } catch (e) {
    fioFailed(e);
  } finally {
    busy.value = "";
  }
}
async function refreshAll() {
  for (const g of workspace.groups.filter((x) => x.resupply)) await refreshGroup(g);
}
function ago(at: number): string {
  if (!at) return "还没算过";
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return "刚刚更新";
  if (min < 60) return `${min} 分钟前更新`;
  if (min < 48 * 60) return `${Math.round(min / 60)} 小时前更新`;
  return `${Math.round(min / 1440)} 天前更新`;
}

/** 在这一站装走这个基地的产物：每种净产出的材料一个装货步骤，有多少装多少、没有也不等 */
async function addProducts(wp: Waypoint) {
  const where = destinationLabel(wp.destination);
  if (!wp.destination.naturalId) { say("先给这一站设好目的地。", true); return; }
  busy.value = `products:${wp.id}`;
  try {
    const products = await baseProducts(wp.destination.naturalId);
    const have = new Set(wp.steps.flatMap((s) => (s.kind === "material" && s.op === "LOAD" ? [s.ticker] : [])));
    const fresh = products.filter((p) => !have.has(p.ticker));
    // 基地自己也要用的材料（既是产物又是投入 / 工人消耗）留下一天的用量，别把产线的料装走
    const keep = (p: { usedDaily: number }) => (p.usedDaily > 1e-9 ? Math.ceil(p.usedDaily - 1e-6) : 0);
    for (const p of fresh) {
      const step: Step = { id: newId(), kind: "material", op: "LOAD", ticker: p.ticker, min: abs(0), max: cap(), retain: keep(p) };
      wp.steps.push(step);
    }
    const kept = fresh.filter((p) => keep(p) > 0);
    if (!products.length) say(`${where} 现在没有净产出的材料（产出的都被自己用掉了，或者产线没排单）。`, true);
    else if (!fresh.length) say(`${where} 的产物（${products.map((p) => p.ticker).join("、")}）都已经在装货步骤里了。`);
    else say(`已为 ${where} 加上 ${fresh.length} 种产物的装货：${fresh.map((p) => `${p.ticker}（约 ${p.daily.toFixed(1)}/天）`).join("、")}。`
      + (kept.length ? `基地自己也要用的留了一天的量：${kept.map((p) => `${p.ticker} 留 ${keep(p)}`).join("、")}。` : "")
      + "不想要的删掉即可。");
  } catch (e) {
    fioFailed(e);
  } finally {
    busy.value = "";
  }
}

// ---- 读入：文件或粘贴 ----
const picker = ref<HTMLInputElement | null>(null);
const pasteOpen = ref(false);
const pasteText = ref("");

function take(sources: { name: string; text: string }[]) {
  const done: string[] = [];
  const failed: string[] = [];
  let groupCount = 0;
  for (const src of sources) {
    try {
      const got = parseFile(src.text, src.name);
      if (got.kind === "ships") {
        for (const sh of got.ships) {
          const at = workspace.ships.findIndex((x) => x.name === sh.name);
          if (at >= 0) workspace.ships[at] = sh;
          else workspace.ships.push(sh);
        }
        if (!ship.value) pickShip(got.ships[0].name);
        done.push(`${got.ships.length} 艘船的参数`);
      } else if (got.kind === "route") {
        upsertRoute(got.route);
        done.push(`路线「${got.route.name}」`);
      } else {
        got.groups.forEach(upsertGroup);
        groupCount += got.groups.length;
        if (got.skipped.length) {
          failed.push(`${got.skipped.join("、")} 的数量要在游戏里现算，内容里没有，没法导入（可以改用「+ 补给组」）`);
        }
      }
    } catch (e) {
      failed.push(e instanceof ImportError ? e.message : `「${src.name}」读不出来。`);
    }
  }
  if (groupCount) done.push(`${groupCount} 个材料组`);
  relinkGroups();
  say([done.length ? `已载入 ${done.join("、")}。` : "", ...failed].filter(Boolean).join(" "), failed.length > 0);
  return failed.length === 0;
}
async function readFiles(files: FileList | null) {
  if (!files?.length) return;
  take(await Promise.all(Array.from(files).map(async (f) => ({ name: f.name, text: await f.text() }))));
  if (picker.value) picker.value.value = "";
}
function dropFiles(e: DragEvent) {
  if (e.dataTransfer?.files.length) readFiles(e.dataTransfer.files);
}
function importPaste() {
  if (!pasteText.value.trim()) return;
  if (take([{ name: "粘贴的内容", text: pasteText.value }])) {
    pasteText.value = "";
    pasteOpen.value = false;
  }
}
</script>

<template>
  <div class="page" @dragover.prevent @drop.prevent="dropFiles">
    <aside class="lib">
      <section>
        <h3>路线 <button type="button" title="新建一条空路线" @click="addRoute">+ 新建</button></h3>
        <ul>
          <li v-for="r in workspace.routes" :key="r.id" class="route" :class="{ on: r.id === route.id }"
              @click="workspace.activeRouteId = r.id">
            <span class="name">{{ r.name || "未命名" }}</span>
            <span class="dim">{{ r.waypoints.length }} 站</span>
            <button type="button" class="x" title="从编辑器里移除" @click.stop="closeRoute(r)">✕</button>
          </li>
        </ul>
      </section>

      <section>
        <h3>材料组
          <span class="btns">
            <button type="button" title="新建一个手填的材料组" @click="addGroup">+ 新建</button>
            <button type="button" title="把某个基地补到 N 天，数量按 FIO 的数据算" :disabled="busy !== ''"
                    @click="addResupplyGroup">+ 补给组</button>
          </span>
        </h3>
        <p v-if="!workspace.groups.length" class="dim tip">
          还没有材料组。可以新建、用 FIO 生成补给组，或在下面载入 XIT ACT 包 / 材料组的 json。
        </p>
        <ul>
          <li v-for="g in workspace.groups" :key="g.id" class="group" :class="{ on: openGroup === g.id }">
            <div class="row" draggable="true" title="拖到某个 waypoint 上，就在那里装这一组" @click="toggleGroup(g)"
                 @dragstart="dragGroup($event, g)" @dragend="clearDrag()">
              <span class="grip">⠿</span>
              <span class="name">{{ g.name }}</span>
              <span class="dim">{{ groupSize(g) }}</span>
            </div>
            <div v-if="openGroup === g.id" class="edit">
              <input v-model="g.name" type="text" placeholder="名字" @change="renameGroup(g)" />
              <template v-if="g.resupply">
                <label>基地
                  <select :value="g.resupply.planet" @focus="bases.length || loadBases()"
                          @change="changeSpec(g, { planet: ($event.target as HTMLSelectElement).value })">
                    <option v-if="!bases.some((b) => b.naturalId === g.resupply!.planet)" :value="g.resupply.planet">
                      {{ g.resupply.planetName || g.resupply.planet }}
                    </option>
                    <option v-for="b in bases" :key="b.naturalId" :value="b.naturalId">{{ b.name }} ({{ b.naturalId }})</option>
                  </select></label>
                <label>补到
                  <input :value="g.resupply.days" class="days" type="number" min="1" step="1"
                         @change="changeSpec(g, { days: Number(($event.target as HTMLInputElement).value) })" /> 天</label>
                <label title="关掉就不带奢侈消费品，工人满足度和效率会下降">
                  <input v-model="g.resupply.includeLuxuries" type="checkbox" @change="refreshGroup(g)" />含奢侈品</label>
                <label title="勾上：带的量 = 需要的量 − 基地里已有的；不勾：按满量带">
                  <input v-model="g.resupply.deductStock" type="checkbox" @change="refreshGroup(g)" />扣掉基地现有库存</label>
                <div class="chips">
                  <i v-for="(n, t) in g.materials" :key="t">{{ t }} {{ n }}</i>
                  <span v-if="!Object.keys(g.materials).length" class="dim">现在不用带东西。</span>
                </div>
                <div class="dim">{{ busy === g.id ? "正在读 FIO…" : ago(g.resupply.updatedAt) }}</div>
              </template>
              <template v-else>
                <textarea v-model="draft" rows="8" spellcheck="false" placeholder="每行一种：RAT 300" @change="applyDraft(g)" />
                <div class="dim">来源：{{ g.origin }}</div>
              </template>
              <div class="btns">
                <button v-if="g.resupply" type="button" :disabled="busy !== ''" @click="refreshGroup(g)">更新</button>
                <button type="button" title="复制这个材料组的 json" @click="copyGroup(g)">复制</button>
                <button type="button" @click="download(`group-${safeName(g.name)}.json`, g)">存成文件</button>
                <button type="button" class="danger" @click="removeGroup(g)">移除</button>
              </div>
            </div>
          </li>
        </ul>
        <button v-if="workspace.groups.some((g) => g.resupply)" type="button" class="wide" :disabled="busy !== ''"
                title="按 FIO 的最新数据重算所有补给组" @click="refreshAll">更新全部补给组</button>
      </section>

      <section class="files">
        <input ref="picker" type="file" accept=".json,application/json" multiple hidden
               @change="readFiles(($event.target as HTMLInputElement).files)" />
        <div class="btns">
          <button type="button" @click="picker?.click()">打开文件…</button>
          <button type="button" @click="pasteOpen = !pasteOpen">粘贴导入…</button>
        </div>
        <div v-if="pasteOpen" class="edit paste">
          <textarea v-model="pasteText" rows="7" spellcheck="false" placeholder="把 json 粘贴到这里" />
          <button type="button" class="primary" :disabled="!pasteText.trim()" @click="importPaste">导入</button>
        </div>
        <p class="dim tip">路线、材料组、XIT ACT 包都认，文件可以一次选多个，也可以直接拖进页面。</p>
        <p class="dim tip">
          导出的内容交给游戏内脚本去配置：<a href="/prun-route-loader.user.js" target="_blank">安装游戏内脚本</a>（需要 Tampermonkey）。
        </p>
      </section>

      <section>
        <h3>FIO 账号 <button type="button" @click="fioOpen = !fioOpen">{{ fioOpen ? "收起" : account.username || "设置" }}</button></h3>
        <div v-if="fioOpen" class="edit acct">
          <input v-model.trim="account.username" type="text" placeholder="FIO 用户名" autocomplete="off" />
          <input v-model.trim="account.apiKey" type="password" placeholder="FIO API key" autocomplete="off" />
          <button type="button" :disabled="busy !== '' || !account.username || !account.apiKey" @click="loadBases(true)">
            {{ busy === "bases" ? "正在读 FIO…" : "读取我的基地" }}</button>
          <p class="dim tip">只存在这台电脑的浏览器里，由浏览器直接发给 FIO，不经过本站。补给组和「产物」按钮靠它取数。</p>
        </div>
      </section>
    </aside>

    <section class="main">
      <div class="bar">
        <input v-model="route.name" class="title" type="text" placeholder="路线名字" />
        <label title="跑完最后一个 waypoint 后回到第一个，一直循环"><input v-model="route.repeats" type="checkbox" />循环</label>
        <label title="每一站都先卸下送到这里的运单、最后装上要送往后面的运单；某一站自己写了运单步骤的，以它写的为准">
          <input v-model="route.autoShipments" type="checkbox" />每站自动装卸运单</label>
        <button type="button" class="primary" @click="addWaypoint">+ waypoint</button>
        <button type="button" title="复制出一条一样的路线" @click="duplicateRoute">复制路线</button>
        <span class="gap" />
        <label title="选一艘船来估每一段的航行时间和耗油。船的参数从游戏内脚本的「复制船只参数」拿，在左边「粘贴导入」">船
          <select :value="workspace.shipName" @change="pickShip(($event.target as HTMLSelectElement).value)">
            <option value="">{{ workspace.ships.length ? "不估时间" : "还没导入船" }}</option>
            <option v-for="sh in workspace.ships" :key="sh.name" :value="sh.name">{{ sh.name }}</option>
          </select></label>
        <label title="填了才检查会不会超出货舱">货舱
          <input v-model.number="workspace.shipWeight" class="cap" type="number" min="0" placeholder="t" /> t
          <input v-model.number="workspace.shipVolume" class="cap" type="number" min="0" placeholder="m³" /> m³</label>
        <label title="同一个 waypoint 里紧挨着的、同一种材料同一方向的精确步骤合成一步，脚本少点几下">
          <input v-model="workspace.mergeAdjacent" type="checkbox" />合并相邻</label>
        <span class="pair" title="这条路线的配置（材料组与引用原样保留）">
          <button type="button" @click="saveRoute('file')">存路线文件</button>
          <button type="button" title="复制路线的 json" @click="saveRoute('copy')">复制</button></span>
        <span class="pair" title="展开成游戏里的逐材料步骤，交给游戏内脚本">
          <button type="button" class="primary" @click="exportGame('file')">导出给游戏</button>
          <button type="button" class="primary" title="复制导出的 json，到游戏内脚本里粘贴" @click="exportGame('copy')">复制</button></span>
      </div>

      <div class="status">
        <span>展开后 {{ result.game.waypoints.length }} 个 waypoint、{{ stepCount }} 个步骤，脚本在游戏里约需点 {{ result.clicks }} 下。</span>
        <span v-for="(i, n) in looseIssues" :key="n" :class="i.level === 'error' ? 'err' : 'warn'">{{ i.text }}</span>
        <span v-if="estimate && route.waypoints.length > 1">
          {{ route.repeats ? "跑一圈" : "全程" }}{{ estimate.totalSeconds == null ? "有的段估不了" : `约 ${formatDuration(estimate.totalSeconds)}` }}，
          STL 约 {{ estimate.totalFuel }} SF（按现在出发、满油箱起步）。</span>
        <span v-if="stale.length" class="warn">补给组「{{ stale.join("、") }}」是 6 小时以前算的，导出前建议先更新。</span>
        <span v-if="notice" :class="noticeBad ? 'err' : 'ok'">{{ notice }}</span>
      </div>

      <div class="canvas">
        <div class="sheet" :style="{ height: tops.end + 60 + 'px' }">
          <svg width="100%" :height="tops.end + 60">
            <defs>
              <marker id="arrow-next" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L10 5 L0 10 z" fill="#6f8fc0" />
              </marker>
              <marker id="arrow-ref" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L10 5 L0 10 z" fill="#c9954a" />
              </marker>
            </defs>
            <g v-for="e in edges" :key="e.id">
              <path :d="e.d" :class="e.kind" :marker-end="e.kind === 'ref' ? 'url(#arrow-ref)' : 'url(#arrow-next)'" />
              <text v-if="e.label" :x="e.lx" :y="e.ly" :class="e.kind" text-anchor="end">{{ e.label }}</text>
            </g>
          </svg>
          <p v-if="!route.waypoints.length" class="blank">
            这条路线还是空的。点上面的「+ waypoint」加第一个停靠点。
          </p>
          <WaypointNode v-for="(wp, i) in route.waypoints" :key="wp.id" class="placed"
                        :style="{ left: LEFT + 'px', top: tops.list[i] + 'px' }"
                        :route="route" :wp="wp" :index="i" :groups="workspace.groups" :materials="materials"
                        :leg="legFor(wp)" :issues="issuesFor(wp)" :loading-products="busy === `products:${wp.id}`"
                        @remove="removeWaypoint(i)" @move="moveWaypoint(i, $event)" @size="heights[wp.id] = $event"
                        @products="addProducts(wp)" />
          <template v-if="estimate">
            <span v-for="leg in estimate.legs" :key="leg.toIndex" class="leg" :class="{ unknown: leg.unknown }" :title="legTitle(leg)"
                  :style="leg.toIndex > 0
                    ? { left: LEFT + CARD_W / 2 + 14 + 'px', top: (tops.list[leg.toIndex] ?? 0) - GAP / 2 - 9 + 'px' }
                    : { left: LEFT + 110 + 'px', top: tops.end - GAP + 16 + 'px' }">
              {{ leg.toIndex > 0 ? "" : "回到第 1 站：" }}{{ legText(leg) }}</span>
          </template>
          <button v-if="route.waypoints.length" type="button" class="primary more"
                  :style="{ left: LEFT + 'px', top: tops.end - GAP + 12 + 'px' }" @click="addWaypoint">+ waypoint</button>
        </div>
      </div>
    </section>

    <datalist id="route-tickers"><option v-for="t in tickers" :key="t" :value="t" /></datalist>
  </div>
</template>

<style scoped>
.page { display: flex; gap: 16px; height: calc(100vh - 48px); min-height: 480px; }
.lib { width: 270px; flex: none; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; font-size: 12px; padding-right: 2px; }
h3 { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #9db4d0; margin: 0 0 6px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.lib li { background: #1e2128; border: 1px solid #2c3140; border-radius: 4px; }
.route, .group .row { display: flex; gap: 6px; align-items: center; padding: 5px 6px; cursor: pointer; }
.lib li.on { border-color: #4f79b8; background: #232a38; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e2e2e2; }
.grip { color: #6b7280; cursor: grab; }
.x { border: 0; background: none; color: #8a8f99; padding: 0 2px; }
.edit { display: flex; flex-direction: column; gap: 5px; padding: 0 6px 6px; }
.edit label { display: flex; gap: 5px; align-items: center; color: #9db4d0; }
.edit label select { flex: 1; min-width: 0; }
.edit textarea { font-family: ui-monospace, Consolas, monospace; font-size: 12px; resize: vertical; }
.paste, .acct { padding: 6px 0 0; }
.days { width: 60px; text-align: right; }
.chips { display: flex; flex-wrap: wrap; gap: 3px; }
.chips i { font-style: normal; background: #2a2e38; color: #c5ccd8; padding: 0 5px; border-radius: 3px;
           font-variant-numeric: tabular-nums; }
.btns { display: flex; gap: 4px; flex-wrap: wrap; }
.wide { width: 100%; margin-top: 6px; }
.tip { margin: 4px 0; line-height: 1.5; }
.tip a { color: #9db4d0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.bar { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 13px; }
.bar label { display: inline-flex; gap: 4px; align-items: center; color: #9db4d0; }
.title { width: 200px; font-size: 15px; font-weight: 600; }
.cap { width: 64px; text-align: right; }
.gap { flex: 1; }
.pair { display: inline-flex; }
.pair button + button { border-left: 0; }
.status { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: #8a8f99; }
.canvas { flex: 1; min-height: 0; overflow: auto; background: #12141a; border: 1px solid #2c3140; border-radius: 6px;
          background-image: radial-gradient(#262a34 1px, transparent 1px); background-size: 20px 20px; }
.sheet { position: relative; min-width: 760px; }
svg { position: absolute; left: 0; top: 0; pointer-events: none; }
path { fill: none; stroke-width: 2; }
path.next { stroke: #6f8fc0; }
path.loop { stroke: #6f8fc0; stroke-dasharray: 7 5; }
path.ref { stroke: #c9954a; stroke-dasharray: 3 4; stroke-width: 1.5; }
text { font-size: 11px; }
text.ref { fill: #c9954a; }
text.loop { fill: #6f8fc0; }
.placed { position: absolute; }
.more { position: absolute; }
.leg { position: absolute; font-size: 11px; color: #9fc3f5; background: #12141a; padding: 0 6px; border-radius: 3px;
       white-space: nowrap; cursor: help; }
.leg.unknown { color: #8a8f99; }
.blank { position: absolute; left: 40px; top: 30px; margin: 0; color: #8a8f99; font-size: 13px; }
input, select, textarea, button { background: #23262e; color: #eee; border: 1px solid #444; padding: 3px 6px; font-size: 12px; }
button { cursor: pointer; color: #cfd6e2; }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: #2f4f80; border-color: #4f79b8; color: #fff; }
button.danger { color: #e08a8a; }
.dim { color: #8a8f99; }
.err { color: #f08a8a; }
.warn { color: #c9b06a; }
.ok { color: #8fcf9f; }
@media (max-width: 900px) {
  .page { flex-direction: column; height: auto; }
  .lib { width: auto; }
  .canvas { height: 70vh; flex: none; }
}
</style>
