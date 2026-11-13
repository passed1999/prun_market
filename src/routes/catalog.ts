/** 编辑器要查的两份公开数据：材料的重量体积、可选的目的地。拿不到时界面照常能用（手填）。 */
import { ref } from "vue";

import { fio } from "../data/sources";
import type { MaterialInfo } from "./compile";
import type { Destination } from "./model";

export interface Place extends Destination { hint: string; search: string }

const materials = ref<Record<string, MaterialInfo>>({});
const places = ref<Place[]>([]);
let started = false;

export function useCatalog() {
  if (!started) {
    started = true;
    fio.materials()
      .then((list) => {
        materials.value = Object.fromEntries(list.map((m) => [m.Ticker, { weight: m.Weight, volume: m.Volume }]));
      })
      .catch(() => { /* 没有重量体积就不做容量检查 */ });
    Promise.all([fio.stations(), fio.planets()])
      .then(([stations, planets]) => {
        const out: Place[] = stations.map((s) => ({
          naturalId: s.NaturalId, name: s.Name, hint: `${s.ComexCode} · ${s.SystemName}`,
          search: `${s.NaturalId} ${s.Name} ${s.ComexCode} ${s.SystemName}`.toLowerCase(),
        }));
        for (const p of planets) {
          out.push({
            naturalId: p.PlanetNaturalId, name: p.PlanetName, hint: "",
            search: `${p.PlanetNaturalId} ${p.PlanetName}`.toLowerCase(),
          });
        }
        places.value = out;
      })
      .catch(() => { /* 没有候选就手填编号 */ });
  }
  return { materials, places };
}

/** 有名字的排前面，编号或名字开头命中的排前面 */
export function searchPlaces(list: Place[], query: string, limit = 8): Place[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: [number, Place][] = [];
  for (const p of list) {
    const at = p.search.indexOf(q);
    if (at < 0) continue;
    const id = p.naturalId.toLowerCase();
    const name = p.name.toLowerCase();
    let score = at;
    if (id === q || name === q) score -= 1000;
    else if (id.startsWith(q) || name.startsWith(q)) score -= 500;
    if (p.name !== p.naturalId) score -= 100;
    scored.push([score, p]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, p]) => p);
}
