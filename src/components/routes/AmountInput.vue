<script setup lang="ts">
import type { Amount } from "../../routes/model";

/** 一个「数量 或 capacity」的输入：数字框 + 一个切换钮 */
const props = defineProps<{ modelValue: Amount; capLabel: string; title?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: Amount] }>();

function setUnits(e: Event) {
  const n = Math.round(Number((e.target as HTMLInputElement).value));
  emit("update:modelValue", { type: "ABSOLUTE", units: Number.isFinite(n) && n >= 0 ? n : 0 });
}
function toggle() {
  emit("update:modelValue", props.modelValue.type === "CAPACITY"
    ? { type: "ABSOLUTE", units: props.modelValue.units || 1 }
    : { type: "CAPACITY", units: props.modelValue.units });
}
</script>

<template>
  <span class="amount" :title="title">
    <input v-if="modelValue.type === 'ABSOLUTE'" type="number" min="0" step="1"
           :value="modelValue.units" @change="setUnits" />
    <span v-else class="cap">{{ capLabel }}</span>
    <button type="button" class="flip" :class="{ on: modelValue.type === 'CAPACITY' }"
            :title="modelValue.type === 'CAPACITY' ? '改成填具体数量' : `改成「${capLabel}」`"
            @click="toggle">∞</button>
  </span>
</template>

<style scoped>
.amount { display: inline-flex; align-items: stretch; }
input { width: 62px; text-align: right; background: #23262e; color: #eee; border: 1px solid #444;
        border-right: 0; padding: 2px 4px; font-size: 12px; }
.cap { width: 62px; text-align: center; background: #2b2a20; color: #c9b06a; border: 1px solid #444;
       border-right: 0; padding: 2px 4px; font-size: 12px; white-space: nowrap; }
.flip { background: #23262e; color: #8a8f99; border: 1px solid #444; padding: 0 5px; cursor: pointer; font-size: 12px; }
.flip.on { color: #c9b06a; }
</style>
