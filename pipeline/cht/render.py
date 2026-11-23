"""Render a .cht page (or measures) to PNG with verovio, optionally side by side
with the source image, to proof-read a transcription.

    python pipeline/cht/render.py scores/<work>/src/004.cht                 # -> work/render/004.png
    python pipeline/cht/render.py scores/<work>/src/004.cht --compare       # source/render per system
    python pipeline/cht/render.py scores/<work>/src/004.cht --compare --parts T
    python pipeline/cht/render.py scores/<work>/src/004.cht --measures 50-52 --parts S,A,T,B

--compare writes work/render/004_cmp_sK.png: for every system, the source crop
(top, from work/img) above the rendering of the same measures (bottom). K is
the page system number given by the 'system K' lines of the file (a page shared
by two movements: 009b.cht starts at 'system 2'). Each system shows only the
requested parts that have a staff in it (piano-only systems: PR,PL).
Default parts: the voices written in the file.
Previous pages of the movement found in src/ are read first so that ties and
words continuing from them are rendered correctly.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cairosvg  # noqa: E402
import cv2  # noqa: E402
import numpy as np  # noqa: E402
import verovio  # noqa: E402

from pipeline.cht import compile as comp  # noqa: E402
from pipeline.cht import workdir  # noqa: E402
from pipeline.cht.parse import CHOIR, Page, parse_file  # noqa: E402
verovio.enableLog(verovio.LOG_ERROR)   # its remarks on a page cut out of its movement are noise here
TEXT_FONT = "Liberation Serif"        # has Cyrillic (cairo does no font fallback)


def ensure_fonts() -> None:
    """cairosvg cannot use the @font-face verovio embeds: install the Leipzig
    SMuFL font (used for metronome notes) as a user font once."""
    import base64
    import re
    import subprocess
    fdir = Path.home() / ".local" / "share" / "fonts"
    ttf = fdir / "Leipzig-verovio.ttf"
    if ttf.exists():
        return
    css = Path(verovio.__file__).parent / "data" / "Leipzig.css"
    m = re.search(r"base64,([A-Za-z0-9+/=]+)", css.read_text()) if css.exists() else None
    if not m:
        return
    try:
        from io import BytesIO
        from fontTools.ttLib import TTFont
        font = TTFont(BytesIO(base64.b64decode(m.group(1))))
        font.flavor = None
        fdir.mkdir(parents=True, exist_ok=True)
        font.save(str(ttf))
        subprocess.run(["fc-cache", "-f", str(fdir)], check=False, capture_output=True)
    except Exception as e:   # noqa: BLE001 - only the tempo note glyph is affected
        print(f"note: could not install the Leipzig font ({e}); tempo notes may show as boxes")


def render_png(xml: str, width_px: int, scale: int = 40, one_system: bool = False) -> np.ndarray:
    """MusicXML -> one image (all verovio pages stacked), `width_px` wide.
    one_system: everything on a single system (to sit under a source system)."""
    tk = verovio.toolkit()
    tk.setOptions({
        "pageWidth": 2100, "pageHeight": 60000, "adjustPageHeight": True,
        "scale": scale, "breaks": "none" if one_system else "encoded", "condense": "none", "header": "none", "footer": "none",
        "mnumInterval": 1, "smuflTextFont": "none", "pageMarginLeft": 30, "pageMarginRight": 30,
        "pageMarginTop": 30, "pageMarginBottom": 30, "lyricSize": 4.0,
    })
    if not tk.loadData(xml):
        raise RuntimeError("verovio could not load the MusicXML")
    ensure_fonts()
    imgs = []
    for i in range(1, tk.getPageCount() + 1):
        svg = tk.renderToSVG(i).replace('font-family="Times, serif"', f'font-family="{TEXT_FONT}"')
        png = cairosvg.svg2png(bytestring=svg.encode(), output_width=width_px,
                               background_color="white")
        imgs.append(cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR))
    return np.vstack(imgs)


def _context_pages(page_file: Path) -> tuple[list[Page], Page]:
    """Earlier pages of the same movement (for ties/lyrics state) + the page."""
    target = parse_file(page_file)
    src = page_file.parent
    before = []
    for f in sorted(src.glob("*.cht")):
        if f.resolve() == page_file.resolve():
            continue
        try:
            p = parse_file(f)
        except Exception:   # noqa: BLE001 - a broken neighbour must not block rendering
            continue
        if p.movement == target.movement and (p.page or 0) < (target.page or 0):
            before.append(p)
    before.sort(key=lambda p: p.page or 0)
    return before[-1:], target          # the previous page is enough for continuity


def compile_range(page_file: Path, parts: tuple[str, ...], measures: tuple[int, int] | None,
                  breaks: bool = True) -> str:
    before, target = _context_pages(page_file)
    nums = [m.number for m in target.measures]
    rng = measures or (nums[0], nums[-1])
    opts = comp.Options(parts=parts, system_breaks=breaks, measures=rng)
    return comp.to_musicxml(comp.build(before + [target], opts))


def _label(img: np.ndarray, text: str) -> np.ndarray:
    strip = np.full((34, img.shape[1], 3), 235, np.uint8)
    cv2.putText(strip, text, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 160), 2)
    return np.vstack([strip, img])


def _layout(work: Path, page: int) -> dict | None:
    js = work / "img" / f"p{page:03d}.json"
    return json.loads(js.read_text()) if js.exists() else None


def system_staff_names(lay: dict | None, k: int) -> list[str] | None:
    """Voice of each staff of page system k (1-based), from pages.py's pNNN.json."""
    if lay is None or k > len(lay["systems"]):
        return None
    names = lay.get("staff_names")
    if names:
        return names[k - 1]
    return workdir.staff_names(len(lay["systems"][k - 1]["staves"]))


