"""逐字段比对 out/py_*.json 与 out/ts_*.json。浮点容差 1e-9（相对）。"""
import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
IGNORE = {"overridden", "warnings"}   # Python 有、TS 刻意没有的字段


def diff(a, b, path, out):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in set(a) | set(b):
            if k in IGNORE:
                continue
            if k not in a or k not in b:
                out.append(f"{path}.{k}: only in {'py' if k in a else 'ts'}")
                continue
            diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: len {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        if not math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9):
            out.append(f"{path}: {a} vs {b}")
    elif a != b:
        out.append(f"{path}: {a!r} vs {b!r}")


total = 0
for py in sorted(OUT.glob("py_*.json")):
    name = py.name[3:-5]
    ts = OUT / f"ts_{name}.json"
    a = json.loads(py.read_text(encoding="utf-8"))
    b = json.loads(ts.read_text(encoding="utf-8"))
    out = []
    diff(a, b, name, out)
    size = len(a) if isinstance(a, list) else sum(len(v) if isinstance(v, list) else 1 for v in a.values())
    print(f"{name:14s} {'OK' if not out else f'{len(out)} diffs'}  (size {size})")
    for line in out[:8]:
        print("   ", line)
    total += len(out)
print("TOTAL diffs:", total)
