# PrUn Market

Prosperous Universe 的三个公开数据工具，可部署在 Cloudflare Workers 免费档：

- **全服市场**：每月全服产量 / 推算消耗 / 净流 / 生产商集中度
- **套利**：AI1 / CI1 / IC1 / NC1 之间的价差，按挂单簿逐档算可套利数量与利润
- **面积利润**：选一种材料，比较所有产出它的配方的每面积日利润与回本天数，可调价反推
- **路线编辑**：像画流程图一样配置游戏里的 Route（waypoint 与装货 / 卸货 / 加油 / 等待 / 运单步骤），
  可引用材料组与别的 waypoint 的装卸内容，导出时展开成逐材料的步骤交给游戏内脚本

从 [prun_selfplanner](../prun_selfplanner) 剥离而来，算法与原后端逐字段对账一致（见 `scripts/check_port/`）。

## 结构

```
worker/index.ts      唯一的服务端代码：白名单代理 + KV 共享缓存（不做计算）
src/data/sources.ts  三个数据源的取数与瘦身（FIO / PRUNplanner 公开行情 / PrUn Financial Reports）
src/services/        全部计算（market / arbitrage / profit / prices），在浏览器里跑
src/routes/          路线编辑器：数据模型、展开与检查（compile.ts）、文件读写；不依赖服务端
src/views/           四个页面
public/prun-route-loader.user.js  游戏内的用户脚本：读入导出的路线，在 RT 界面上每点一下执行一步
```

所有计算放在浏览器里，是因为免费档 Worker 每次请求只有 10ms CPU，解析 5.6MB 的行情就会超。
Worker 只负责转发、缓存与白名单，所有访客共用一份上游数据，上游挂了时用过期副本顶上。

## 本地运行

```bash
npm install
npm run dev
```

打开 http://127.0.0.1:5173 。`/api/*` 由同一套 Worker 代码在本地 workerd 里处理，KV 用本地模拟。

## 部署到 Cloudflare

1. 登录：`npx wrangler login`
2. 建缓存空间：`npx wrangler kv namespace create CACHE`，把输出的 `id` 填进 `wrangler.jsonc` 的 `kv_namespaces`
3. 部署：`npm run deploy`

之后每次 `npm run deploy` 即更新。也可以在 Cloudflare 控制台的 Workers → Create → 连接 Git 仓库，
构建命令 `npm run build`、部署命令 `npx wrangler deploy`，push 即部署。

没有 KV 绑定也能跑，只是每个访客的每次请求都会打到上游；公开部署请务必绑上。

## 数据源

| 来源 | 内容 | 缓存 |
|---|---|---|
| [FIO](https://doc.fnar.net/) `rest.fnar.net` | 材料 / 建筑 / 配方 / 工人需求；行情与挂单簿 | 静态 24h，行情 15min |
| [PRUNplanner](https://prunplanner.org/) `/data/exchanges/` | 7 日 / 30 日成交额加权均价、日成交量 | 15min |
| [PrUn Financial Reports](https://prun.raylu.net/stats/)（PMMG，MIT） | 月度全服产量与公司榜 | 24h |

与原项目的刻意差异：

- 7 日 / 30 日均价取 PRUNplanner 的 `vwap_7d` / `vwap_30d`（原项目从 FIO 日线自算，二者差约 0.4%），省掉每种材料一次的日线请求
- 面积利润的买卖口径记在浏览器 localStorage 里，没有交易所方案与自定义材料价
