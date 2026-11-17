"""
把 extension/price-guard 打成可以发给别人的包，输出到 extension/dist/：

  prun-price-guard-<版本>.zip         发给别人用：解压后得到 price-guard 文件夹和安装说明
  prun-price-guard-<版本>-store.zip   manifest 在压缩包根目录：上传 Chrome 应用商店 / Edge 加载项 / Firefox AMO 签名用

用法：python scripts/pack_extension.py
"""
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension" / "price-guard"
OUT = ROOT / "extension" / "dist"
# 压缩包里的时间写死，同样的内容每次打出来的包逐字节相同
STAMP = (2026, 1, 1, 0, 0, 0)

INSTALL = """PrUn Price Guard {version}
======================

Prosperous Universe 的浏览器扩展：下买单时，限价比参考价（Refined PrUn Price）
高出设定的阈值就拦截并提醒。不依赖 Refined PrUn，两者同时装也可以。

安装
----

先把这个压缩包解压到一个固定的位置（装好之后不能删、不能挪）。

Chrome / Edge
  1. 地址栏打开 chrome://extensions （Edge 是 edge://extensions）
  2. 打开「开发者模式」
  3. 点「加载已解压的扩展程序」，选解压出来的 price-guard 文件夹
  4. 刷新游戏页面

Firefox（127 及以上）
  1. 地址栏打开 about:debugging#/runtime/this-firefox
  2. 点「临时载入附加组件」，选 price-guard 文件夹里的 manifest.json
  3. 刷新游戏页面
  这样装的扩展重启 Firefox 后会消失，需要重新载入。

使用
----

在游戏的 CXPO（下单）窗口点 BUY 时自动判断。超过阈值会拦下这次点击，
页面顶部弹出提醒；提醒上的「取消本次拦截」可以把这一笔照原样下出去。

设置：在游戏里新开一个窗口，输入

  XIT SET-PRICE-GUARD                                  打开设置面板
  XIT SET-PRICE-GUARD REL 20 UNIT 20 TOTAL 10000       一次设三项，写哪项改哪项
  XIT SET-PRICE-GUARD REL OFF                          数值换成 OFF 就是关掉那一项
  XIT SET-PRICE-GUARD REF UNIVERSE VWAP7D              参考价的交易所与算法
  XIT SET-PRICE-GUARD OFF / ON                         总开关

  REL    相对值：限价比参考价高出的百分比
  UNIT   单价绝对值：每件比参考价贵出的金额
  TOTAL  总价绝对值：整单比按参考价买多付的金额（贵出的单价 × 数量）

任何一项启用的阈值被超过就拦截。默认只开相对值 20%。

更新
----

用新版本的 price-guard 文件夹覆盖旧的，在扩展页面点这个扩展的「重新加载」，再刷新游戏页面。
设置保存在浏览器里，更新不会丢。
"""


def write(z: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, STAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    z.writestr(info, data)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    files = sorted(p for p in SRC.rglob("*") if p.is_file())

    # manifest 里引用的文件必须都在
    needed = set(manifest["background"]["scripts"]) | {manifest["background"]["service_worker"]}
    for cs in manifest["content_scripts"]:
        needed |= set(cs.get("js", [])) | set(cs.get("css", []))
    missing = sorted(n for n in needed if not (SRC / n).is_file())
    if missing:
        print("manifest 里引用了不存在的文件：" + ", ".join(missing), file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    base = f"prun-price-guard-{version}"

    share = OUT / f"{base}.zip"
    with zipfile.ZipFile(share, "w") as z:
        write(z, "安装说明.txt", INSTALL.format(version=version).replace("\n", "\r\n").encode("utf-8-sig"))
        for p in files:
            write(z, "price-guard/" + p.relative_to(SRC).as_posix(), p.read_bytes())

    store = OUT / f"{base}-store.zip"
    with zipfile.ZipFile(store, "w") as z:
        for p in files:
            write(z, p.relative_to(SRC).as_posix(), p.read_bytes())

    for p in (share, store):
        print(f"{p.relative_to(ROOT).as_posix()}  {p.stat().st_size} 字节")
    return 0


if __name__ == "__main__":
    sys.exit(main())
