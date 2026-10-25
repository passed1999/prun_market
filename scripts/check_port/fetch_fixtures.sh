#!/usr/bin/env bash
# 把三个数据源的原始响应抓到 fixtures/，供 run_ts.mjs 与 run_py.py 用同一份数据对账。
set -e
cd "$(dirname "$0")"
F=fixtures
mkdir -p $F/fio/material $F/fio/building $F/fio/recipes $F/fio/global $F/fio/exchange $F/pp/data/exchanges $F/stats
curl -s -o $F/fio/material/allmaterials https://rest.fnar.net/material/allmaterials &
curl -s -o $F/fio/building/allbuildings https://rest.fnar.net/building/allbuildings &
curl -s -o $F/fio/recipes/allrecipes https://rest.fnar.net/recipes/allrecipes &
curl -s -o $F/fio/global/workforceneeds https://rest.fnar.net/global/workforceneeds &
curl -s -o $F/fio/exchange/all https://rest.fnar.net/exchange/all &
curl -s -o $F/fio/exchange/full https://rest.fnar.net/exchange/full &
curl -s -o $F/pp/data/exchanges/index.json https://api.prunplanner.org/data/exchanges/ &
curl -s -o $F/stats/knownCompanies.json https://prun.raylu.net/stats/data/knownCompanies.json &
curl -s -o $F/stats/universe-data.json https://prun.raylu.net/stats/data/universe-data.json
wait
MONTH=${CHECK_MONTH:-sep26}
for m in $(python -c "import json;print(' '.join(json.load(open('$F/stats/universe-data.json'))))"); do
  curl -s -o $F/stats/prod-data-$m.json https://prun.raylu.net/stats/data/prod-data-$m.json &
done
curl -s -o $F/stats/company-data-$MONTH.json https://prun.raylu.net/stats/data/company-data-$MONTH.json &
wait
echo "fixtures ready ($MONTH)"
