// 材料分类配色。取自 PMMG 的 PrUn Financial Reports（MIT），与游戏内的分类底色一致。
// 分类名以 FIO /material/allmaterials 的 CategoryName 为准（全小写），两边 35 个分类一一对应。
import { ref } from "vue";

import { fio } from "../data/sources";

const CATEGORY_COLORS: Record<string, string> = {
  "agricultural products": "#0a4708",
  "alloys": "#946537",
  "chemicals": "#d04774",
  "construction materials": "#3174ec",
  "construction parts": "#426684",
  "construction prefabs": "#28377b",
  "consumable bundles": "#57232a",
  "consumables (basic)": "#ba363c",
  "consumables (luxury)": "#680000",
  "drones": "#a54d2b",
  "electronic devices": "#6f2dac",
  "electronic parts": "#7447d0",
  "electronic pieces": "#906bd6",
  "electronic systems": "#4c3365",
  "elements": "#564739",
  "energy systems": "#2e5740",
  "fuels": "#6ba23c",
  "gases": "#198284",
  "infrastructure": "#252551",
  "liquids": "#6098c3",
  "medical equipment": "#6ec36e",
  "metals": "#4f4f4f",
  "minerals": "#b28a62",
  "ores": "#6b707a",
  "plastics": "#791f62",
  "ship engines": "#b24219",
  "ship kits": "#b26d19",
  "ship parts": "#b27c19",
  "ship shields": "#d98c21",
  "software components": "#a19248",
  "software systems": "#554e1e",
  "software tools": "#9a7b2c",
  "textiles": "#6b733a",
  "unit prefabs": "#363435",
  "utility": "#baada1",
};

const FALLBACK = "#3a3f4b";

/** 分类底色。传未知分类或空串时给一个中性灰，不会抛错 */
export function categoryColor(category: string | undefined | null): string {
  return CATEGORY_COLORS[(category ?? "").toLowerCase()] ?? FALLBACK;
}

/** 底色上用黑字还是白字。按 sRGB 相对亮度取阈值，避免深色分类上出现灰字 */
export function categoryTextColor(category: string | undefined | null): string {
  const hex = categoryColor(category).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#16181d" : "#f0f0f0";
}

/** 分类名做展示：FIO 给的是全小写，首字母大写更像标题 */
export function categoryLabel(category: string | undefined | null): string {
  const raw = (category ?? "").trim();
  return raw ? raw.replace(/^./, (c) => c.toUpperCase()) : "未分类";
}

// ---- ticker → 分类 ----

const categories = ref<Record<string, string>>({});
let pending: Promise<void> | null = null;

/** ticker → 分类名。首次调用触发一次拉取，之后共用同一份；拉不到就保持空表，界面照常显示 */
export function useMaterialCategories() {
  if (!pending) {
    pending = fio.materials()
      .then((list) => {
        categories.value = Object.fromEntries(list.map((m) => [m.Ticker, m.CategoryName]));
      })
      .catch(() => { pending = null; });
  }
  return categories;
}

/** 给 ticker 直接上色，省得每处都查一遍分类表 */
export function tickerStyle(ticker: string): Record<string, string> {
  const category = categories.value[ticker];
  return { background: categoryColor(category), color: categoryTextColor(category) };
}
