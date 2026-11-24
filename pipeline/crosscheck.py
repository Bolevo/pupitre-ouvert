"""Cross-check the voices against the keyboard of a built work.

    python pipeline/crosscheck.py <work>            # reads scores/<work>/pack/pack.json
    python pipeline/crosscheck.py packs/<work>.zip

A keyboard reduction usually doubles the choir. Every sung note whose pitch (any octave) the
keyboard does not sound while it lasts is listed, with its measure and beat: a place to read
again on the page, in the voice and in the keyboard — one of the two may be wrong, or the
edition simply does not double there. A work without keyboard has nothing to compare.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAMES = "c c# d d# e f f# g g# a a# b".split()


def name(midi: int) -> str:
    return f"{NAMES[midi % 12]}{midi // 12 - 1}"


def load(arg: str) -> dict:
    p = Path(arg)
    if p.suffix == ".zip":
        with zipfile.ZipFile(p) as z:
            inner = next(n for n in z.namelist() if n.endswith("pack.json"))
            return json.loads(z.read(inner))
    if p.name == "pack.json":
        return json.loads(p.read_text(encoding="utf-8"))
    f = ROOT / "scores" / p.name / "pack" / "pack.json"
    if not f.exists():
        raise SystemExit(f"{p.name}: no built archive yet (scores/{p.name}/pack/): run  python pipeline/publish.py {p.name}  first")
    return json.loads(f.read_text(encoding="utf-8"))


def misses(mv: dict) -> tuple[list[str], int]:
    """-> (one line per sung note the keyboard does not double, number of sung notes compared)."""
    accomp = {p["id"] for p in mv["parts"] if p["kind"] == "accomp"}
    keys = sorted((n for n in mv["notes"] if n["part"] in accomp), key=lambda n: n["t"])
    ms = mv["measures"]
    out, seen = [], 0
    for n in sorted((n for n in mv["notes"] if n["part"] not in accomp), key=lambda n: (n["t"], n["part"])):
        t0, t1 = n["t"], n["t"] + n["d"]
        under = [q for q in keys if q["t"] < t1 - 5 and q["t"] + q["d"] > t0 + 5]
        if not under:
            continue                                  # the keyboard is silent: nothing to compare
        seen += 1
        if n["midi"] % 12 in {q["midi"] % 12 for q in under}:
            continue
        m = ms[n["m"]]
        nxt = ms[n["m"] + 1] if n["m"] + 1 < len(ms) else None
        per_q = (nxt["t"] - m["t"]) / (nxt["q"] - m["q"]) if nxt and nxt["q"] > m["q"] else 500.0
        beat = (n["t"] - m["t"]) / per_q * m["ts"][1] / 4 + 1
        out.append(f"  m{m['n']:>3} beat {beat:4.2f}  {n['part']:<3} {name(n['midi']):<4}  keyboard: "
                   f"{' '.join(name(v) for v in sorted({q['midi'] for q in under}))}")
    return out, seen


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0].startswith("-"):
        print(__doc__)
        return 0 if args[:1] in (["-h"], ["--help"]) else 2
    pack = load(args[0])
    for mv in pack["movements"]:
        lines, seen = misses(mv)
        if not seen:
            print(f"{mv['id']}: no keyboard under the voices, nothing to compare")
            continue
        print(f"{mv['id']}: {len(lines)} of {seen} sung notes are not doubled by the keyboard")
        print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
