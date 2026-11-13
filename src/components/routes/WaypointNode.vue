<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { Issue, LegLoad, MaterialInfo } from "../../routes/compile";
import { stepLines, summarize } from "../../routes/compile";
import { clearDrag, drag } from "../../routes/drag";
import type { MaterialGroup, Op, RouteDoc, Step, StepKind, Waypoint } from "../../routes/model";
import { destinationLabel, newStep } from "../../routes/model";
import AmountInput from "./AmountInput.vue";
import LocationInput from "./LocationInput.vue";

const props = defineProps<{
  route: RouteDoc;
  wp: Waypoint;
  index: number;
  groups: MaterialGroup[];
  materials: Record<string, MaterialInfo>;
  leg?: LegLoad;
  issues: Issue[];
  loadingProducts?: boolean;
}>();
const emit = defineEmits<{
  remove: [];
  move: [delta: number];
  size: [height: number];
  products: [];
}>();

const root = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(() => { if (root.value) emit("size", root.value.offsetHeight); });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

const groupMap = computed(() => Object.fromEntries(props.groups.map((g) => [g.id, g])));
const others = computed(() => props.route.waypoints
  .map((w, i) => ({ id: w.id, label: `${i + 1}. ${destinationLabel(w.destination)}` }))
  .filter((w) => w.id !== props.wp.id));

const ADD: { kind: StepKind; op?: Op; label: string; title: string }[] = [
  { kind: "material", op: "LOAD", label: "装货", title: "装一种材料" },
  { kind: "material", op: "UNLOAD", label: "卸货", title: "卸一种材料" },
  { kind: "group", op: "LOAD", label: "材料组", title: "装 / 卸一整个材料组，数量按组里的精确值" },
  { kind: "mirror", op: "UNLOAD", label: "引用", title: "装 / 卸另一个 waypoint 的装或卸的内容" },
  { kind: "refuel", label: "加油", title: "给 STL 或 FTL 油箱加油" },
  { kind: "wait", label: "等待", title: "在这里停一段时间" },
  { kind: "loadShipment", label: "装运单", title: "装上要送往后面 waypoint 的运单货物" },
  { kind: "unloadShipment", label: "卸运单", title: "卸下送到这里的运单货物" },
];
const SHIPMENT_TEXT = {
  loadShipment: "装上所有要送往后面 waypoint 的运单",
  unloadShipment: "卸下所有送到这里的运单",
};

function add(kind: StepKind, op?: Op) {
  const step = newStep(kind, op);
  if (step.kind === "group" && props.groups.length === 1) {
    step.groupId = props.groups[0].id;
    step.groupName = props.groups[0].name;
  }
  if (step.kind === "mirror") {
    // 默认引用前一个 waypoint 的装货：「在上一站装的，到这里卸」是最常见的用法
    const prev = props.route.waypoints[props.index - 1];
    step.waypointId = prev?.id ?? others.value[0]?.id ?? "";
    step.sourceOp = "LOAD";
  }
  props.wp.steps.push(step);
}

function removeStep(i: number) { props.wp.steps.splice(i, 1); }
function flip(step: Step) {
  if ("op" in step) step.op = step.op === "LOAD" ? "UNLOAD" : "LOAD";
}
function pickGroup(step: Step, id: string) {
  if (step.kind !== "group") return;
  step.groupId = id;
  step.groupName = groupMap.value[id]?.name ?? "";
}

/** 材料组 / 引用步骤展开后的摘要 */
function digest(step: Step): { text: string; chips: string[]; more: number; bad: boolean } {
  let lines;
  try {
    lines = stepLines(props.route, groupMap.value, step);
  } catch {
    return { text: "引用绕了一圈回到自己", chips: [], more: 0, bad: true };
  }
  if (!lines.length) return { text: "没有内容", chips: [], more: 0, bad: true };
  const { exact, open } = summarize(lines);
  let weight = 0;
  let volume = 0;
  for (const [t, n] of Object.entries(exact)) {
    const m = props.materials[t];
    if (m) { weight += m.weight * n; volume += m.volume * n; }
  }
  const chips = [
    ...Object.entries(exact).map(([t, n]) => `${t} ${n}`),
    ...open.map((t) => `${t} ∞`),
  ];
  const size = Object.keys(props.materials).length ? ` · ${weight.toFixed(1)} t · ${volume.toFixed(1)} m³` : "";
  return { text: `${chips.length} 种${size}`, chips: chips.slice(0, 8), more: Math.max(0, chips.length - 8), bad: false };
}

