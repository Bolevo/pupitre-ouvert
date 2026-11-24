"""Validate .cht pages (docs/CHT_FORMAT.md, section Contrôles).

    python pipeline/cht/check.py scores/<work>            # all pages
    python pipeline/cht/check.py scores/<work>/src/004.cht scores/<work>/src/005.cht
    python pipeline/cht/check.py scores/<work> --pages 4-9 [--strict]

Prints "file:line: m<N> [E|W] message"; exit code 1 if any error (or any
warning with --strict). Cross-page checks (numbering, ties, measures.tsv) use
every page of the movement that exists in src/.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.cht.measures import load_measures  # noqa: E402
from pipeline.cht import workdir  # noqa: E402
from pipeline.cht.parse import (CHOIR, ChtError, Context, Page, parse_file,  # noqa: E402
                                voice_duration)

RANGES = {"S": (60, 83), "A": (53, 76), "T": (48, 69), "B": (40, 64)}   # c4-b5, f3-e5, c3-a4, e2-e4
_RANGE_BY_NAME = [("sopr", "S"), ("mezz", "S"), ("alt", "A"), ("ten", "T"), ("tén", "T"), ("bas", "B"), ("bar", "B")]


def range_voice(page: Page, voice: str) -> str:
    """Range class of a voice: its 'part' name if given ('part A "Soprano II"' -> S)."""
    name = page.parts.get(voice, "").lower()
    return next((v for k, v in _RANGE_BY_NAME if name.startswith(k)), voice)


def _row(mtable, page: int | None, movement: int | None):
    if not mtable:
        return None
    if hasattr(mtable, "row"):
        return mtable.row(page, movement) or mtable.row(page)
    return mtable.get(page)


@dataclass
class Issue:
    level: str        # E | W
    path: str
    line: int
    measure: int | None
    msg: str

    def __str__(self) -> str:
        m = f" m{self.measure}" if self.measure is not None else ""
        return f"{self.path}:{self.line}:{m} [{self.level}] {self.msg}"


def _fmt(q: Fraction) -> str:
    return f"{q}" if q.denominator != 1 else f"{q.numerator}"


def check_pages(pages: list[Page], mtable=None, focus: set[str] | None = None,
                choir: list[str] | None = None) -> list[Issue]:
    """`pages`: every page of the work (sorted). Issues are reported only for
    files in `focus` (default: all). `choir`: the vocal staves of the work (work.yaml
    `staves`; default S A T B): the voices expected in every measure."""
    issues: list[Issue] = []

    def add(level, page, line, mnum, msg):
        if focus is None or page.path in focus:
            issues.append(Issue(level, page.path, line, mnum, msg))

    by_mvt: dict[int, list[Page]] = {}
    for p in pages:
        if p.page is None:
            add("E", p, 1, None, "missing 'page N'")
        if p.movement is None:
            add("E", p, 1, None, "missing 'movement N'")
        if p.meta is None:
            add("E", p, 1, None, "missing initial 'meta key=.. time=.. tempo=..'")
        by_mvt.setdefault(p.movement or 0, []).append(p)

    for mvt, plist in by_mvt.items():
        plist.sort(key=lambda p: p.page or 0)
        ctx = Context()
        prev_num: int | None = None
        prev_page: Page | None = None
        open_ties: dict[str, tuple[set[int], Page, int, int]] = {}
        last_tops: dict[str, int] = {}          # previous sung top note per voice
        for pg in plist:
            # ---- measures.tsv agreement
            row = _row(mtable, pg.page, pg.movement)
            if row is not None:
                if row.movement != pg.movement:
                    add("E", pg, 1, None, f"measures.tsv says page {pg.page} is in movement {row.movement}")
                nums = [m.number for m in pg.measures]
                if nums and nums[0] != row.first:
                    add("E", pg, pg.measures[0].line, nums[0],
                        f"first measure should be m{row.first} (measures.tsv)")
                if len(nums) != row.count:
                    add("E", pg, 1, None, f"{len(nums)} measures on the page, measures.tsv says {row.count}")
                systems = [m for m in pg.measures if m.system is not None]
                if systems and len(systems) != len(row.systems):
                    add("W", pg, systems[0].line, None,
                        f"{len(systems)} 'system' lines, measures.tsv says {len(row.systems)} systems")
                elif systems:
                    starts, k = [], 0
                    for c in row.systems:
                        starts.append(pg.measures[k].number if k < len(pg.measures) else None)
                        k += c
                    got = [m.number for m in systems]
                    if got != starts:
                        add("W", pg, systems[0].line, None,
                            f"systems start at {got}, measures.tsv implies {starts}")
                    ks = [m.system for m in systems]
                    want_k = list(range(row.sys0, row.sys0 + len(row.systems)))
                    if ks != want_k:
                        add("W", pg, systems[0].line, None,
                            f"'system' numbers {ks}, measures.tsv implies page systems {want_k}")
            # ---- context continuity
            if pg.meta and prev_page is not None:
                for name, a, b in (("key", pg.meta.key, ctx.key), ("time", pg.meta.time, ctx.time)):
                    if a != b:
                        add("W", pg, pg.meta.line, None,
                            f"head meta {name}={a} differs from the running context {b} of the previous page")
            if pg.meta:
                ctx.apply(pg.meta)
            # choir voices expected in every measure: all four, or on a solo page
            # (with 'part' lines) the declared parts + choir voices used on the page
            expected = [v for v in CHOIR if choir is None or v in choir]
            if pg.parts:
                used = {v for m in pg.measures for v in m.voices}
                expected = [v for v in CHOIR if v in pg.parts or v in used]
            for m in pg.measures:
                ctx.apply(m.meta)
                mdur = ctx.measure_dur(m)
                # numbering
                if prev_num is not None and m.number != prev_num + 1:
                    add("E", pg, m.line, m.number, f"measure number jumps from m{prev_num} to m{m.number}")
                prev_num = m.number
                # durations
                for v, evs in m.voices.items():
                    d = voice_duration(evs, mdur)
                    if d != mdur:
                        add("E", pg, m.voice_lines[v], m.number,
                            f"{v}: {_fmt(d)} quarters, measure has {_fmt(mdur)}")
                for v in expected:
                    if v not in m.voices:
                        add("W", pg, m.line, m.number, f"no '{v} |' line (write R for a rest)")
                # ties, attacks, lyrics, ranges, leaps
                for v, evs in m.voices.items():
                    pending, tpage, tline, tm = open_ties.get(v, (set(), pg, m.line, m.number))
                    attacks = 0
                    last_top = last_tops.get(v)
                    for e in evs:
                        if e.kind == "clef":
                            continue
                        if e.kind == "note":
                            mids = {p.midi for p in e.pitches}
                            missing = pending - mids
                            if missing:
                                add("E", tpage, tline, tm,
                                    f"{v}: tie '~' to a different pitch (next is {' '.join(map(str, e.pitches))})")
                            if not all(p.midi in pending for p in e.pitches):
                                attacks += 1
                            pending = {p.midi for p, t in zip(e.pitches, e.ties) if t}
                            tpage, tline, tm = pg, e.line, m.number
                            base = range_voice(pg, v.rstrip("2"))
                            if base in RANGES:
                                lo, hi = RANGES[base]
                                for p in e.pitches:
                                    if not lo <= p.midi <= hi:
                                        add("W", pg, e.line, m.number, f"{v}: {p} outside the usual {base} range")
                                top = max(p.midi for p in e.pitches)
                                if last_top is not None and abs(top - last_top) > 12:
                                    add("W", pg, e.line, m.number, f"{v}: leap of {abs(top - last_top)} semitones")
                                last_top = top
                        else:
                            if pending:
                                add("E", tpage, tline, tm, f"{v}: tie '~' followed by a rest (a tie goes on in the same voice: {v} -> {v}, also across the barline)")
                            pending = set()
                    if last_top is not None:
                        last_tops[v] = last_top
                    open_ties[v] = (pending, tpage, tline, tm)
                    if v.rstrip("2") in CHOIR:
                        for lang in pg.lyric_langs:
                            syl = m.lyrics.get((v, lang))
                            if syl is None:
                                if attacks:
                                    add("E", pg, m.voice_lines[v], m.number,
                                        f"{v}: {attacks} sung notes but no '{v}.{lang} |' line")
                                continue
                            if len(syl) != attacks:
                                add("E", pg, m.lyric_lines[(v, lang)], m.number,
                                    f"{v}.{lang}: {len(syl)} syllables for {attacks} sung notes")
                for (v, lang), line in m.lyric_lines.items():
                    if v not in m.voices:
                        add("E", pg, line, m.number, f"lyrics for '{v}' but no '{v} |' line")
            prev_page = pg
        for v, (pending, tpage, tline, tm) in open_ties.items():
            if pending and tpage is plist[-1] and tm == plist[-1].measures[-1].number:
                add("W", tpage, tline, tm, f"{v}: tie at the end of the last available page")
    return issues


def load_all(src: Path, extra: list[Path]) -> tuple[list[Page], list[Issue]]:
    pages, issues = [], []
    files = sorted(set(list(src.glob("*.cht")) + extra)) if src.exists() else sorted(set(extra))
    for f in files:
        try:
            pages.append(parse_file(f))
        except ChtError as e:
            issues.append(Issue("E", e.path, e.line, None, e.msg))
    pages.sort(key=lambda p: (p.movement or 0, p.page or 0))
    return pages, issues


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("targets", nargs="+", type=Path, help="score folder or .cht files")
    ap.add_argument("--pages", help="only report these printed pages, e.g. 4-9")
    ap.add_argument("--strict", action="store_true", help="warnings also fail")
    ap.add_argument("-q", "--quiet", action="store_true", help="errors only")
    a = ap.parse_args(argv)
    files = [t for t in a.targets if t.suffix == ".cht"]
    work = next((t for t in a.targets if t.is_dir()), None)
    if work is None:
        work = files[0].resolve().parent.parent
    src = work / "src"
    pages, issues = load_all(src, [f.resolve() for f in files])
    focus = {str(f.resolve()) for f in files} or None
    for p in pages:
        p.path = str(Path(p.path).resolve())
    if a.pages:
        lo, _, hi = a.pages.partition("-")
        keep = range(int(lo), int(hi or lo) + 1)
        focus = {p.path for p in pages if p.page in keep}
    mtable = load_measures(work / "work" / "measures.tsv")
    issues = [i for i in issues if focus is None or str(Path(i.path).resolve()) in focus]
    issues += check_pages(pages, mtable, focus, workdir.work_staves(work / "work"))
    cwd = Path.cwd()
    for i in sorted(issues, key=lambda i: (i.path, i.line)):
        if a.quiet and i.level == "W":
            continue
        try:
            i.path = str(Path(i.path).resolve().relative_to(cwd))
        except ValueError:
            pass
        print(i)
    n_err = sum(i.level == "E" for i in issues)
    n_warn = len(issues) - n_err
    print(f"{len(pages)} page(s), {sum(len(p.measures) for p in pages)} measures: "
          f"{n_err} error(s), {n_warn} warning(s)")
    return 1 if n_err or (a.strict and n_warn) else 0


if __name__ == "__main__":
    sys.exit(main())
