"""Audiveris OMR -> DRAFT .cht (a starting point, never trusted as is).

    python tools/omr/draft.py 4 --work scores/<work>            # printed page 4 -> work/draft/004.cht
    python tools/omr/draft.py 4-9 --jobs 2 --work scores/<work> # several pages (Audiveris ~20-40 s/page)
    python tools/omr/draft.py 4 --reuse --work scores/<work>    # convert an existing Audiveris export again

Optional: needs Audiveris (https://github.com/Audiveris/audiveris, with Java), found on the
PATH or named by the environment variable AUDIVERIS. The method works without it.

Steps: work/img/pNNN.png (from pages.py) -> upscale x2.2 + binarise ->
Audiveris -batch -export -> MusicXML -> .cht. Staves are mapped by order
(6 staves = S A T B PR PL, 2 = PR PL); the tenor's written pitches are
lowered an octave (Audiveris does not see the little 8 of the clef).
Measure numbers come from work/measures.tsv. Durations are taken from the
note types, so incomplete/overfull measures show up in check.py.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

import cv2
from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.cht import workdir  # noqa: E402
from pipeline.cht.measures import load_measures  # noqa: E402
from tools.omr import imgproc as ip  # noqa: E402

import os  # noqa: E402
import shutil  # noqa: E402

AUDIVERIS = Path(os.environ.get("AUDIVERIS") or shutil.which("Audiveris") or shutil.which("audiveris") or "Audiveris")
TYPES = {"whole": 1, "half": 2, "quarter": 4, "eighth": 8, "16th": 16, "32nd": 32, "64th": 64}
ACC = {-2: "bb", -1: "b", 0: "", 1: "#", 2: "##"}


# ------------------------------------------------------------------ Audiveris

def run_audiveris(page: int, work: Path, reuse: bool = False) -> list[Path]:
    """-> MusicXML files exported for this page (one per detected 'movement')."""
    out = work / "omr" / f"p{page:03d}"
    if not (reuse and list(out.glob("*.mxl"))):
        out.mkdir(parents=True, exist_ok=True)
        for f in out.glob("*"):
            if f.is_file():
                f.unlink()
        img = cv2.imread(str(work / "img" / f"p{page:03d}.png"), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise SystemExit(f"missing work/img/p{page:03d}.png: run tools/omr/pages.py first")
        src = out / f"p{page:03d}.png"
        # x2.2 for small scans; Audiveris refuses images over 20 Mpixels (large photos)
        factor = min(2.2, (19e6 / (img.shape[0] * img.shape[1])) ** 0.5)
        cv2.imwrite(str(src), ip.for_omr(img, factor))
        subprocess.run([str(AUDIVERIS), "-batch", "-export", "-output", str(out), str(src)],
                       check=False, capture_output=True)
    return sorted(out.glob("*.mxl"), key=lambda p: (len(p.name), p.name))


def read_mxl(path: Path) -> etree._Element:
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.endswith(".xml") and not n.startswith("META-INF"))
        return etree.fromstring(z.read(name))


# ------------------------------------------------------------------ conversion

def _pitch(n: etree._Element, octave_shift: int) -> str:
    p = n.find("pitch")
    step = p.findtext("step").lower()
    alter = int(float(p.findtext("alter") or 0))
    return f"{step}{ACC.get(alter, '')}{int(p.findtext('octave')) + octave_shift}"


def _dur(n: etree._Element) -> tuple[str, Fraction] | None:
    t = n.findtext("type")
    if t not in TYPES:
        return None
    dots = len(n.findall("dot"))
    base = TYPES[t]
    q = Fraction(4, base) * (2 - Fraction(1, 2 ** dots))
    return f"{base}{'.' * dots}", q


def convert_measure(meas: etree._Element, staff_names: dict[int, str], tenor_shift: dict[str, int]):
    """-> {cht voice: tokens}, {cht voice: lyric hints}"""
    per_voice: dict[tuple[int, str], list] = {}
    lyrics: dict[str, list[str]] = {}
    for n in meas.findall("note"):
        if n.find("grace") is not None or n.find("cue") is not None:
            continue
        staff = int(n.findtext("staff") or 1)
        voice = n.findtext("voice") or "1"
        per_voice.setdefault((staff, voice), []).append(n)
    out: dict[str, list[str]] = {}
    for staff, name in staff_names.items():
        vids = sorted({v for (s, v) in per_voice if s == staff}, key=lambda v: int(v))
        for k, vid in enumerate(vids[:2]):
            cname = name if k == 0 else name + "2"
            toks: list[str] = []
            chord: list[str] = []
            chord_dur = ""
            chord_tie = False
            tup_open = False
            notes = per_voice[(staff, vid)]

            def flush():
                nonlocal chord, chord_dur, chord_tie
                if chord:
                    body = chord[0] if len(chord) == 1 else "<" + " ".join(chord) + ">"
                    toks.append(f"{body}:{chord_dur}{'~' if chord_tie else ''}")
                chord, chord_dur, chord_tie = [], "", False

            for n in notes:
                is_chord = n.find("chord") is not None
                if not is_chord:
                    flush()
                tm = n.find("time-modification")
                if tm is not None and not tup_open and not is_chord:
                    toks.append("{" + tm.findtext("actual-notes"))
                    tup_open = True
                if n.find("rest") is not None:
                    if n.find("rest").get("measure") == "yes" or n.findtext("type") is None:
                        toks.append("R")
                    else:
                        d = _dur(n)
                        toks.append(f"r:{d[0]}" if d else "R")
                else:
                    d = _dur(n)
                    if d is None:
                        continue
                    chord.append(_pitch(n, tenor_shift.get(name, 0)))
                    chord_dur = d[0]
                    chord_tie = chord_tie or any(t.get("type") == "start" for t in n.findall("tie"))
                    if name in ("S", "A", "T", "B"):
                        for ly in n.findall("lyric"):
                            txt = ly.findtext("text") or ""
                            syl = ly.findtext("syllabic") or "single"
                            lyrics.setdefault(cname, []).append(txt + ("-" if syl in ("begin", "middle") else ""))
                if tup_open:
                    nt = n.find("notations/tuplet")
                    if nt is not None and nt.get("type") == "stop":
                        flush()
                        toks.append("}")
                        tup_open = False
            flush()
            if tup_open:
                toks.append("}")
            if toks:
                out[cname] = toks
    return out, lyrics


def staff_layout(root: etree._Element) -> list[tuple[etree._Element, dict[int, str], dict[str, int]]]:
    """Map each part's staves to cht voices by global staff order."""
    parts = root.findall("part")
    counts = []
    for p in parts:
        st = p.find(".//attributes/staves")
        counts.append(int(st.text) if st is not None else 1)
    total = sum(counts)
    if total >= 6:
        names = ["S", "A", "T", "B"] + [f"X{i}" for i in range(total - 6)] + ["PR", "PL"]
    elif total == 2:
        names = ["PR", "PL"]
    elif total == 5:
        names = ["S", "A", "T", "B", "PL"]
    else:
        names = ["S", "A", "T", "B", "PR", "PL"][:total]
    res, i = [], 0
    for p, c in zip(parts, counts):
        mapping = {k + 1: names[i + k] for k in range(c)}
        shift = {}
        for k, nm in mapping.items():
            if nm == "T":
                oc = p.find(".//clef/clef-octave-change")
                shift[nm] = 0 if oc is not None else -1
        res.append((p, mapping, shift))
        i += c
    return res


