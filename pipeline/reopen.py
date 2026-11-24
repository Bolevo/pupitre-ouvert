"""Open an archive again as a work folder, to correct it.

    python pipeline/reopen.py path/to/<work>.zip               # -> scores/<id>/
    python pipeline/reopen.py path/to/<work>.zip --as <name>   # -> scores/<name>/

An archive made by pipeline/publish.py carries what it was made from under source/ (work.yaml,
the transcription src/NNN.cht, the MusicXML, the tables). This puts it back as scores/<name>/,
with the pages and the sheet of the archive, and with work/img/ (each page, and where its staves
and measures are, worked out from the archive's own pages), so that the usual tools read it:

    python tools/omr/zoom.py <page> <measure> --staff T --work scores/<name>   # the place, enlarged
    ... correct src/<page>.cht (or the MusicXML of a movement marked `source: musicxml`) ...
    python pipeline/cht/check.py scores/<name>/src/<page>.cht
    python pipeline/cht/render.py scores/<name>/src/<page>.cht --compare
    python pipeline/cht/compile.py scores/<name>
    python pipeline/publish.py <name>            # -> packs/<name>.zip, checked

The new archive keeps the work's id: added in the app, it takes the place of the old one.

The scan is not in an archive. tools/omr/pages.py and tools/page_assets.py, which start from the
scan, are not for a folder opened this way: its pages and their measure boxes are kept as they are.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
import check_pack  # noqa: E402

SOURCE = "source/"


def _safe(name: str) -> bool:
    """A file name of the archive that stays inside the folder it is written to."""
    p = PurePosixPath(name)
    return bool(name) and not p.is_absolute() and ".." not in p.parts and ":" not in name and "\\" not in name


def restore(files: dict[str, bytes], dest: Path) -> list[str]:
    """Writes the work folder `dest` from the files of an archive; -> the files written."""
    pack = json.loads(files["pack.json"].decode("utf-8"))
    out: dict[str, bytes] = {}
    for name, data in files.items():
        if name.startswith(SOURCE) and _safe(name[len(SOURCE):]):
            out[name[len(SOURCE):]] = data
    for pg in pack.get("pages") or []:                       # the pages of the app are the pages of the folder
        img = pg.get("img")
        if isinstance(img, str) and img in files and _safe(img):
            out["pages/" + PurePosixPath(img).name] = files[img]
    fiche = pack.get("fiche")
    if isinstance(fiche, str) and fiche in files:
        out["fiche.md"] = files[fiche]
    for name, data in out.items():
        f = dest / name
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    return sorted(out)


def layouts(dest: Path) -> list[str]:
    """Writes work/img/pNNN.png and pNNN.json (what tools/omr/pages.py writes from a scan) from the
    pages of the folder: the picture is the page of the archive, the measures are the boxes of
    pages/pages.json, the staves those of pages/staves.json (tools/page_assets.py; without it they
    are looked for on the page). -> remarks, one per system left without staves."""
    import cv2

    from pipeline.cht import workdir
    from tools import page_staves

    listing = dest / "pages" / "pages.json"
    if not listing.exists():
        return ["no pages in this archive: nothing to look at with zoom.py or render.py --compare"]
    work = dest / "work"
    img_dir = work / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    remarks = []
    printed: dict[int, list] = {}
    if (dest / "pages" / "staves.json").exists():
        printed = {int(p["page"]): p["systems"] for p in json.loads((dest / "pages" / "staves.json").read_text(encoding="utf-8"))}
    sizes = workdir.system_sizes(work)
    for pg in json.loads(listing.read_text(encoding="utf-8")):
        gray = cv2.imread(str(dest / "pages" / pg["img"]), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            remarks.append(f"p{pg['page']}: {pg['img']} is not in the archive")
            continue
        page = int(pg["page"])
        mask = page_staves.line_mask(gray)
        solo = workdir.solo_voices(work, page)
        per_page = workdir.staves_per_system(work, page)
        systems, numbers, movements, names = [], [], [], []
        for k, s in enumerate(pg["systems"]):
            ms = sorted((m for m in pg["measures"] if m["sys"] == k), key=lambda m: m["x0"])
            x0 = ms[0]["x0"] if ms else 0
            x1 = ms[-1]["x1"] if ms else gray.shape[1]
            rows = printed.get(page, [])
            staves = [{"top": t, "bottom": b} for t, b in rows[k]] if k < len(rows) else []
            if not staves:
                # looked for on the page; kept when their number is one this page or this work can have
                # (a staff under dense chords is easily missed)
                band = (max(0, s["top"] - page_staves.MARGIN), min(gray.shape[0], s["bottom"] + page_staves.MARGIN), x0, x1)
                staves, _ = page_staves.system_staves(mask, band, s["top"], s["bottom"])
                want = per_page[k:k + 1] if len(per_page) == len(pg["systems"]) else (sizes or [])
                if want and len(staves) not in want:
                    staves = []
            if staves:
                names.append(workdir.staff_names(len(staves), solo))
            else:
                # not found: the system as one block, so that zoom.py still shows it whole
                staves = [{"top": s["top"], "bottom": s["bottom"]}]
                names.append(["st1"])
                remarks.append(f"p{page} s{k + 1}: its staves were not found on the page: zoom.py shows the system whole, "
                               f"render.py --compare and heads.py leave it out")
            systems.append({
                "top": staves[0]["top"], "bottom": staves[-1]["bottom"], "start_x": int(x0),
                "barlines": [int(m["x1"]) for m in ms], "piano": names[-1][-2:] == ["PR", "PL"], "weak": [],
                "staves": [{"lines": [round(st["top"] + i * (st["bottom"] - st["top"]) / 4) for i in range(5)],
                            "x0": int(x0), "x1": int(x1)} for st in staves],
            })
            numbers.append([int(m["n"]) for m in ms])
            movements.append(ms[0]["mv"] if ms else None)
        d = {"systems": systems, "page": page, "measures": [len(n) for n in numbers], "absolute_numbers": True,
             "first_measure": next((n[0] for n in numbers if n), None), "staff_names": names,
             "movements": movements, "numbers": numbers, "reopened": True}
        cv2.imwrite(str(img_dir / f"p{page:03d}.png"), gray)
        (img_dir / f"p{page:03d}.json").write_text(json.dumps(d, indent=1), encoding="utf-8")
    return remarks


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("archive", type=Path, help="the .zip of a work (as added in the app)")
    ap.add_argument("--as", dest="name", help="name of the folder in scores/ (default: the work's id)")
    ap.add_argument("--force", action="store_true", help="write over the files of a folder that exists")
    ap.add_argument("--scores", type=Path, default=ROOT / "scores", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    try:
        files = check_pack.read_archive(a.archive)
        pack = json.loads(files["pack.json"].decode("utf-8"))
        work_id = pack["id"]
    except Exception as e:  # noqa: BLE001 - whatever is wrong with the file, said in one line
        print(f"cannot read {a.archive} as an archive for Pupitre ({e or type(e).__name__})")
        return 1
    if SOURCE + "work.yaml" not in files:
        print(f"{a.archive.name} carries no sources (source/work.yaml): it was made before archives kept them, or by "
              f"other means. It cannot be corrected from itself: the work folder it was made from is needed "
              f"(or the score, to transcribe again: docs/CREER.md).")
        return 1
    name = a.name or work_id
    if not check_pack.ID.match(name):
        print(f"{name!r} is no simple folder name (letters, digits, - . _): choose one with --as")
        return 1
    dest = a.scores / name
    if dest.exists() and any(dest.iterdir()) and not a.force:
        print(f"{dest} exists: another name with --as, or --force to write over its files")
        return 1
    written = restore(files, dest)
    remarks = layouts(dest)
    shown = dest.relative_to(ROOT) if dest.is_relative_to(ROOT) else dest
    pages = sorted(p.stem for p in (dest / "src").glob("*.cht"))
    print(f"{shown}/: {len(written)} file(s) of « {pack.get('title', work_id)} » ({work_id})"
          + (f"; the transcription: src/{pages[0]}.cht … {pages[-1]}.cht (one file per printed page)" if pages else ""))
    for r in remarks:
        print(f"  {r}")
    print(f"To look at a place:  python tools/omr/zoom.py <page> <measure> --staff T --work {shown}")
    print(f"After correcting:    python pipeline/cht/compile.py {shown}  &&  python pipeline/publish.py {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
