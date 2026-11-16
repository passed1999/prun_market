<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { errorText } from "../../api/client";
import { categoryLabel, tickerStyle, useMaterialCategories } from "../../api/materials";
import * as buildings from "../../services/buildings";
import type { BuildingInputs } from "../../services/buildings";

const props = defineProps<{ month: string }>();

useMaterialCategories();

const inputs = ref<BuildingInputs | null>(null);
const error = ref("");
const busy = ref(false);
/** 百分数，界面上直接填 */
const efficiency = ref(100);
const topPlanets = ref(5);
const calibrate = ref(true);

const LEVEL_LABEL: Record<string, string> = {
  PIONEER: "拓荒者", SETTLER: "定居者", TECHNICIAN: "技工", ENGINEER: "工程师", SCIENTIST: "科学家",
};
const search = ref("");
const picked = ref("");

watch(() => props.month, load, { immediate: true });

async function load() {
  busy.value = true;
  error.value = "";
  try {
    inputs.value = await buildings.loadInputs(props.month || undefined);
  } catch (e) {
    inputs.value = null;
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

const report = computed(() => inputs.value && buildings.compute(inputs.value, {
  efficiency: efficiency.value / 100,
  topPlanets: topPlanets.value,
  calibrate: calibrate.value,
}));

const buildingRows = computed(() => {
  const term = search.value.trim().toUpperCase();
  return (report.value?.buildings ?? []).filter((b) =>
    !term || b.ticker.includes(term) || b.outputs.some((o) => o.ticker === term));
});

const totalCount = computed(() => (report.value?.buildings ?? []).reduce((s, b) => s + b.count, 0));
const totalArea = computed(() => (report.value?.buildings ?? []).reduce((s, b) => s + b.count * b.area, 0));

const detail = computed(() => report.value?.materials.find((m) => m.ticker === picked.value) ?? null);

watch(report, (value) => {
  if (value && !value.materials.some((m) => m.ticker === picked.value)) {
    picked.value = value.materials[0]?.ticker ?? "";
  }
}, { immediate: true });

function num(value: number, digits = 0): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : "—";
}
</script>

<template>
  <p v-if="error" class="err">{{ error }}</p>
  <p v-if="busy" class="dim">读取中…</p>

  <template v-if="report">
    <div class="bar">
      <label title="专家、COGC、工人满意度等叠加后的全服平均生产效率。填得越高，反推出的建筑越少">
        平均效率 <input v-model.number="efficiency" type="number" min="1" step="5" style="width:70px" /> %
      </label>
      <label title="采集建筑没有配方。每种资源的每种形态（固态 / 液态 / 气态）取全宇宙浓度最高的前几颗星球的平均浓度">
        采集取浓度前 <input v-model.number="topPlanets" type="number" min="1" max="50" step="1"
                           style="width:60px" /> 颗星球
      </label>
      <label title="采集建筑只雇拓荒者：用全服拓荒者总数减去配方建筑用掉的，把采集建筑的总量校准到这个余量上">
        <input v-model="calibrate" type="checkbox" /> 按拓荒者余量校准采集建筑
      </label>
      <span class="stat">合计约 <b>{{ num(totalCount) }}</b> 座生产建筑</span>
      <span class="stat">占地 <b>{{ num(totalArea) }}</b></span>
    </div>

    <div class="balance">
      <span class="dim" title="估出来的建筑要雇的人数 ÷ 由必需品消费反推的全服人数。接近 100% 说明平均效率填得自洽">
        用工 ÷ 人口
      </span>
      <span v-for="w in report.workforce" :key="w.level" class="stat"
            :title="`要雇 ${num(w.need)} / 人口 ${num(w.population)}`">
        {{ LEVEL_LABEL[w.level] ?? w.level }} <b>{{ pct(w.need, w.population) }}</b>
      </span>
      <span class="stat" :title="`拓荒者余量 ${num(report.extraction.available)}；按星球浓度直接算要 ${
        num(report.extraction.needed)}`">
        <template v-if="report.extraction.skipped === 'no-pioneers'">
          <b class="warn">配方建筑已经用光拓荒者，采集建筑没法校准（平均效率填低了）</b>
        </template>
        <template v-else>
          采集建筑按星球浓度需拓荒者 <b>{{ num(report.extraction.needed) }}</b>，
          余量 <b>{{ num(report.extraction.available) }}</b>
          <template v-if="!report.extraction.skipped">，座数 × <b>{{ report.extraction.scale.toFixed(2) }}</b></template>
        </template>
      </span>
    </div>

    <div class="cols">
      <section>
        <h3>建筑数量（由产量反推）</h3>
        <div class="bar">
          <label>筛选 <input v-model="search" placeholder="建筑或产出，如 FP / RAT" style="width:170px" /></label>
        </div>
        <div class="scroll">
          <table>
            <thead>
              <tr><th>建筑</th><th>估算座数</th><th>占地合计</th><th>主要产出（座）</th><th>口径</th></tr>
            </thead>
            <tbody>
              <tr v-for="b in buildingRows" :key="b.ticker">
                <td :title="b.name"><b>{{ b.ticker }}</b></td>
                <td>{{ num(b.count, b.count < 100 ? 1 : 0) }}</td>
                <td class="dim">{{ num(b.count * b.area) }}</td>
                <td class="outs">
                  <span v-for="o in b.outputs" :key="o.ticker" class="out"
                        :title="o.concentration ? `按浓度 ${(o.concentration * 100).toFixed(0)}% 折算` : ''">
                    <span class="tag" :style="tickerStyle(o.ticker)">{{ o.ticker }}</span>
                    <span class="dim">{{ num(o.count) }}</span>
                  </span>
                </td>
                <td>
                  <span class="conf" :class="b.kind === 'extract' ? 'partial' : b.approx ? 'approx' : 'exact'">
                    {{ b.kind === "extract" ? "采集" : b.approx ? "估算" : "配方" }}
                  </span>
                </td>
              </tr>
              <tr v-if="!buildingRows.length"><td colspan="5" class="dim">没有符合条件的建筑</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3>建材的月维修消耗</h3>
        <div class="scroll">
          <table>
            <thead>
              <tr><th>建材</th><th>月维修消耗</th><th>月产量</th><th>占产量</th><th>建筑种数</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in report.materials" :key="m.ticker" class="row"
                  :class="{ picked: picked === m.ticker }" @click="picked = m.ticker">
                <td>
                  <span class="tag" :style="tickerStyle(m.ticker)" :title="categoryLabel(m.category)">
                    {{ m.ticker }}</span>
                </td>
                <td>{{ num(m.monthly) }}</td>
                <td class="dim">{{ m.monthly_production ? num(m.monthly_production) : "—" }}</td>
                <td class="dim">{{ pct(m.monthly, m.monthly_production) }}</td>
                <td class="dim">{{ m.uses.length }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="detail">
          <h3 class="sub">
            <span class="tag" :style="tickerStyle(detail.ticker)">{{ detail.ticker }}</span>
            每月维修消耗 {{ num(detail.monthly) }}，来自 {{ detail.uses.length }} 种建筑
          </h3>
          <div class="scroll">
            <table>
              <thead>
                <tr><th>建筑</th><th>估算座数</th><th>单座用量</th><th>单座每日衰减</th><th>月消耗</th><th>占比</th></tr>
              </thead>
              <tbody>
                <tr v-for="u in detail.uses" :key="u.building">
                  <td><b>{{ u.building }}</b><span v-if="u.kind === 'extract'" class="dim"> 采集</span></td>
                  <td>{{ num(u.count, u.count < 100 ? 1 : 0) }}</td>
                  <td class="dim">{{ num(u.per_building) }}</td>
                  <td class="dim">{{ num(u.per_building / buildings.DEGRADE_DAYS, 3) }}</td>
                  <td>{{ num(u.monthly) }}</td>
                  <td class="dim">{{ pct(u.monthly, detail.monthly) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </div>

    <details class="notes">
      <summary>数据口径</summary>
      <ul>
        <li>
          <b>建筑数量</b> = Σ 该建筑每条配方全服每天跑的轮数 × 每轮耗时（天）÷ 平均效率。
          轮数由月报的全服日产量反推；同一种材料有多条配方产出时按等权拆分，标为「估算」。
        </li>
        <li>
          <b>月维修消耗</b> = 建筑数量 × 单座建造用量 ÷ {{ buildings.DEGRADE_DAYS }} × {{ buildings.MONTH_DAYS }}。
          建筑 {{ buildings.DEGRADE_DAYS }} 天折旧完，维修用量与距上次维修的天数成正比，
          所以不论多久修一次，摊到每天都是建造用量的 1/{{ buildings.DEGRADE_DAYS }}。
        </li>
        <li>
          <b>采集</b>：采集建筑（EXT / COL / RIG）没有配方。同一种资源在不同星球上是固态、液态或气态，
          对应不同建筑、浓度差得很远：每种形态取全宇宙浓度最高的前几颗星球的平均浓度
          （浓度 100% 时每座每天 EXT 70、COL 60、RIG 70），假定都去每个拓荒者产得最多的那种形态上采。
          把鼠标放在产出上可以看到折算用的浓度。
        </li>
        <li>
          <b>按拓荒者余量校准</b>：采集建筑只雇拓荒者。全服拓荒者总数（由必需品消费反推）减去配方建筑用掉的，
          就是采集建筑的用工；各资源之间的比例由星球浓度定，总量按这个余量等比例缩放。
          同一资源在各形态之间实际怎么分没有公开数据，这部分仍是假定。
        </li>
        <li>
          <b>用工 ÷ 人口</b>：定居者及以上不在采集建筑里干活，这几级接近 100% 说明平均效率填得自洽；
          明显低于 100% 说明效率填高了（建筑估少了），反之填低了。
        </li>
        <li>
          不含：住房、仓库、核心模块与星球设施（不折损、没人修，也无从由产量反推）；
          因星球而异的环境附加建材（MCG、SEA、INS 等）；新建与扩建的一次性消耗。
        </li>
      </ul>
    </details>
  </template>
</template>

<style scoped>
h3 { font-size: 14px; color: #9db4d0; margin: 0 0 8px; }
h3.sub { margin-top: 20px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.scroll { overflow-x: auto; }
.bar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.balance { display: flex; gap: 6px 16px; flex-wrap: wrap; margin-bottom: 14px; font-size: 12px; }
.warn { color: #e0a33e !important; }
.stat { color: #8a8f99; }
.stat b { color: #e2e2e2; }
table { width: 100%; font-size: 13px; }
th { text-align: left; color: #9db4d0; font-weight: normal; }
td { text-align: right; }
td:first-child, th:first-child { text-align: left; }
td.outs { text-align: left; }
.out { display: inline-flex; gap: 4px; align-items: center; margin-right: 10px; font-size: 12px; }
.row { cursor: pointer; }
.row:hover td { background: #232733; }
.row.picked td { background: #2c3140; }
.tag { display: inline-block; min-width: 42px; text-align: center; padding: 1px 6px;
       border-radius: 3px; font-size: 12px; font-weight: 600; }
.conf { font-size: 11px; padding: 1px 5px; border-radius: 3px; }
.conf.exact { color: #7fb37f; }
.conf.approx { color: #c9b06a; }
.conf.partial { color: #8a8f99; }
.notes { margin-top: 24px; color: #8a8f99; font-size: 12px; max-width: 860px; }
.notes summary { cursor: pointer; color: #9db4d0; }
.notes ul { margin: 6px 0; padding-left: 20px; }
.notes li { margin-bottom: 4px; }
.dim { color: #8a8f99; }
.err { color: #e66; }
label { display: inline-flex; gap: 6px; align-items: center; }
input { background: #23262e; color: #eee; border: 1px solid #444; padding: 3px 6px; }
</style>
