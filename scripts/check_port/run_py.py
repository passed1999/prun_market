"""用同一份 fixtures 跑原 prun_selfplanner 后端的三个服务，输出 out/py_*.json 供比对。

    SELFPLANNER=../prun_selfplanner python scripts/check_port/run_py.py
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
MONTH = os.environ.get("CHECK_MONTH", "sep26")
SELFPLANNER = Path(os.environ.get("SELFPLANNER", HERE / "../../../prun_selfplanner")).resolve()

os.environ["PSP_DB_PATH"] = str(Path(tempfile.mkdtemp()) / "check.db")
sys.path.insert(0, str(SELFPLANNER / "server"))

import httpx  # noqa: E402


class FakeResp:
    def __init__(self, path: Path):
        self.status_code = 200 if path.is_file() else 404
        self._path = path

    def json(self):
        return json.loads(self._path.read_text(encoding="utf-8"))

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("fixture missing", request=None, response=None)


async def fake_get(self, path, headers=None, **kw):
    url = (str(self.base_url).rstrip("/") + path) if str(self.base_url) else path
    if url.startswith("https://rest.fnar.net/"):
        f = FIX / "fio" / url[len("https://rest.fnar.net/"):]
    elif url == "https://api.prunplanner.org/data/exchanges/":
        f = FIX / "pp/data/exchanges/index.json"
    elif url.startswith("https://prun.raylu.net/stats/data/"):
        f = FIX / "stats" / url[len("https://prun.raylu.net/stats/data/"):]
    else:
        raise RuntimeError("unexpected " + url)
    return FakeResp(f)


httpx.AsyncClient.get = fake_get

from app import db  # noqa: E402
db.init_db()
from app.routers import settings as settings_router  # noqa: E402
settings_router.migrate()
from app.services import arbitrage, market, profit  # noqa: E402


def dump(name, model):
    data = [m.model_dump(mode="json") for m in model] if isinstance(model, list) else model.model_dump(mode="json")
    (OUT / f"py_{name}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


async def main():
    dump("snapshot", await market.snapshot(MONTH))
    dump("material_rat", await market.material("RAT", MONTH))
    dump("material_ins", await market.material("INS", MONTH))
    dump("companies", await market.top_companies(MONTH, 100))
    dump("arb_fio_bid", await arbitrage.opportunities("FIO", "bid"))
    dump("arb_fio_avg", await arbitrage.opportunities("FIO", "avg"))
    dump("arb_pp_bid", await arbitrage.opportunities("PRUNPLANNER", "bid"))
    dump("arb_pp_avg", await arbitrage.opportunities("PRUNPLANNER", "avg"))
    dump("book", await arbitrage.book("RAT", "NC1", "CI1"))
    dump("profit_rat", await profit.analyze("RAT", "NC1", "ASK", "NC1", "BID"))
    dump("profit_bse", await profit.analyze("BSE", "CI1", "AVG", "AI1", "UNIVERSE"))
    print("py done")


asyncio.run(main())