def page_voices(page: Page) -> tuple[str, ...]:
    used = {v.rstrip("2") for m in page.measures for v in m.voices}
    return tuple(v for v in CHOIR if v in used) + (("PR", "PL") if used & {"PR", "PL"} else ())


def source_crop(work: Path, page: int, k: int, parts: tuple[str, ...], scale: float = 2.0) -> np.ndarray | None:
    """Crop of system k (1-based) restricted to the staves of `parts`."""
    im_path = work / "img" / f"p{page:03d}.png"
    lay = _layout(work, page)
    if lay is None or not im_path.exists():
        return None
    if k > len(lay["systems"]):
        return None
    sysd = lay["systems"][k - 1]
    staves = sysd["staves"]
    order = system_staff_names(lay, k)
    img = cv2.imread(str(im_path), cv2.IMREAD_GRAYSCALE)
    h = img.shape[0]
    systems = lay["systems"]
    top = (systems[k - 2]["bottom"] + sysd["top"]) // 2 if k > 1 else max(0, sysd["top"] - 90)
    bot = (sysd["bottom"] + systems[k]["top"]) // 2 if k < len(systems) else min(h, sysd["bottom"] + 80)
    if order:
        idx = [order.index(p) for p in parts if p in order]
        if idx and len(idx) < len(order):
            i0, i1 = min(idx), max(idx)
            sp = (staves[i0]["lines"][4] - staves[i0]["lines"][0]) / 4
            if i0 > 0:
                top = int(staves[i0]["lines"][0] - 0.35 * (staves[i0]["lines"][0] - staves[i0 - 1]["lines"][4]))
            top = min(top, int(staves[i0]["lines"][0] - 4 * sp))
            if i1 + 1 < len(staves):
                b4 = staves[i1]["lines"][4]
                bot = int(b4 + 0.85 * (staves[i1 + 1]["lines"][0] - b4))
    crop = img[max(0, top):bot]
    crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page", type=Path, help=".cht page file")
    ap.add_argument("--parts", help="e.g. T or S,A,T,B or PR,PL (default: the voices of the file)")
    ap.add_argument("--measures", help="range, e.g. 50-52")
    ap.add_argument("--compare", action="store_true", help="per system: source crop above rendering")
    ap.add_argument("--width", type=int, default=2200, help="output width in pixels")
    ap.add_argument("-o", "--out", type=Path, help="output PNG (single render)")
    a = ap.parse_args(argv)
    page_file = a.page.resolve()
    work = page_file.parent.parent / "work"
    outdir = work / "render"
    outdir.mkdir(parents=True, exist_ok=True)
    target = parse_file(page_file)
    parts = tuple(p.strip() for p in a.parts.split(",")) if a.parts else page_voices(target)
    stem = page_file.stem + ("" if not a.parts or len(parts) == 6 else "_" + "".join(parts))
    if not a.compare:
        rng = None
        if a.measures:
            lo, _, hi = a.measures.partition("-")
            rng = (int(lo), int(hi or lo))
        img = render_png(compile_range(page_file, parts, rng), a.width)
        out = a.out or outdir / f"{stem}.png"
        cv2.imwrite(str(out), img)
        print(f"wrote {out}")
        return 0
    # one comparison image per system (K = page system number from 'system K')
    systems, cur = [], None
    for m in target.measures:
        if m.system is not None or cur is None:
            k = m.system if m.system is not None else (systems[-1][0] + 1 if systems else 1)
            cur = [k, m.number, m.number]
            systems.append(cur)
        cur[2] = m.number
    lay = _layout(work, target.page or 0)
    for k, lo, hi in systems:
        if a.measures:
            alo, _, ahi = a.measures.partition("-")
            if hi < int(alo) or lo > int(ahi or alo):
                continue
        names = system_staff_names(lay, k)
        sparts = tuple(p for p in parts if names is None or p in names)
        if not sparts:
            print(f"system {k}: no staff {','.join(parts)} in the source ({','.join(names)}): skipped")
            continue
        ren = render_png(compile_range(page_file, sparts, (lo, hi), breaks=False), a.width, one_system=True)
        src = source_crop(work, target.page or 0, k, sparts)
        blocks = []
        if src is not None:
            src = cv2.resize(src, (a.width, int(src.shape[0] * a.width / src.shape[1])))
            blocks.append(_label(src, f"SOURCE p{target.page} system {k}"))
        blocks.append(_label(ren, f"RENDER m{lo}-{hi}  parts {','.join(sparts)}"))
        out = outdir / f"{stem}_cmp_s{k}.png"
        cv2.imwrite(str(out), np.vstack(blocks))
        print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
