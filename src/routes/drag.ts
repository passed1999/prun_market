/** 正在拖的东西。拖放过程中 dataTransfer 的内容读不到，所以另记一份。 */
import { reactive } from "vue";

export const drag = reactive<{
  step: { waypointId: string; stepId: string } | null;
  groupId: string | null;
}>({ step: null, groupId: null });

export function clearDrag() {
  drag.step = null;
  drag.groupId = null;
}