// ---- 拖放：步骤换顺序 / 挪到别的 waypoint，材料组从左边拖进来 ----
const over = ref(-1);

function startDrag(e: DragEvent, step: Step) {
  drag.step = { waypointId: props.wp.id, stepId: step.id };
  e.dataTransfer?.setData("text/plain", step.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function allow(e: DragEvent, index: number) {
  if (!drag.step && !drag.groupId) return;
  e.preventDefault();
  over.value = index;
}
function drop(index: number) {
  over.value = -1;
  if (drag.groupId) {
    const g = groupMap.value[drag.groupId];
    if (g) props.wp.steps.splice(index, 0, { ...newStep("group", "LOAD"), groupId: g.id, groupName: g.name } as Step);
  } else if (drag.step) {
    const from = props.route.waypoints.find((w) => w.id === drag.step!.waypointId);
    const at = from?.steps.findIndex((s) => s.id === drag.step!.stepId) ?? -1;
    if (from && at >= 0) {
      const [moved] = from.steps.splice(at, 1);
      props.wp.steps.splice(from === props.wp && at < index ? index - 1 : index, 0, moved);
    }
  }
  clearDrag();
}

/** 路线开了「每站自动装卸运单」时，这一站会自动加上哪一头 */
const auto = computed(() => ({
  unload: props.route.autoShipments && !props.wp.steps.some((s) => s.kind === "unloadShipment"),
  load: props.route.autoShipments && !props.wp.steps.some((s) => s.kind === "loadShipment"),
}));

const stepIssues = computed(() => {
  const out: Record<string, Issue[]> = {};
  for (const i of props.issues) if (i.stepId) (out[i.stepId] ??= []).push(i);
  return out;
});
const nodeIssues = computed(() => props.issues.filter((i) => !i.stepId));
</script>

<template>
  <div ref="root" class="node">
   <div class="card" :class="{ bad: issues.some((i) => i.level === 'error') }">
    <header>
      <span class="no">{{ index + 1 }}</span>
      <LocationInput v-model="wp.destination" />
      <button type="button" title="往前挪一位" :disabled="index === 0" @click="emit('move', -1)">▲</button>
      <button type="button" title="往后挪一位" :disabled="index === route.waypoints.length - 1" @click="emit('move', 1)">▼</button>
      <button type="button" class="danger" title="删除这个 waypoint" @click="emit('remove')">✕</button>
    </header>

    <div class="flight">
      <label title="飞到这里时的 STL 燃料用量，越低越省油、越慢">燃料
        <input v-model.number="wp.fuelUsage" type="number" min="1" max="100" step="1" />%</label>
      <label title="飞到这里时的 FTL 反应堆用量">反应堆
        <input v-model.number="wp.reactorUsage" type="number" min="1" max="100" step="1" />%</label>
      <select v-model="wp.ftlPreference" title="跨星系时怎么选路">
        <option value="LEAST_JUMPS">最少跳数</option>
        <option value="SHORTEST_FTL">最短 FTL</option>
      </select>
      <label title="允许走星门"><input v-model="wp.useGateways" type="checkbox" />星门</label>
    </div>

    <p v-for="(i, n) in nodeIssues" :key="n" class="issue" :class="i.level">{{ i.text }}</p>

 <p v-if="auto.unload" class="auto">自动：先卸下送到这里的运单</p>
    <ol class="steps" @dragover="allow($event, wp.steps.length)" @drop.prevent="drop(over < 0 ? wp.steps.length : over)"
        @dragleave="over = -1">
      <li v-if="!wp.steps.length" class="empty">{{ route.autoShipments ? "除了运单，到这里不做别的。" : "到这里什么也不做。" }}用右边的按钮加步骤，或把左边的材料组拖进来。</li>
      <li v-for="(step, i) in wp.steps" :key="step.id" class="step" :class="{ over: over === i }"
          @dragover.stop="allow($event, i)" @drop.prevent.stop="drop(i)">
        <span class="grip" draggable="true" title="拖动换顺序，也可以拖到别的 waypoint"
              @dragstart="startDrag($event, step)" @dragend="clearDrag(); over = -1">⠿</span>

        <button v-if="'op' in step" type="button" class="op" :class="step.op.toLowerCase()"
                title="点一下在装货 / 卸货之间切换" @click="flip(step)">{{ step.op === "LOAD" ? "装" : "卸" }}</button>

        <template v-if="step.kind === 'material'">
          <input v-model.trim="step.ticker" class="ticker" list="route-tickers" placeholder="材料" spellcheck="false"
                 @change="step.ticker = step.ticker.toUpperCase()" />
          <AmountInput v-model="step.min" :cap-label="step.op === 'LOAD' ? '装满' : '全部'"
                       title="最小值：凑不够这个数就一个也不动，原地等" />
          <span class="dim">–</span>
          <AmountInput v-model="step.max" :cap-label="step.op === 'LOAD' ? '装满' : '全部'" title="最大值：最多动这么多" />
          <label v-if="step.op === 'LOAD'" class="retain" title="在原仓库里留下这么多不装走">留
            <input v-model.number="step.retain" type="number" min="0" step="1" /></label>
        </template>

        <template v-else-if="step.kind === 'group'">
          <span class="body">
            <select :value="step.groupId" :class="{ missing: !groupMap[step.groupId] }"
                    @change="pickGroup(step, ($event.target as HTMLSelectElement).value)">
              <option v-if="!groupMap[step.groupId]" :value="step.groupId" disabled>
                {{ step.groupId ? `${step.groupName || "未命名"}（未载入）` : "选一个材料组" }}
              </option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
            <span v-if="groupMap[step.groupId]" class="digest" :title="digest(step).chips.join('  ')">
              {{ digest(step).text }}
              <span class="chips"><i v-for="c in digest(step).chips" :key="c">{{ c }}</i>
                <i v-if="digest(step).more">+{{ digest(step).more }}</i></span>
            </span>
          </span>
        </template>

        <template v-else-if="step.kind === 'mirror'">
          <span class="body">
            <span class="ref">
              <select v-model="step.waypointId" :class="{ missing: !others.some((w) => w.id === step.waypointId) }">
                <option value="" disabled>选一个 waypoint</option>
                <option v-for="w in others" :key="w.id" :value="w.id">{{ w.label }}</option>
              </select>
              <span class="dim">的</span>
              <select v-model="step.sourceOp">
                <option value="LOAD">装货内容</option>
                <option value="UNLOAD">卸货内容</option>
              </select>
            </span>
            <span v-if="step.waypointId" class="digest" :class="{ warn: digest(step).bad }">
              {{ digest(step).text }}
              <span class="chips"><i v-for="c in digest(step).chips" :key="c">{{ c }}</i>
                <i v-if="digest(step).more">+{{ digest(step).more }}</i></span>
            </span>
          </span>
        </template>

        <template v-else-if="step.kind === 'refuel'">
          <span class="kind">加油</span>
          <select v-model="step.fuel"><option value="STL">STL</option><option value="FTL">FTL</option></select>
          <select v-model="step.source" title="油从哪来">
            <option value="LOCAL_STORE">当地仓库</option><option value="SHIP_STORE">船上货舱</option>
          </select>
          <AmountInput v-model="step.min" cap-label="加满" title="最小值：油源不够这个数就等" />
          <span class="dim">–</span>
          <AmountInput v-model="step.max" cap-label="加满" title="最大值" />
        </template>

        <template v-else-if="step.kind === 'wait'">
          <span class="kind">等待</span>
          <input v-model.number="step.amount" class="num" type="number" min="0" step="1" />
          <select v-model="step.unit">
            <option value="SECONDS">秒</option><option value="MINUTES">分钟</option>
            <option value="HOURS">小时</option><option value="DAYS">天</option>
          </select>
        </template>

        <template v-else>
          <span class="kind">{{ step.kind === "loadShipment" ? "装运单" : "卸运单" }}</span>
          <span class="dim note">{{ SHIPMENT_TEXT[step.kind] }}</span>
        </template>

        <button type="button" class="danger del" title="删除这一步" @click="removeStep(i)">✕</button>
        <p v-for="(issue, n) in stepIssues[step.id] ?? []" :key="n" class="issue" :class="issue.level">{{ issue.text }}</p>
      </li>
      <li v-if="over === wp.steps.length && wp.steps.length" class="tail" />
    </ol>

    <p v-if="auto.load" class="auto">自动：最后装上要送往后面的运单</p>

    <footer v-if="leg && (leg.weight || leg.volume)">
      离站时船上 {{ leg.weight.toFixed(1) }} t · {{ leg.volume.toFixed(1) }} m³<template v-if="!leg.exact">（不含「装满」的材料）</template>
    </footer>
   </div>
   <div class="side">
     <button v-for="a in ADD" :key="a.label" type="button" :title="a.title" @click="add(a.kind, a.op)">+ {{ a.label }}</button>
     <button type="button" class="full" :disabled="loadingProducts"
             title="装走这个基地的产物：按 FIO 的数据找出这里净产出的材料，每种加一个装货步骤"
             @click="emit('products')">{{ loadingProducts ? "正在读 FIO…" : "+ 装这个基地的产物" }}</button>
   </div>
  </div>
</template>

<style scoped>
.node { display: flex; gap: 10px; align-items: flex-start; font-size: 12px; }
.card { width: 420px; flex: none; background: #1e2128; border: 1px solid #3a4050; border-radius: 6px;
        box-shadow: 0 4px 14px #0006; }
.card.bad { border-color: #a04848; }
.side { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; width: 150px; padding-top: 2px; }
.side button { color: #9db4d0; text-align: left; white-space: nowrap; }
.side .full { grid-column: 1 / -1; }
.auto { margin: 0; padding: 4px 8px; color: #7f95b3; font-style: italic; }
header { display: flex; gap: 4px; align-items: center; padding: 6px; background: #2c3140; border-radius: 6px 6px 0 0; }
.no { width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 50%; background: #4f79b8;
      color: #fff; font-weight: 700; flex: none; }
button { background: #23262e; color: #cfd6e2; border: 1px solid #444; padding: 2px 6px; cursor: pointer; font-size: 12px; }
button:disabled { opacity: .35; cursor: default; }
button.danger { color: #e08a8a; }
.flight { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; padding: 6px 8px; border-bottom: 1px solid #2c3140;
          color: #9db4d0; }
.flight label { display: inline-flex; gap: 3px; align-items: center; }
.flight input[type="number"] { width: 46px; text-align: right; }
input, select { background: #23262e; color: #eee; border: 1px solid #444; padding: 2px 4px; font-size: 12px; }
.steps { list-style: none; margin: 0; padding: 4px 6px; min-height: 34px; }
.empty { color: #8a8f99; padding: 6px 2px; line-height: 1.5; }
.step { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 3px 0; border-top: 2px solid transparent; }
.step.over { border-top-color: #6fa8ff; }
.tail { height: 0; border-top: 2px solid #6fa8ff; }
.grip { cursor: grab; color: #6b7280; padding: 0 2px; user-select: none; }
.op { width: 24px; padding: 2px 0; font-weight: 700; border-radius: 3px; flex: none; }
.op.load { background: #1f4a2c; color: #9be0ad; border-color: #2f6b41; }
.op.unload { background: #55351c; color: #f0b987; border-color: #7a4d29; }
.ticker { width: 58px; text-transform: uppercase; font-weight: 600; }
.retain { display: inline-flex; gap: 3px; align-items: center; color: #9db4d0; }
.retain input, .num { width: 54px; text-align: right; }
.kind { color: #9db4d0; font-weight: 600; min-width: 42px; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.body > select { width: 100%; }
.ref { display: flex; gap: 4px; align-items: center; }
.ref select:first-child { flex: 1; min-width: 0; }
select.missing { border-color: #a04848; color: #e08a8a; }
.digest { color: #8a8f99; }
.digest.warn { color: #c9b06a; }
.chips { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
.chips i { font-style: normal; background: #2a2e38; color: #c5ccd8; padding: 0 5px; border-radius: 3px;
           font-variant-numeric: tabular-nums; }
.note { flex: 1; }
.del { margin-left: auto; border-color: transparent; background: none; }
.dim { color: #8a8f99; }
.issue { flex-basis: 100%; margin: 2px 0 0; padding: 2px 8px; }
.card > .issue { margin: 4px 0 0; }
.issue.error { color: #f08a8a; }
.issue.warn { color: #c9b06a; }
footer { padding: 4px 8px 6px; color: #8a8f99; border-top: 1px solid #2c3140; }
</style>
