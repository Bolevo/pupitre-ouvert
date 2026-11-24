"""Work folder helpers shared by tools/omr and pipeline/cht.

A score folder `scores/<work>/` holds `work.yaml` and a work folder `work/`:

    work/source/NNNN.png   the page images, in reading order (tools/source.py writes them from
                           the PDF or the photos)
    work/pages.tsv         image -> printed page, and what is special about a page:

        image     page  staves     solo  note
        0003.png  4     6,2,2,2          1. Gloria (first page has no printed number)
        0015.png  16    2,2,3,4,4  S,A   3. Laudamus: Soprano I = S, Soprano II = A

`staves` (optional): staves per system, top to bottom; when the detected grouping differs but
the total agrees, the staves are regrouped this way.
`solo` (optional): the names of the staves of this page's systems when they are not those of the
work (see staff_names). The work's own are `staves` in work.yaml (default S A T B + piano).
"""
from __future__ import annotations

import re
from pathlib import Path

CHOIR6 = ["S", "A", "T", "B", "PR", "PL"]
# clef family of each staff, for the pitch gutter of crops
ROLE_OF = {"S": "treble", "A": "treble", "T": "tenor", "B": "bass", "PR": "treble", "PL": "bass"}
IMAGE = re.compile(r"^(\d+)\.(jpe?g|png|webp|tiff?)$", re.I)


def work_folder(path: Path) -> Path:
    """`scores/<work>` or `scores/<work>/work` -> the work folder."""
    path = Path(path)
    return path / "work" if (path / "work.yaml").exists() or (path / "work").is_dir() else path


def load_pages_tsv(work: Path) -> dict[int, dict]:
    """{printed page: {image, staves: [n per system], solo: [voices], note}} from work/pages.tsv."""
    path = Path(work) / "pages.tsv"
    res: dict[int, dict] = {}
    if not path.exists():
        return res
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#") or line.startswith("image\t"):
            continue
        f = line.split("\t") + ["", "", "", ""]
        staves = [int(v) for v in f[2].split(",") if v.strip()]
        solo = [v.strip() for v in f[3].split(",") if v.strip()]
        res[int(f[1])] = {"image": f[0].strip(), "staves": staves, "solo": solo, "note": f[4].strip()}
    return res


def work_staves(work: Path) -> list[str] | None:
    """`staves` of scores/<work>/work.yaml: the staves of a system of this work, top to bottom,
    e.g. [S, A, T, B] (a cappella), [S, A] (two voices and piano), [S, PR, PL]."""
    cfg = Path(work).parent / "work.yaml"
    if not cfg.exists():
        return None
    import yaml
    v = (yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}).get("staves")
    if isinstance(v, str):
        v = [x.strip() for x in v.replace(",", " ").split()]
    return [str(x) for x in v] if v else None


def system_sizes(work: Path) -> list[int] | None:
    """How many staves a system of this work can have, from `staves` of work.yaml: its length,
    and two more when it names the voices only (the keyboard then stands under them)."""
    staves = work_staves(work)
    if not staves:
        return None
    return [len(staves)] if {"PR", "PL"} & set(staves) else [len(staves), len(staves) + 2]


def solo_voices(work: Path, page: int) -> list[str]:
    """The staff names to use on this page: its `solo` column, else the work's `staves`."""
    return load_pages_tsv(work).get(page, {}).get("solo") or work_staves(work) or ["S", "A", "T", "B"]


def staves_per_system(work: Path, page: int) -> list[int]:
    return load_pages_tsv(work).get(page, {}).get("staves") or []


def staff_names(n: int, solo: list[str] | None = None) -> list[str]:
    """Name of each staff of a system with n staves (top to bottom).
    `solo` names exactly n staves: those names (any layout: S A T B a cappella, S PR PL…).
    Otherwise: 6 staves = S A T B PR PL, 2 = PR PL (the piano alone), 3-5 = the first vocal
    names of `solo` (default S A T B) then PR PL."""
    if solo and len(solo) == n:
        return list(solo)
    if n == 6:
        return list(CHOIR6)
    if n == 2:
        return ["PR", "PL"]
    if n == 4 and not solo:
        return ["S", "A", "T", "B"]
    if 3 <= n <= 5:
        voc = [v for v in (solo or ["S", "A", "T", "B"]) if v not in ("PR", "PL")][: n - 2]
        voc += [f"st{i + 1}" for i in range(len(voc), n - 2)]
        return voc + ["PR", "PL"]
    return [f"st{i + 1}" for i in range(n)]


def page_images(work: Path, images: Path | None = None, offset: int | None = None) -> dict[int, Path]:
    """{printed page: image file}, from `images` (default work/source): the mapping of
    work/pages.tsv if there is one, else printed page = image number + offset (default 0)."""
    work = Path(work)
    images = Path(images) if images is not None else work / "source"
    if not images.is_dir():
        raise SystemExit(f"no page images in {images}: run tools/source.py first (or give --images DIR)")
    table = load_pages_tsv(work)
    if table and offset is None:
        return {p: images / d["image"] for p, d in table.items() if (images / d["image"]).exists()}
    res = {}
    for f in sorted(images.iterdir()):
        m = IMAGE.match(f.name)
        if m:
            res[int(m.group(1)) + (offset or 0)] = f
    return res
