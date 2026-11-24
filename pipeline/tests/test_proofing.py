"""Proof-reading and the facts of a work: the page against the transcription staff by staff,
the vocal staves kept when the accompaniment was left out, the facts read from the archive
just built."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import layouts  # noqa: E402
from test_pages_flow import make_work, page  # noqa: E402
from tools import fiche_data  # noqa: E402
from tools.omr import pages  # noqa: E402
from pipeline.cht import render  # noqa: E402

CHT = """\
page 1
movement 1
lyrics la
meta key=0 time=4/4 tempo=60
system 1
m 1
S   | c5:2 d5:2
S.la| Lo- cus
A   | e4:1
A.la| Lo-
T   | g3:2 a3:2
T.la| Lo- cus
B   | c3:1
B.la| Lo-
m 2
S   | e5:1
S.la| i-
A   | g4:1
A.la| cus
T   | c4:1
T.la| i-
B   | c3:1
B.la| cus
"""


@pytest.fixture()
def work(tmp_path):
    w = make_work(tmp_path, [page(systems=1, staves=4, bars=(800,))])
    assert pages.main(["--work", str(w)]) == 0
    (w / "src").mkdir()
    (w / "src" / "001.cht").write_text(CHT, encoding="utf-8")
    return w


def test_each_staff_of_the_page_stands_above_its_transcription(work):
    pic = render.compare_system(work / "work", work / "src" / "001.cht", 1, 1, 1, 2, ("S", "A", "T", "B"))
    assert pic is not None and pic.shape[1] == render.COMPARE_WIDTH
    # the page strips are white, the transcription strips tinted: four of each
    tinted = (pic[:, 2, 0].astype(int) < pic[:, 2, 2].astype(int) - 10)
    runs = sum(1 for a, b in zip(tinted, tinted[1:]) if b and not a)
    assert runs == 4


def test_a_system_whose_barlines_do_not_match_is_not_stretched(work):
    assert render.compare_system(work / "work", work / "src" / "001.cht", 1, 1, 1, 3, ("S", "A", "T", "B")) is None


def test_a_system_too_wide_to_compare_in_one_picture_is_cut_at_its_barlines(work, monkeypatch):
    assert render.compare_ranges(work / "work", 1, 1, 1, 2) == [(1, 2)]
    monkeypatch.setattr(render, "LEAST_SPACE", 30.0)          # as if the page were twice as large
    assert render.compare_ranges(work / "work", 1, 1, 1, 2) == [(1, 1), (2, 2)]
    pic = render.compare_system(work / "work", work / "src" / "001.cht", 1, 1, 1, 2, ("S", "A"), only=(2, 2))
    assert pic is not None


def test_compare_writes_one_picture_per_system(work):
    assert render.main([str(work / "src" / "001.cht"), "--compare"]) == 0
    assert cv2.imread(str(work / "work" / "render" / "001_cmp_s1.png")) is not None


def test_the_facts_of_a_work_are_read_from_the_archive_just_built(tmp_path, monkeypatch, capsys):
    built = layouts.make("all", tmp_path / "scores")
    layouts.build(built)
    monkeypatch.setattr(fiche_data, "ROOT", tmp_path)
    fiche_data.report(f"scores/{built.name}", False)
    assert "mes." in capsys.readouterr().out


def test_the_facts_say_what_to_run_when_nothing_is_built(tmp_path, monkeypatch):
    (tmp_path / "scores" / "piece").mkdir(parents=True)
    (tmp_path / "scores" / "piece" / "work.yaml").write_text("title: t\ncomposer: c\nmovements: []\n", encoding="utf-8")
    monkeypatch.setattr(fiche_data, "ROOT", tmp_path)
    with pytest.raises(SystemExit, match="publish.py piece"):
        fiche_data.report("piece", False)


def test_voices_are_cross_checked_against_the_keyboard():
    from pipeline import crosscheck
    mv = {"parts": [{"id": "S", "kind": "voice"}, {"id": "P", "kind": "accomp"}],
          "measures": [{"n": "1", "t": 0, "q": 0, "ts": [4, 4]}, {"n": "2", "t": 2000, "q": 4, "ts": [4, 4]}],
          "notes": [{"part": "S", "m": 0, "t": 0, "d": 1000, "midi": 72},        # doubled an octave lower
                    {"part": "S", "m": 0, "t": 1000, "d": 1000, "midi": 74},     # the keyboard plays c e g
                    {"part": "S", "m": 1, "t": 2000, "d": 1000, "midi": 76},     # the keyboard is silent
                    {"part": "P", "m": 0, "t": 0, "d": 2000, "midi": 60},
                    {"part": "P", "m": 0, "t": 0, "d": 2000, "midi": 64},
                    {"part": "P", "m": 0, "t": 0, "d": 2000, "midi": 67}]}
    lines, compared = crosscheck.misses(mv)
    assert compared == 2 and len(lines) == 1
    assert "m  1 beat 3.00  S   d5" in lines[0]


def page_with_notes(notes, hollow=()):
    """One system of four staves, two measures; `notes`: {staff index: [(x, half spaces above the
    bottom line)]} drawn as noteheads with a stem; `hollow`: the (staff, x) drawn as white notes."""
    import numpy as np
    img = page(systems=1, staves=4, bars=(800,))
    sp, top0, inner = 16, 160, 150
    for i, heads in notes.items():
        bot = top0 + i * inner + 4 * sp
        for x, pos in heads:
            y = int(bot - pos * sp / 2)
            for ledger in range(-2, pos - 1, -2):                       # ledger lines below the staff
                cv2.line(img, (x - 18, bot - ledger * sp // 2), (x + 18, bot - ledger * sp // 2), 0, 2)
            cv2.ellipse(img, (x, y), (11, 8), -20, 0, 360, 0, -1)
            if (i, x) in hollow:
                cv2.ellipse(img, (x, y), (7, 3), -20, 0, 360, 255, -1)
            cv2.line(img, (x + 10, y), (x + 10, y - 3 * sp), 0, 2)
    return img


HEADS = {0: [(300, 5), (500, 6), (950, 7), (1200, 5)],                  # S: c5 d5 | e5 c5
         1: [(300, 0), (500, 0), (950, 2), (1200, -2)],                 # A: e4 e4 | g4 c4 (on a ledger line)
         2: [(300, 4), (500, 4), (950, 5), (1200, 5)],                  # T: b3 b3 | c4 c4 (sounding)
         3: [(300, 4), (500, 3), (950, 2), (1200, 0)]}                  # B: d3 c3 | b2 g2

VOICES = """\
page 1
movement 1
meta key=0 time=4/4 tempo=60
system 1
m 1
S   | c5:2 d5:2
A   | e4:2 e4:2
T   | b3:2 b3:2
B   | d3:2 c3:2
m 2
S   | e5:2 c5:2
A   | g4:2 c4:2
T   | c4:2 c4:2
B   | b2:2 g2:2
"""


@pytest.fixture()
def sung(tmp_path):
    hollow = {(i, x) for i, heads in HEADS.items() for x, _ in heads}   # half notes
    w = make_work(tmp_path, [page_with_notes(HEADS, hollow)])
    assert pages.main(["--work", str(w)]) == 0
    (w / "src").mkdir()
    return w


def test_noteheads_at_the_heights_written_are_not_reported(sung, capsys):
    from pipeline.cht import heads
    (sung / "src" / "001.cht").write_text(VOICES, encoding="utf-8")
    assert heads.main([str(sung)]) == 0
    assert "0 measure(s) to read again; 8 measures compared" in capsys.readouterr().out


def test_a_note_written_a_step_from_its_head_is_a_place_to_read_again(sung, capsys):
    from pipeline.cht import heads
    (sung / "src" / "001.cht").write_text(VOICES.replace("A   | g4:2 c4:2", "A   | g4:2 b3:2").replace("B   | d3:2 c3:2", "B   | d3:2 e3:2"),
                                          encoding="utf-8")
    assert heads.main([str(sung)]) == 0
    out = capsys.readouterr().out
    assert "p1 m2 A: b3 written, the head stands 1 step higher (c4?)" in out
    assert "p1 m1 B: e3 written, the head stands 2 steps lower (c3?)" in out
    assert "2 measure(s) to read again" in out
