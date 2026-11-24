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
    assert pic is not None and pic.shape[1] == 1900
    # the page strips are white, the transcription strips tinted: four of each
    tinted = (pic[:, 2, 0].astype(int) < pic[:, 2, 2].astype(int) - 10)
    runs = sum(1 for a, b in zip(tinted, tinted[1:]) if b and not a)
    assert runs == 4


def test_a_system_whose_barlines_do_not_match_is_not_stretched(work):
    assert render.compare_system(work / "work", work / "src" / "001.cht", 1, 1, 1, 3, ("S", "A", "T", "B")) is None


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
