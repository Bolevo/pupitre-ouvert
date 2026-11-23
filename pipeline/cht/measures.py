"""measures.tsv: the per-page measure table shared by parallel transcribers.

Columns (tab-separated, one row per printed page, '#' lines are comments):
    page  movement  systems  count  first  last  note
`systems` = measures per system, e.g. "9,10,10,9,10" (counted on the page);
`first`/`last` = movement measure numbers of the page's first/last measure.
Numbering: every barline-delimited segment is one measure, numbered from 1
in each movement (a leading pickup would be 0). Pages without music: count 0.

A page holding the end of one movement and the start of the next has one row
per movement, in system order (same `page`, its own `systems`): the second
row's systems follow the first row's on the page. Each such part is
transcribed in its own file (009a.cht = movement 1, 009b.cht = movement 2).

    python pipeline/cht/measures.py init scores/<work>
writes a first work/measures.tsv from what tools/omr/pages.py detected (work/img/pNNN.json):
one row per page, every page in movement 1. The detection is a first guess (a stem can be taken
for a barline, a faint barline missed): correct the counts and the movements against the
overlays, then

    python pipeline/cht/measures.py renumber scores/<work>
recomputes count/first/last from `systems` (after editing the counts; a movement that starts
with a pickup: set its first page's `first` to 0 before, the pickup is kept).
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

HEADER = ["page", "movement", "systems", "count", "first", "last", "note"]


@dataclass
class PageRow:
    page: int
    movement: int
    systems: list[int]
    first: int
    note: str = ""
    sys0: int = 1          # page system number of this row's first system

    @property
    def count(self) -> int:
        return sum(self.systems)

    @property
    def last(self) -> int:
        return self.first + self.count - 1


class MeasureTable(dict):
    """{page: PageRow} (the page's FIRST row, for single-movement callers)
    plus every row of pages shared by two movements: rows(page), row(page, mvt)."""

    def __init__(self):
        super().__init__()
        self._rows: dict[int, list[PageRow]] = {}

    def add(self, r: PageRow) -> None:
        lst = self._rows.setdefault(r.page, [])
        r.sys0 = 1 + sum(len(x.systems) for x in lst)
        lst.append(r)
        self.setdefault(r.page, r)

    def rows(self, page: int) -> list[PageRow]:
        if page in self._rows:
            return list(self._rows[page])
        return [self[page]] if page in self else []

    def row(self, page: int, movement: int | None = None) -> PageRow | None:
        rs = self.rows(page)
        if movement is None:
            return rs[0] if rs else None
        return next((r for r in rs if r.movement == movement), None)

    def all_rows(self) -> list[PageRow]:
        return [r for p in sorted(self) for r in self.rows(p)]


def all_rows(rows) -> list[PageRow]:
    return rows.all_rows() if isinstance(rows, MeasureTable) else [rows[p] for p in sorted(rows)]


def load_measures(path: Path) -> MeasureTable:
    rows = MeasureTable()
    path = Path(path)
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#") or line.startswith("page\t"):
            continue
        f = line.split("\t")
        f += [""] * (len(HEADER) - len(f))
        systems = [int(x) for x in f[2].split(",") if x.strip()]
        rows.add(PageRow(int(f[0]), int(f[1]), systems, int(f[4] or 1), f[6]))
    return rows


def renumber(rows, pickups: dict[int, bool] | None = None) -> None:
    """Recompute `first` of every page from the counts, movement by movement."""
    nxt: dict[int, int] = {}
    for r in all_rows(rows):
        if r.movement not in nxt:
            nxt[r.movement] = 0 if (pickups or {}).get(r.movement) else 1
        r.first = nxt[r.movement]
        nxt[r.movement] += r.count


def save_measures(path: Path, rows, comments: list[str] = ()) -> None:
    lines = list(comments) + ["\t".join(HEADER)]
    for r in all_rows(rows):
        lines.append("\t".join(map(str, [r.page, r.movement, ",".join(map(str, r.systems)),
                                         r.count, r.first, r.last, r.note])))
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def init(work: Path, force: bool = False) -> Path:
    """A first measures.tsv from the detected layouts (work/img/pNNN.json)."""
    import json
    path = work / "measures.tsv"
    if path.exists() and not force:
        raise SystemExit(f"{path} exists (init --force to replace it)")
    rows = MeasureTable()
    for js in sorted((work / "img").glob("p[0-9][0-9][0-9].json")):
        d = json.loads(js.read_text())
        rows.add(PageRow(int(d["page"]), 1, [int(c) for c in d["measures"]], 1, "detected: check against the overlay"))
    if not rows:
        raise SystemExit(f"no work/img/pNNN.json in {work}: run tools/omr/pages.py first")
    renumber(rows)
    save_measures(path, rows, ["# measures per system, counted on the page (docs/TRANSCRIBE.md)"])
    return path


def main(argv: list[str]) -> int:
    force = "--force" in argv
    argv = [a for a in argv if a != "--force"]
    if len(argv) != 2 or argv[0] not in ("renumber", "init"):
        print(__doc__)
        return 2
    path = Path(argv[1])
    work = path / "work" if (path / "work.yaml").exists() else path
    if argv[0] == "init":
        print(f"wrote {init(work, force)}")
        return 0
    if path.is_dir():
        path = work / "measures.tsv"
    comments = [l for l in path.read_text(encoding="utf-8").splitlines() if l.startswith("#")]
    rows = load_measures(path)
    pickups: dict[int, bool] = {}
    for r in rows.all_rows():
        pickups.setdefault(r.movement, r.first == 0)   # the movement's first page says it
    renumber(rows, pickups)
    save_measures(path, rows, comments)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
