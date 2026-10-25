# 移植对账

把同一份上游原始数据分别喂给原 prun_selfplanner 的 Python 后端与这里的 TypeScript 计算层，逐字段比对。

```bash
bash scripts/check_port/fetch_fixtures.sh                 # 抓当前上游数据（约 13MB）
node scripts/check_port/run_ts.mjs                        # 跑 src/services → out/ts_*.json
SELFPLANNER=../prun_selfplanner python scripts/check_port/run_py.py   # 跑原后端 → out/py_*.json
python scripts/check_port/compare.py
```

比对 11 组输出：市场总表、两种材料详情、公司榜、四种套利组合、挂单簿、两种口径的面积利润。
浮点容差相对 1e-9。2026-10-25 的结果：**全部零差异**。

`CHECK_MONTH` 环境变量选月份（默认 sep26；company-data 只抓这一个月）。
面积利润刻意不比 PP7D / PP30D：那两个口径的来源不同（见根目录 README）。
`fixtures/` 与 `out/` 不进 git。
