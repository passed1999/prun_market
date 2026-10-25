/** 对数据服务（本站 /api/*，一层只做缓存的代理，见 worker/index.ts）的访问。 */

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 界面显示异常一律走这里，别把 "Error: 400 {...}" 这种原文摆给用户 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof DataError) return e.message;
  return "连接不上数据服务，请稍后重试。";
}

/** 计算层自己抛的、能直接摆到界面上的一句话 */
export class DataError extends Error {}

async function errorMessage(resp: Response): Promise<string> {
  const body = await resp.text().catch(() => "");
  try {
    const { error } = JSON.parse(body);
    if (typeof error === "string" && error) return error;
  } catch { /* 不是 JSON */ }
  return resp.status >= 500 ? "数据服务出错了，请稍后重试。" : "请求失败，请重试。";
}

// 冷缓存时 5.6MB 的行情要从上游拉一遍，90 秒够用
const TIMEOUT_MS = 90_000;

export async function getJson<T>(path: string, force = false): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(force ? `${path}?force=1` : path, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: force ? "reload" : "default",
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ApiError(0, "请求超时，请重试。");
    }
    throw new ApiError(0, "连接不上数据服务，请稍后重试。");
  }
  if (!resp.ok) throw new ApiError(resp.status, await errorMessage(resp));
  return resp.json();
}