def draft_page(page: int, work: Path, reuse: bool = False) -> Path:
    files = run_audiveris(page, work, reuse)
    mt = load_measures(work / "measures.tsv")
    row = mt.get(page)
    first = row.first if row else 1
    movement = row.movement if row else 1
    measures: list[dict] = []          # each: {voice: tokens}, plus '_lyr', '_sys'
    notes: list[str] = []
    for f in files:
        root = read_mxl(f)
        lay = staff_layout(root)
        n_staves = sum(len(m) for _, m, _ in lay)
        if n_staves < 2:
            notes.append(f"# skipped {f.name}: {n_staves} staff (probably noise)")
            continue
        n_meas = max(len(p.findall("measure")) for p, _, _ in lay)
        base = len(measures)
        for k in range(n_meas):
            measures.append({"_lyr": {}, "_sys": False})
        for p, mapping, shift in lay:
            for k, meas in enumerate(p.findall("measure")):
                cell = measures[base + k]
                if meas.find("print[@new-system='yes']") is not None or (k == 0 and meas.find("print") is not None):
                    cell["_sys"] = True
                v, ly = convert_measure(meas, mapping, shift)
                cell.update(v)
                cell["_lyr"].update(ly)
    lines = [f"# DRAFT from Audiveris ({', '.join(f.name for f in files)}) - verify EVERYTHING",
             "# Tenor pitches lowered one octave (treble-8 clef). Lyrics below are OCR hints only.",
             *notes]
    if row and len(mt.rows(page)) > 1:
        lines.append(f"# WARNING: page {page} is shared by movements "
                     f"{[r.movement for r in mt.rows(page)]}: split it into {page:03d}a.cht / {page:03d}b.cht")
    if row and row.count != len(measures):
        lines.append(f"# WARNING: Audiveris found {len(measures)} measures, measures.tsv says {row.count}")
    lines += [f"page {page}", f"movement {movement}",
              "meta key=3 time=4/4 tempo=56   # FIXME: check key/time/tempo on the page", ""]
    sysno = 0
    for k, cell in enumerate(measures):
        if cell["_sys"]:
            sysno += 1
            lines.append(f"system {sysno}")
        lines.append(f"m {first + k}")
        for v in ("S", "A", "T", "B", "PR", "PR2", "PL", "PL2", "S2", "A2", "T2", "B2"):
            if v in cell:
                lines.append(f"{v:<4}| {' '.join(cell[v])}")
                if cell["_lyr"].get(v):
                    lines.append(f"# {v} lyrics (OCR): {' '.join(cell['_lyr'][v])}")
            elif v in ("S", "A", "T", "B", "PR", "PL"):
                lines.append(f"{v:<4}| R")
        lines.append("")
    out = work / "draft" / f"{page:03d}.cht"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pages", help="printed pages, e.g. 4 or 4-9")
    ap.add_argument("--work", type=Path, required=True, help="score folder (scores/<work>)")
    ap.add_argument("--reuse", action="store_true", help="reuse an existing Audiveris export")
    ap.add_argument("--jobs", type=int, default=1)
    a = ap.parse_args(argv)
    lo, _, hi = a.pages.partition("-")
    pages = range(int(lo), int(hi or lo) + 1)
    work = workdir.work_folder(a.work)
    with ThreadPoolExecutor(a.jobs) as ex:
        for out in ex.map(lambda p: draft_page(p, work, a.reuse), pages):
            print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
