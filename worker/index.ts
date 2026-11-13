/**
 * 唯一的服务端代码：把三个公开数据源代理给前端，并在 KV 里共享缓存。
 *
 * 不做任何计算——免费档 Worker 每次请求只有 10ms CPU，解析 5.6MB 的行情就会超；
 * 所有推算都在浏览器里跑（src/services/*）。这里只负责：
 *   1. 白名单：只允许列出的路径，避免变成开放代理
 *   2. 缓存：同一份上游响应所有访客共用（KV 没绑定时退回每次都取）
 *   3. 上游出错时用过期副本顶上（stale-if-error）
 *
 * 路由：GET /api/<source>/<path>?force=1
 *   fio   → https://rest.fnar.net/<path>
 *   pp    → https://api.prunplanner.org/<path>
 *   stats → https://prun.raylu.net/stats/data/<path>
 */
export interface Env {
  CACHE?: KVNamespace;
}

interface Source {
  base: string;
  /** 允许的路径（正则）→ 缓存秒数 */
  rules: [RegExp, number][];
}

const HOUR = 3600;
const STATIC = 24 * HOUR;       // 材料 / 建筑 / 配方：游戏版本更新才会变
const PRICES = 15 * 60;         // 行情
const MONTHLY = 24 * HOUR;      // 月报：次月初才更新

const SOURCES: Record<string, Source> = {
  fio: {
    base: "https://rest.fnar.net",
    rules: [
      [/^\/material\/allmaterials$/, STATIC],
      [/^\/building\/allbuildings$/, STATIC],
      [/^\/recipes\/allrecipes$/, STATIC],
      [/^\/global\/workforceneeds$/, STATIC],
      [/^\/planet\/allplanets$/, STATIC],
      [/^\/exchange\/station$/, STATIC],
      [/^\/planet\/[A-Z]{2}-\d{3}[a-z]$/, STATIC],
      [/^\/systemstars\/star\/[A-Z]{2}-\d{3}$/, STATIC],
      [/^\/systemstars\/jumproute\/[A-Z]{2}-\d{3}\/[A-Z]{2}-\d{3}$/, STATIC],
      [/^\/exchange\/all$/, PRICES],
      [/^\/exchange\/full$/, PRICES],
    ],
  },
  pp: {
    base: "https://api.prunplanner.org",
    rules: [[/^\/data\/exchanges\/$/, PRICES]],
  },
  stats: {
    base: "https://prun.raylu.net/stats/data",
    rules: [
      [/^\/universe-data\.json$/, MONTHLY],
      [/^\/prod-data-[a-z]{3}\d{2}\.json$/, MONTHLY],
      [/^\/company-data-[a-z]{3}\d{2}\.json$/, MONTHLY],
      [/^\/knownCompanies\.json$/, MONTHLY],
    ],
  },
};

const FORCE_MIN_AGE = 60;       // 「刷新」最多每分钟真的打一次上游
const STALE_KEEP = 7 * 24 * HOUR;   // 过期副本在 KV 里再留一周，上游挂了时顶上

interface Meta { fetched_at: number; status: number }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function resolve(url: URL): { upstream: string; key: string; ttl: number } | null {
  const m = url.pathname.match(/^\/api\/(fio|pp|stats)(\/.*)$/);
  if (!m) return null;
  const source = SOURCES[m[1]];
  const path = m[2];
  const rule = source.rules.find(([re]) => re.test(path));
  if (!rule) return null;
  return { upstream: source.base + path, key: `${m[1]}:${path}`, ttl: rule[1] };
}

async function fetchUpstream(upstream: string): Promise<{ status: number; body: ArrayBuffer }> {
  const resp = await fetch(upstream, {
    headers: { accept: "application/json", "user-agent": "prun-market (cloudflare worker)" },
    signal: AbortSignal.timeout(50_000),
  });
  return { status: resp.status, body: await resp.arrayBuffer() };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (request.method !== "GET") return json(405, { error: "只支持 GET。" });
    const target = resolve(url);
    if (!target) return json(404, { error: "没有这个数据接口。" });

    const { upstream, key, ttl } = target;
    const force = url.searchParams.get("force") === "1";
    const now = Date.now() / 1000;
    const kv = env.CACHE;

    let stale: { body: ArrayBuffer; meta: Meta } | null = null;
    if (kv) {
      const cached = await kv.getWithMetadata<Meta>(key, "arrayBuffer");
      if (cached.value && cached.metadata) {
        const age = now - cached.metadata.fetched_at;
        const fresh = age < ttl && (!force || age < FORCE_MIN_AGE);
        if (fresh) return serve(cached.value, cached.metadata, ttl - age, "HIT");
        stale = { body: cached.value, meta: cached.metadata };
      }
    }

    let fetched: { status: number; body: ArrayBuffer };
    try {
      fetched = await fetchUpstream(upstream);
    } catch {
      if (stale) return serve(stale.body, stale.meta, 0, "STALE");
      return json(502, { error: "数据源暂时连不上，请稍后重试。" });
    }
    if (fetched.status === 404) return json(404, { error: "数据源里没有这一项。" });
    if (fetched.status >= 400) {
      if (stale) return serve(stale.body, stale.meta, 0, "STALE");
      return json(502, { error: "数据源返回了错误，请稍后重试。" });
    }

    const meta: Meta = { fetched_at: now, status: fetched.status };
    if (kv) {
      ctx.waitUntil(kv.put(key, fetched.body, { metadata: meta, expirationTtl: ttl + STALE_KEEP }));
    }
    return serve(fetched.body, meta, ttl, "MISS");
  },
} satisfies ExportedHandler<Env>;

function serve(body: ArrayBuffer, meta: Meta, maxAge: number, cache: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${Math.max(0, Math.floor(maxAge))}`,
      "x-cache": cache,
      "x-fetched-at": new Date(meta.fetched_at * 1000).toISOString(),
    },
  });
}
