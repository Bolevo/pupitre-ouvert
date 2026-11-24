"""Check an archive (a pack) before giving it to a singer: will the app open it, and well?

    python pipeline/check_pack.py packs/<work>.zip          # what the singer will import
    python pipeline/check_pack.py scores/<work>/pack        # the folder before zipping

Prints the errors (the app refuses the archive, or would show it wrongly), the warnings (to
look at: often the sign of a mistake in the score), a summary, and one last line:
`OK`, `OK with N warning(s)` or `FAILED: N error(s)`. Exit status 1 on errors.
The specification is docs/ARCHIVE.md; the app checks the same structure on import
(app/src/pack/validate.ts). Only the standard library is
needed (Pillow, if installed, also checks the size of the page images).
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

PACK_MAJOR = 1
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
IMAGE_EXT = {"webp", "png", "jpg", "jpeg"}
XML_ID = re.compile(r'xml:id="([^"]+)"')


def read_archive(path: Path) -> dict[str, bytes]:
    """{name: bytes} of a .zip (its files at the root or all in one folder) or of a folder."""
    if path.is_dir():
        return {f.relative_to(path).as_posix(): f.read_bytes() for f in sorted(path.rglob("*")) if f.is_file()}
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX/")]
        mains = sorted((n for n in names if n == "pack.json" or n.endswith("/pack.json")), key=len)
        root = mains[0][: -len("pack.json")] if mains else ""
        return {n[len(root):]: z.read(n) for n in names if n.startswith(root)}


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def is_str(v) -> bool:
    return isinstance(v, str) and v != ""


def lead(n: str) -> int | None:
    """The number a measure is known by on the pages: '12' -> 12, '8a' -> 8."""
    m = re.match(r"-?\d+", n)
    return int(m.group()) if m else None


def image_size(data: bytes) -> tuple[int, int] | None:
    try:
        import io

        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            return im.size
    except Exception:  # noqa: BLE001 - no Pillow, or not an image it reads
        return None


def check(files: dict[str, bytes]) -> tuple[list[str], list[str], list[str]]:
    """-> (errors, warnings, summary lines)."""
    errors: list[str] = []
    warnings: list[str] = []
    info: list[str] = []
    err, warn = errors.append, warnings.append
    if "pack.json" not in files:
        return ["pack.json is missing: not an archive for Pupitre"], [], []
    try:
        pack = json.loads(files["pack.json"].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        return [f"pack.json is not valid UTF-8 JSON ({e})"], [], []
    if not isinstance(pack, dict):
        return ["pack.json must hold one object (the work)"], [], []
    if not is_num(pack.get("version")) or int(pack["version"]) != PACK_MAJOR:
        return [f"version {pack.get('version')!r}: the app reads version {PACK_MAJOR}.x"], [], []
    if not is_str(pack.get("id")) or not ID.match(pack["id"]):
        err("id: a simple identifier is expected (letters, digits, - . _), e.g. faure-requiem")
    if not is_str(pack.get("title")):
        err("title is missing")
    if "composer" in pack and not isinstance(pack["composer"], str):
        err("composer must be a string")
    elif not pack.get("composer"):
        warn("composer is empty: the list of works shows the title alone")
    movements = pack.get("movements")
    if not isinstance(movements, list) or not movements:
        return errors + ["movements: the work has no movement"], warnings, info

    # movement id -> numbers of its measures, as the app matches them to the page boxes: the
    # leading integer ('8a', the second half of a measure cut by a repeat, shares the box of 8)
    mv_measures: dict[str, set[int]] = {}
    for i, mv in enumerate(movements):
        at = f"movement {i + 1}"
        if not isinstance(mv, dict):
            err(f"{at}: not an object")
            continue
        mid = mv.get("id")
        if not is_str(mid) or not ID.match(mid):
            err(f"{at}: id is missing or not a simple identifier")
        elif mid in mv_measures:
            err(f"{at}: id {mid!r} is already another movement's")
        else:
            at = f"movement {i + 1} ({mid})"
        if not is_str(mv.get("title")):
            err(f"{at}: title is missing")
        mei = None
        if not is_str(mv.get("mei")):
            err(f"{at}: mei (the name of the score file) is missing")
        elif mv["mei"] not in files:
            err(f"{at}: {mv['mei']} is not in the archive")
        else:
            mei = files[mv["mei"]].decode("utf-8", "replace")
            if not re.search(r"<mei[\s>]", mei):
                err(f"{at}: {mv['mei']} is not an MEI file")
                mei = None
        dur = mv.get("durationMs")
        if not is_num(dur) or dur <= 0:
            err(f"{at}: durationMs is missing")
            dur = None

        parts: dict[str, str] = {}
        if not isinstance(mv.get("parts"), list) or not mv["parts"]:
            err(f"{at}: parts is empty (no voice, no instrument)")
        else:
            for p in mv["parts"]:
                if not (isinstance(p, dict) and is_str(p.get("id")) and is_str(p.get("name"))
                        and p.get("kind") in ("voice", "accomp") and isinstance(p.get("staves"), list)):
                    err(f"{at}: a part is badly described (id, name, kind 'voice' or 'accomp', staves): {p!r}")
                    break
                if p["id"] in parts:
                    err(f"{at}: two parts have the id {p['id']!r}")
                parts[p["id"]] = p["kind"]
            if parts and "voice" not in parts.values():
                warn(f"{at}: no part of kind 'voice' (instruments only): the app follows the first part")

        measures = mv.get("measures") if isinstance(mv.get("measures"), list) else []
        ok_measures = bool(measures) and all(
            isinstance(m, dict) and isinstance(m.get("n"), str) and is_num(m.get("t")) and isinstance(m.get("ts"), list)
            and len(m["ts"]) == 2 and all(is_num(x) for x in m["ts"]) for m in measures)
        if not measures:
            err(f"{at}: measures is empty")
        elif not ok_measures:
            err(f"{at}: a measure is badly described (n as a string, t, ts)")
        else:
            ts = [m["t"] for m in measures]
            if ts != sorted(ts) or ts[0] != 0:
                err(f"{at}: the measures' times (t) must start at 0 and never go back")
            if dur is not None and ts[-1] >= dur:
                err(f"{at}: durationMs ({dur}) is not after the last measure's start ({ts[-1]})")
            dup = [n for n, c in Counter(m["n"] for m in measures).items() if c > 1]
            if dup:
                warn(f"{at}: measure numbers used twice ({', '.join(dup[:5])}): the page boxes of these measures are ambiguous")
        if isinstance(mid, str):
            mv_measures[mid] = {lead(m["n"]) for m in measures if isinstance(m, dict) and isinstance(m.get("n"), str)} - {None}

        notes = mv.get("notes")
        if not isinstance(notes, list):
            err(f"{at}: notes is missing")
            continue
        drawn = set(XML_ID.findall(mei)) if mei is not None else None
        bad = lost = late = 0
        per_part: Counter = Counter()
        overlaps: Counter = Counter()
        for n in notes:
            if not (isinstance(n, dict) and is_str(n.get("id")) and n.get("part") in parts and isinstance(n.get("m"), int)
                    and not isinstance(n.get("m"), bool) and 0 <= n["m"] < len(measures)
                    and is_num(n.get("t")) and is_num(n.get("d")) and n["d"] > 0 and is_num(n.get("midi"))):
                bad += 1
                continue
            per_part[n["part"]] += 1
            if drawn is not None and (n["id"] not in drawn or any(x not in drawn for x in n.get("ids", []))):
                lost += 1
            if dur is not None and (n["t"] < 0 or n["t"] + n["d"] > dur + 1):
                late += 1
        if bad:
            err(f"{at}: {bad} note(s) badly described (id, part = a part's id, m = index of a measure, t, d > 0, midi)")
        if lost:
            err(f"{at}: {lost} note(s) whose id is not in {mv.get('mei')} (pack.json and the MEI do not go together)")
        if late:
            err(f"{at}: {late} note(s) outside the movement (t < 0 or t + d > durationMs)")
        if not notes:
            warn(f"{at}: no note at all")
        for pid, kind in parts.items():
            if not per_part[pid] and notes:
                warn(f"{at}: part {pid} has no note")
            if kind != "voice":
                continue
            mine = sorted((n for n in notes if isinstance(n, dict) and n.get("part") == pid and is_num(n.get("t")) and is_num(n.get("d"))),
                          key=lambda n: (n["t"], n.get("midi", 0)))
            for a, b in zip(mine, mine[1:]):
                if b["t"] > a["t"] and b["t"] < a["t"] + a["d"] - 1:
                    overlaps[pid] += 1
            pitches = [n["midi"] for n in mine if is_num(n.get("midi"))]
            if pitches and (min(pitches) < 36 or max(pitches) > 88):
                warn(f"{at}: voice {pid} goes from MIDI {min(pitches)} to {max(pitches)}: an octave or clef mistake?")
        for pid, c in overlaps.items():
            warn(f"{at}: voice {pid} has {c} note(s) starting before the previous one ends (two voices on one staff, or a wrong duration)")
        tempos = mv.get("tempos") or []
        if not tempos:
            warn(f"{at}: no tempo in the score: played at 120 to the quarter")
        lines = len(mv.get("lyricLines") or [])
        info.append(f"{mv.get('id')}: {mv.get('title')!r}  {len(measures)} measures, {len(notes)} notes, "
                    f"{(dur or 0) / 1000:.0f} s, parts {' '.join(parts)}, {lines} lyric line(s)")

    pages = pack.get("pages")
    if pages is None:
        warn("no pages: the app shows the line of the voice only, not the printed score")
    elif not isinstance(pages, list):
        err("pages must be a list")
    else:
        boxed: dict[str, set[int]] = {m: set() for m in mv_measures}
        for i, pg in enumerate(pages):
            at = f"page {pg.get('page', i + 1) if isinstance(pg, dict) else i + 1}"
            if not (isinstance(pg, dict) and is_str(pg.get("img")) and is_num(pg.get("w")) and is_num(pg.get("h"))
                    and pg["w"] > 0 and pg["h"] > 0 and isinstance(pg.get("systems"), list) and isinstance(pg.get("measures"), list)):
                err(f"{at}: badly described (img, w, h, systems, measures)")
                continue
            if pg["img"] not in files:
                err(f"{at}: image {pg['img']} is not in the archive")
            elif pg["img"].rsplit(".", 1)[-1].lower() not in IMAGE_EXT:
                err(f"{at}: image {pg['img']}: webp, png or jpg expected")
            else:
                size = image_size(files[pg["img"]])
                if size and (abs(size[0] - pg["w"]) > 2 or abs(size[1] - pg["h"]) > 2):
                    err(f"{at}: w × h = {pg['w']} × {pg['h']} but the image is {size[0]} × {size[1]}")
            ns = len(pg["systems"])
            if not all(isinstance(s, dict) and is_num(s.get("top")) and is_num(s.get("bottom")) and s["top"] < s["bottom"] for s in pg["systems"]):
                err(f"{at}: a system is badly described (top < bottom)")
            wrong = out = unknown = 0
            for m in pg["measures"]:
                if not (isinstance(m, dict) and m.get("mv") in mv_measures and is_num(m.get("n")) and isinstance(m.get("sys"), int)
                        and 0 <= m["sys"] < ns and all(is_num(m.get(k)) for k in ("x0", "x1", "y0", "y1"))):
                    wrong += 1
                    continue
                if not (0 <= m["x0"] < m["x1"] <= pg["w"] + 1 and 0 <= m["y0"] < m["y1"] <= pg["h"] + 1):
                    out += 1
                if "xn" in m and not (is_num(m["xn"]) and m["x0"] <= m["xn"] < m["x1"]):
                    out += 1
                if m["n"] not in mv_measures[m["mv"]]:
                    unknown += 1
                boxed[m["mv"]].add(int(m["n"]))
            if wrong:
                err(f"{at}: {wrong} measure box(es) badly described (mv = a movement's id, n, sys = index of a system, x0, x1, y0, y1)")
            if out:
                err(f"{at}: {out} measure box(es) outside the page or empty (x0 < x1, y0 < y1, x0 <= xn < x1)")
            if unknown:
                err(f"{at}: {unknown} box(es) for measure numbers the movement does not have")
        for mid, have in boxed.items():
            missing = mv_measures[mid] - have
            if missing:
                some = ", ".join(map(str, sorted(missing)[:8]))
                warn(f"movement {mid}: {len(missing)} measure(s) without a box on any page ({some}{'…' if len(missing) > 8 else ''}): the page does not follow there")
        info.append(f"{len(pages)} page(s)")

    fiche = pack.get("fiche")
    if fiche is not None and (not is_str(fiche) or fiche not in files):
        err(f"fiche: {fiche!r} is not in the archive")
    elif fiche is None:
        info.append("no sheet (fiche.md): optional, the text of the work and its translation")
    size = sum(len(b) for b in files.values())
    info.append(f"{len(files)} file(s), {size / 1e6:.1f} MB unpacked")
    if size > 150e6:
        warn("more than 150 MB: reduce the page images (1300 px wide is what the app is made for)")
    return errors, warnings, info


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1 or args[0].startswith("-"):
        print(__doc__)
        return 0 if args[:1] in (["-h"], ["--help"]) else 2
    path = Path(args[0])
    try:
        files = read_archive(path)
    except (OSError, zipfile.BadZipFile) as e:
        print(f"FAILED: cannot read {path} ({e})")
        return 1
    errors, warnings, info = check(files)
    for e in errors:
        print(f"ERROR   {e}")
    for w in warnings:
        print(f"WARNING {w}")
    for line in info:
        print(f"        {line}")
    if errors:
        print(f"FAILED: {len(errors)} error(s)")
        return 1
    print("OK" if not warnings else f"OK with {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
