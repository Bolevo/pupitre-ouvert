"""Works of other shapes than four voices and a piano, made from the example (scores/deux-chorals):
one voice alone, two, three, a voice and a keyboard, instruments only, no printed pages.
The builder and the app must take them all (pipeline/tests/test_layouts.py, app/e2e).

    python pipeline/tests/layouts.py OUT_DIR      # writes OUT_DIR/<name>.zip for each layout
"""
from __future__ import annotations

import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from build_pack import build  # noqa: E402

EXAMPLE = ROOT / "scores" / "deux-chorals"

# name -> (parts kept: {name in the example: name in the variant}, pages kept)
LAYOUTS: dict[str, tuple[dict[str, str], bool]] = {
    "solo": ({"Tenor": "Tenor"}, False),
    "duo": ({"Soprano": "Soprano", "Alto": "Alto"}, False),
    "trio": ({"Soprano": "Soprano", "Alto": "Alto", "Bass": "Baritone"}, False),
    "voice-keyboard": ({"Soprano": "Soprano", "Bass": "Organ"}, False),
    "instruments": ({"Soprano": "Violin", "Bass": "Cello"}, False),
    "no-pages": ({"Soprano": "Soprano", "Alto": "Alto", "Tenor": "Tenor", "Bass": "Bass"}, False),
    "all": ({"Soprano": "Soprano", "Alto": "Alto", "Tenor": "Tenor", "Bass": "Bass"}, True),
}


def keep_parts(xml: str, keep: dict[str, str]) -> str:
    """The MusicXML with only the parts named in `keep`, renamed."""
    root = ET.fromstring(xml.encode("utf-8"))
    plist = root.find("part-list")
    gone = set()
    for el in list(plist):
        if el.tag == "part-group":
            plist.remove(el)
        elif el.tag == "score-part":
            name = el.findtext("part-name").strip()
            if name not in keep:
                gone.add(el.get("id"))
                plist.remove(el)
            else:
                el.find("part-name").text = keep[name]
                for extra in el.findall("part-abbreviation"):
                    el.remove(extra)
    for part in root.findall("part"):
        if part.get("id") in gone:
            root.remove(part)
    return ET.tostring(root, encoding="unicode")


def make(name: str, dest: Path) -> Path:
    """A work folder `dest/<name>` with that layout; returns it."""
    keep, pages = LAYOUTS[name]
    work = dest / name
    work.mkdir(parents=True)
    cfg = (EXAMPLE / "work.yaml").read_text(encoding="utf-8")
    cfg = cfg.replace("id: bach-deux-chorals", f"id: layout-{name}").replace('title: "Deux chorals"', f'title: "Deux chorals ({name})"')
    (work / "work.yaml").write_text(cfg, encoding="utf-8")
    for f in ("choral1.musicxml", "choral2.musicxml"):
        (work / f).write_text(keep_parts((EXAMPLE / f).read_text(encoding="utf-8"), keep), encoding="utf-8")
    if pages:
        shutil.copytree(EXAMPLE / "pages", work / "pages")
    return work


def make_zip(name: str, dest: Path) -> Path:
    pack = build(make(name, dest / "work"))
    out = dest / f"{name}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(pack.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(pack).as_posix())
    return out


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for layout in LAYOUTS:
        print(make_zip(layout, out))
    shutil.rmtree(out / "work")
