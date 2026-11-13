<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { searchPlaces, useCatalog } from "../../routes/catalog";
import type { Destination } from "../../routes/model";
import { destinationLabel } from "../../routes/model";

/** 目的地：输入星球编号 / 名字 / 空间站，从候选里挑；候选没有的也可以直接填编号 */
const props = defineProps<{ modelValue: Destination }>();
const emit = defineEmits<{ "update:modelValue": [value: Destination] }>();

const { places } = useCatalog();
const text = ref("");
const open = ref(false);
const cursor = ref(0);

const shown = () => (props.modelValue.naturalId ? destinationLabel(props.modelValue) : "");
watch(() => props.modelValue, () => { if (!open.value) text.value = shown(); }, { immediate: true, deep: true });

const matches = computed(() => (open.value ? searchPlaces(places.value, text.value) : []));
watch(matches, () => { cursor.value = 0; });

function pick(d: Destination) {
  emit("update:modelValue", { naturalId: d.naturalId, name: d.name });
  open.value = false;
  text.value = destinationLabel(d);
}

function commit() {
  if (!open.value) return;
  const typed = text.value.trim();
  if (matches.value.length) pick(matches.value[cursor.value] ?? matches.value[0]);
  else if (typed && typed !== shown()) pick({ naturalId: typed.toUpperCase(), name: "" });
  else { open.value = false; text.value = shown(); }
}

function onFocus(e: FocusEvent) {
  open.value = true;
  (e.target as HTMLInputElement).select();
}
function move(delta: number) {
  if (!matches.value.length) return;
  cursor.value = (cursor.value + delta + matches.value.length) % matches.value.length;
}
</script>

<template>
  <span class="loc">
    <input v-model="text" type="text" placeholder="目的地：编号或名字" spellcheck="false"
           @focus="onFocus" @input="open = true" @blur="commit"
           @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
           @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)"
           @keydown.esc="open = false; text = shown()" />
    <ul v-if="open && matches.length" class="menu">
      <li v-for="(p, i) in matches" :key="p.naturalId" :class="{ on: i === cursor }"
          @mousedown.prevent="pick(p)" @mouseenter="cursor = i">
        <span>{{ destinationLabel(p) }}</span>
        <span class="hint">{{ p.hint }}</span>
      </li>
    </ul>
  </span>
</template>

<style scoped>
.loc { position: relative; flex: 1; min-width: 0; display: flex; }
input { flex: 1; min-width: 0; background: #23262e; color: #fff; border: 1px solid #444; padding: 3px 6px;
        font-size: 13px; font-weight: 600; }
.menu { position: absolute; z-index: 30; top: 100%; left: 0; right: 0; margin: 0; padding: 0; list-style: none;
        background: #1b1e25; border: 1px solid #555; box-shadow: 0 6px 16px #000a; }
.menu li { display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px; font-size: 12px; cursor: pointer; }
.menu li.on { background: #2c3140; }
.hint { color: #8a8f99; white-space: nowrap; }
</style>
