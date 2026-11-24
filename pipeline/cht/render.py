"""Render a .cht page (or measures) to PNG with verovio, optionally against the source image,
to proof-read a transcription.

    python pipeline/cht/render.py scores/<work>/src/004.cht                 # -> work/render/004.png
    python pipeline/cht/render.py scores/<work>/src/004.cht --compare       # page against transcription, per system
    python pipeline/cht/render.py scores/<work>/src/004.cht --compare --parts T
    python pipeline/cht/render.py scores/<work>/src/004.cht --measures 50-52 --parts S,A,T,B

--compare writes, for every system K of the page, work/render/004_cmp_sK.png (the voices) and
004_cmp_sK_pf.png (the keyboard): each staff of the page (white) with, right under it, the
same staff engraved from the transcription (tinted), stretched so that its barlines stand under
those of the page. A pitch, a rhythm, a syllable that differs is seen in place. A system too
wide to be compared in one picture gets several (004_cmp_sK_m12-14.png, …_m15-17.png). K is the page
system number given by the 'system K' lines of the file (a page shared by two movements:
009b.cht starts at 'system 2'). --parts keeps some staves only (one picture per system).
Where the barlines of the page do not match the measures written (see tools/omr/pages.py),
the two are shown one above the other without stretching.
Previous pages of the movement found in src/ are read first so that ties and words continuing
from them are rendered correctly.
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


# ---------------------------------------------------------------- page against transcription

def _engraved(xml: str, width_px: int = 2600) -> tuple[np.ndarray, list[float], list[float]]:
    """One system engraved from MusicXML -> (picture, x of the start of the staff lines then of
    every barline, y of every staff line), in the pixels of the picture."""
    import re
    tk = verovio.toolkit()
    tk.setOptions({
        "pageWidth": 2100, "pageHeight": 60000, "adjustPageHeight": True, "scale": 40, "breaks": "none",
        "condense": "none", "header": "none", "footer": "none", "mnumInterval": 0, "smuflTextFont": "none",
        "pageMarginLeft": 30, "pageMarginRight": 30, "pageMarginTop": 30, "pageMarginBottom": 30, "lyricSize": 4.0,
    })
    if not tk.loadData(xml):
        raise RuntimeError("verovio could not load the MusicXML")
    ensure_fonts()
    svg = tk.renderToSVG(1).replace('font-family="Times, serif"', f'font-family="{TEXT_FONT}"')
    # the ruler has the measure numbers; a tempo is not something a staff is compared on
    svg = re.sub(r'<g [^>]*class="(?:mNum|tempo)[^"]*"[^>]*>.*?</g>', "", svg, flags=re.S)
    vb = re.search(r'class="definition-scale"[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    mg = re.search(r'class="page-margin" transform="translate\(([\d.]+), ([\d.]+)\)"', svg)
    k = width_px / float(vb.group(1))
    mx, my = (float(mg.group(1)), float(mg.group(2))) if mg else (0.0, 0.0)
    bars = sorted({float(m.group(1)) for m in re.finditer(r'class="barLine[^"]*"[^>]*>\s*<path d="M([\d.]+) ', svg)})
    lines = [(float(a), float(y), float(b)) for a, y, b in
             re.findall(r'<path d="M([\d.]+) ([\d.]+) L([\d.]+) \2"', svg) if float(b) - float(a) > 400]
    start = min((a for a, _, _ in lines), default=0.0)
    ys = sorted({y for _, y, _ in lines})
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=width_px, background_color="white")
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    # the last barline is drawn double or thick at the end of a piece: one position per measure end
    xs = [start]
    for b in bars:
        if b - xs[-1] > 150:
            xs.append(b)
        elif len(xs) > 1:
            xs[-1] = b
    return img, [(x + mx) * k for x in xs], [(y + my) * k for y in ys]


def _fit(strip: np.ndarray, xs: list[float], to: list[float], width: int) -> np.ndarray:
    """Stretch a picture across so that its positions `xs` come to `to` (what is left of the
    first one is dropped, what is right of the last one too)."""
    out = np.full((strip.shape[0], width, 3), 255, np.uint8)
    for a, b, c, d in zip(xs, xs[1:], to, to[1:]):
        a, b, c, d = int(round(a)), int(round(b)), int(round(c)), int(round(d))
        if b - a < 2 or d - c < 2:
            continue
        piece = cv2.resize(strip[:, max(0, a):b], (d - c, strip.shape[0]), interpolation=cv2.INTER_AREA)
        out[:, c:d] = piece[:, :min(d, width) - c] if d > width else piece
    return out


COMPARE_WIDTH = 1500      # a picture a model sees without reducing it
LEAST_SPACE = 11.0        # px per staff space under which a system is shown in several pictures


def compare_ranges(work: Path, page: int, k: int, lo: int, hi: int, width: int = COMPARE_WIDTH) -> list[tuple[int, int]]:
    """The measures of each comparison picture of system k: all of them in one, unless the
    staves would then be too small to compare noteheads (a wide system of a large page)."""
    lay = _layout(work, page)
    if lay is None or k > len(lay["systems"]):
        return [(lo, hi)]
    sysd = lay["systems"][k - 1]
    edges = [sysd["start_x"]] + list(sysd["barlines"])
    st = sysd["staves"][0]["lines"]
    sp = (st[4] - st[0]) / 4
    if len(edges) - 1 != hi - lo + 1:
        return [(lo, hi)]
    shown = sp * (width - 70) / max(1.0, edges[-1] - edges[0] + 6 * sp)
    n = min(hi - lo + 1, int(np.ceil(LEAST_SPACE / shown))) if shown < LEAST_SPACE else 1
    out, a = [], 0
    for c in range(1, n + 1):                 # cuts at the barlines nearest to equal widths
        goal = edges[0] + (edges[-1] - edges[0]) * c / n
        b = max(a + 1, min(range(1, len(edges)), key=lambda i: abs(edges[i] - goal))) if c < n else len(edges) - 1
        out.append((lo + a, lo + b - 1))
        a = b
    return [r for r in out if r[0] <= r[1]]


def compare_system(work: Path, page_file: Path, page: int, k: int, lo: int, hi: int,
                   parts: tuple[str, ...], width: int = COMPARE_WIDTH,
                   only: tuple[int, int] | None = None) -> np.ndarray | None:
    """System k of the page (measures lo..hi; `only`: some of them), staff by staff: the page,
    and under it the transcription engraved and stretched measure by measure to the barlines of
    the page. None when the page's layout is not there or its barlines do not match the
    measures (the caller then stacks them)."""
    lay = _layout(work, page)
    im_path = work / "img" / f"p{page:03d}.png"
    if lay is None or not im_path.exists() or k > len(lay["systems"]):
        return None
    sysd = lay["systems"][k - 1]
    names = system_staff_names(lay, k) or []
    edges = [sysd["start_x"]] + list(sysd["barlines"])
    if len(edges) - 1 != hi - lo + 1:
        return None
    first = lo
    lo, hi = only or (lo, hi)
    edges = edges[lo - first:hi - first + 2]
    img = cv2.imread(str(im_path), cv2.IMREAD_GRAYSCALE)
    staves = sysd["staves"]
    sp = (staves[0]["lines"][4] - staves[0]["lines"][0]) / 4
    # the keyboard's two staves are engraved (and shown) together, a voice alone
    groups: list[tuple[str, ...]] = []
    for p in parts:
        if p in ("PR", "PL"):
            if not groups or groups[-1][0] not in ("PR", "PL"):
                groups.append(tuple(q for q in ("PR", "PL") if q in parts))
        else:
            groups.append((p,))
    # no further up or down than half-way to the neighbouring systems
    above = staves[0]["lines"][0] - lay["systems"][k - 2]["staves"][-1]["lines"][4] if k > 1 else 99 * sp
    below = lay["systems"][k]["staves"][0]["lines"][0] - staves[-1]["lines"][4] if k < len(lay["systems"]) else 99 * sp
    left = max(0, int(edges[0] - (5 if lo == first else 1) * sp))
    right = min(img.shape[1], int(edges[-1] + sp))
    f = (width - 70) / (right - left)                      # page pixels -> picture pixels
    to = [70 + (x - left) * f for x in edges]
    rows = []
    for g in groups:
        idx = [names.index(p) for p in g if p in names]
        if not idx:
            continue
        i0, i1 = min(idx), max(idx)
        top = staves[i0]["lines"][0] - (0.4 * (staves[i0]["lines"][0] - staves[i0 - 1]["lines"][4]) if i0 else min(5 * sp, 0.5 * above))
        bot = staves[i1]["lines"][4] + (0.9 * (staves[i1 + 1]["lines"][0] - staves[i1]["lines"][4]) if i1 + 1 < len(staves) else min(6 * sp, 0.5 * below))
        top, bot = max(0, int(min(top, staves[i0]["lines"][0] - 2.5 * sp))), min(img.shape[0], int(bot))
        src = cv2.cvtColor(cv2.resize(img[top:bot, left:right], None, fx=f, fy=f, interpolation=cv2.INTER_AREA), cv2.COLOR_GRAY2BGR)
        src = np.hstack([np.full((src.shape[0], 70, 3), 255, np.uint8), src])[:, :width]
        cv2.putText(src, "".join(g) if len(g) == 1 else "pf", (6, int((staves[i0]["lines"][2] - top) * f) + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 190), 2)
        ren, xs, ys = _engraved(compile_range(page_file, g, (lo, hi), breaks=False))
        if len(xs) != len(edges) or len(ys) < 5:
            return None
        z = sp * f / ((ys[4] - ys[0]) / 4)                 # the engraving at the staff size of the page
        y0, y1 = max(0, int(ys[0] - 4.2 * (ys[4] - ys[0]) / 4)), min(ren.shape[0], int(ys[-1] + 7.5 * (ys[4] - ys[0]) / 4))
        ren = cv2.resize(ren[y0:y1], None, fx=1, fy=z, interpolation=cv2.INTER_AREA)
        ren = _fit(ren, xs, to, width)
        ren = (ren.astype(np.float32) * np.array([0.90, 0.97, 1.0], np.float32)).astype(np.uint8)   # tinted: the transcription
        cv2.putText(ren, "=", (22, int((ys[2] - y0) * z) + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 110, 190), 2)
        rows += [src, ren, np.full((6, width, 3), 200, np.uint8)]
    if not rows:
        return None
    head = np.full((40, width, 3), 235, np.uint8)
    cv2.putText(head, f"p{page} system {k}  m{lo}-{hi}   white: the page   tinted (=): the transcription, barlines under the page's",
                (8, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (0, 0, 160), 2)
    ruler = np.full((26, width, 3), 255, np.uint8)
    for n, x in zip(range(lo, hi + 1), to):
        cv2.putText(ruler, f"m{n}", (int(x) + 4, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 0, 220), 2)
    return np.vstack([head, ruler] + rows[:-1])


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
        # the voices and the keyboard apart (one picture each), unless --parts chose
        voices = tuple(p for p in sparts if p not in ("PR", "PL"))
        keys = tuple(p for p in sparts if p in ("PR", "PL"))
        sets = [(sparts, "")] if a.parts or not (voices and keys) else [(voices, ""), (keys, "_pf")]
        for group, tag in sets:
            ranges = compare_ranges(work, target.page or 0, k, lo, hi)
            for only in ranges:
                part = "" if len(ranges) == 1 else f"_m{only[0]}-{only[1]}"
                out = outdir / f"{stem}_cmp_s{k}{tag}{part}.png"
                pic = compare_system(work, page_file, target.page or 0, k, lo, hi, group, only=only)
                if pic is None:           # no layout, or barlines that do not match: one above the other
                    ren = render_png(compile_range(page_file, group, (lo, hi), breaks=False), a.width, one_system=True)
                    src = source_crop(work, target.page or 0, k, group)
                    blocks = []
                    if src is not None:
                        src = cv2.resize(src, (a.width, int(src.shape[0] * a.width / src.shape[1])))
                        blocks.append(_label(src, f"SOURCE p{target.page} system {k} (its barlines do not match the measures written: not aligned)"))
                    blocks.append(_label(ren, f"RENDER m{lo}-{hi}  parts {','.join(group)}"))
                    pic = np.vstack(blocks)
                cv2.imwrite(str(out), pic)
                print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
