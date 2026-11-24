"""Tests for the .cht toolchain (parse, check, compile, measures table)."""
from __future__ import annotations

import sys
from fractions import Fraction
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.cht import check, compile as comp  # noqa: E402
from pipeline.cht.measures import PageRow, load_measures, renumber, save_measures  # noqa: E402
from pipeline.cht.parse import ChtError, Pitch, parse_text, voice_duration  # noqa: E402

PAGE = """\
page 5
movement 1
lyrics ru tr
meta key=3 time=4/4 tempo=56
system 1
m 12 mark=2
S   | R
A   | r:2 !p e4:4 f#4:4      # comment after notes
A.ru| и- ду
A.tr| i- *dou
T   | a3:4. b3:8 c#4:2~
T.ru| в+не- ве- до-
T.tr| vni- *vié- do-
B   | R^
PR  | <c#5 e5 a5>:4 <b4 d5>:8 e5:8 <a4 c#5>:2
PR2 | s:2 {3 a4:8 b4:8 c#5:8} r:4
PL  | a2:2 e3:2
m 13
meta tempo=288 beat=2 text="Allegro"
S   | R
A   | a4:2 g#4:2
A.ru| мне _
A.tr| mnié _
T   | c#4:2 d4:4 e4:4
T.ru| мый мне
T.tr| mouill mnié
B   | R
PR  | R
PL  | clef:G a3:1
"""


def page(text=PAGE, path="t/005.cht"):
    return parse_text(text, path)


# ------------------------------------------------------------------ parse

def test_lyric_line_must_be_declared():
    """No lyric line exists by default: an undeclared one says what to add to the header."""
    with pytest.raises(ChtError, match="add 'lyrics la' to the header"):
        parse_text("page 1\nmovement 1\nmeta key=0 time=4/4 tempo=60\nm 1\nS | c4:1\nS.la| Ky-\n")
    with pytest.raises(ChtError, match="this page declares 'lyrics fr'"):
        parse_text("page 1\nmovement 1\nlyrics fr\nmeta key=0 time=4/4 tempo=60\nm 1\nS | c4:1\nS.la| Ky-\n")


def test_pitch_midi():
    assert Pitch.parse("c4").midi == 60
    assert Pitch.parse("f#4").midi == 66
    assert Pitch.parse("bb3").midi == 58
    assert Pitch.parse("e#4").midi == 65


def test_parse_structure():
    p = page()
    assert (p.page, p.movement) == (5, 1)
    assert p.meta.key == 3 and p.meta.time == (4, 4) and p.meta.tempo == 56
    m12, m13 = p.measures
    assert m12.number == 12 and m12.mark == "2" and m12.system == 1
    assert m13.meta.tempo == 288 and m13.meta.beat == "2" and m13.meta.text == "Allegro"
    chord = m12.voices["PR"][0]
    assert [str(x) for x in chord.pitches] == ["c#5", "e5", "a5"]
    tup = m12.voices["PR2"][1:4]
    assert all(e.tuplet == (3, 2) for e in tup)
    assert sum(e.dur for e in tup) == Fraction(1)
    assert tup[0].tuplet_pos == "start" and tup[2].tuplet_pos == "stop"
    assert m12.voices["A"][1].dynamics == ["p"]
    assert m12.voices["B"][0].fermata
    assert m13.voices["PL"][0].kind == "clef"


def test_lyrics_tokens():
    syl = page().measures[0].lyrics[("T", "tr")]
    assert [s.text for s in syl] == ["vni", "vié", "do"]
    assert [s.hyphen for s in syl] == [True, True, True]
    assert syl[1].stressed and not syl[0].stressed
    assert page().measures[0].lyrics[("T", "ru")][0].text == "в не"


def test_durations_and_mrest():
    p = page()
    four = Fraction(4)
    for v, evs in p.measures[0].voices.items():
        assert voice_duration(evs, four) == four, v


def test_tie_per_pitch_in_chord():
    p = parse_text("page 1\nmovement 1\nmeta key=0 time=2/4 tempo=60\nm 1\nPR | <c4~ e4>:2\n")
    e = p.measures[0].voices["PR"][0]
    assert e.ties == [True, False]


def test_meta_after_measure_line_applies_to_it():
    p = page()
    assert p.measures[1].meta is not None and p.measures[0].meta is None


@pytest.mark.parametrize("bad", ["S | a3:3", "S | h4:4", "S | {3 a4:8 b4:8", "X | R", "S | !zz a4:4"])
def test_syntax_errors_have_line_numbers(bad):
    text = "page 1\nmovement 1\nmeta key=0 time=4/4 tempo=60\nm 1\n" + bad + "\n"
    with pytest.raises(ChtError) as ei:
        parse_text(text, "x.cht")
    assert ei.value.line == 5


def test_missing_meta_is_an_error():
    with pytest.raises(ChtError):
        parse_text("page 1\nmovement 1\nm 1\nS | R\n")


# ------------------------------------------------------------------ check

def errors(pages, mtable=None):
    return [i for i in check.check_pages(pages, mtable) if i.level == "E"]


def test_check_clean_page():
    assert errors([page()]) == []


def test_check_wrong_duration():
    bad = PAGE.replace("PL  | a2:2 e3:2", "PL  | a2:2 e3:4")
    errs = errors([page(bad)])
    assert len(errs) == 1 and "PL" in errs[0].msg and errs[0].measure == 12


def test_check_syllable_count():
    bad = PAGE.replace("T.tr| _ mouill mnié", "T.tr| mouill mnié").replace(
        "T.tr| mouill mnié", "T.tr| mouill")
    errs = errors([page(bad)])
    assert any("T.tr" in e.msg and "1 syllables for 2" in e.msg for e in errs)


def test_check_tie_counts_as_no_attack():
    # c#4:2~ in m12 continues into m13: m13 tenor has 2 attacks (d4, e4) only
    p = page()
    assert not [e for e in errors([p]) if e.measure == 13]


def test_check_tie_to_other_pitch():
    bad = PAGE.replace("T   | c#4:2 d4:4 e4:4", "T   | d4:2 d4:4 e4:4").replace(
        "T.ru| мый мне", "T.ru| мый мне ещё").replace("T.tr| mouill mnié", "T.tr| mouill mnié x")
    errs = errors([page(bad)])
    assert any("tie" in e.msg for e in errs)


def test_check_numbering_between_pages():
    p1 = page()
    p2 = page(PAGE.replace("page 5", "page 6").replace("m 12 mark=2", "m 15").replace("m 13", "m 16"),
              "t/006.cht")
    errs = errors([p1, p2])
    assert any("jumps from m13 to m15" in e.msg for e in errs)


def test_check_against_measures_table():
    table = {5: PageRow(5, 1, [2], 11)}
    errs = errors([page()], table)
    assert any("should be m11" in e.msg for e in errs)


def test_check_range_warning():
    low = PAGE.replace("T   | a3:4. b3:8 c#4:2~", "T   | a2:4. b3:8 c#4:2~")
    warns = [i for i in check.check_pages([page(low)]) if i.level == "W"]
    assert any("range" in w.msg for w in warns)


# ------------------------------------------------------------------ compile

@pytest.fixture(scope="module")
def xml():
    return comp.to_musicxml(comp.build([page()]))


def test_compile_parts_and_clefs(xml):
    for name in ("Soprano", "Alto", "Tenor", "Bass", "Piano"):
        assert f"<part-name>{name}</part-name>" in xml
    assert xml.count("<score-part ") == 5
    assert "<staves>2</staves>" in xml
    assert "<clef-octave-change>-1</clef-octave-change>" in xml


def test_compile_lyrics(xml):
    assert '<lyric name="ru" number="1">' in xml
    assert '<lyric name="translit" number="2">' in xml
    assert "<text>ˈvié</text>" in xml
    assert "<text>в не</text>" in xml
    assert "<extend />" in xml


def test_compile_loads_in_music21_and_verovio(xml):
    import verovio
    from music21 import converter
    tk = verovio.toolkit()
    assert tk.loadData(xml)
    sc = converter.parseData(xml)
    tenor = next(p for p in sc.parts if p.partName == "Tenor")
    first = tenor.recurse().notes.first()
    assert first.pitch.nameWithOctave == "A3"          # sounding pitch kept
    lyr = {ly.identifier: ly for ly in first.lyrics}
    assert lyr["ru"].syllabic == "begin" and lyr["translit"].text == "vni"
    tied = [n for n in tenor.recurse().notes if n.tie is not None]
    assert [n.tie.type for n in tied] == ["start", "stop"]


def test_compile_tempo_and_mark(xml):
    assert "<rehearsal" in xml and ">2</rehearsal>" in xml
    assert "<per-minute>56</per-minute>" in xml
    assert "<beat-unit>half</beat-unit>" in xml and "<per-minute>144</per-minute>" in xml
    assert "<fermata" in xml and "<time-modification>" in xml


def test_opening_tempo_kept_when_the_first_measure_prints_only_the_word():
    # Taneyev II: the value on the page's meta line, the word on the first measure's own line
    src = ("page 1\nmovement 1\nmeta key=-5 time=3/4 tempo=72\nm 1\nmeta text=\"Andante sostenuto\"\n"
           "S   | c5:2.\nPR  | c4:2.\nPL  | c3:2.\n")
    out = comp.to_musicxml(comp.build([parse_text(src)]))
    assert "<per-minute>72</per-minute>" in out and "Andante sostenuto" in out


# ------------------------------------------------------------------ measures.tsv

def test_measures_roundtrip(tmp_path):
    rows = {3: PageRow(3, 1, [9, 10], 1), 4: PageRow(4, 1, [3, 4], 1), 24: PageRow(24, 2, [5], 1)}
    renumber(rows)
    assert rows[4].first == 20 and rows[4].last == 26 and rows[24].first == 1
    f = tmp_path / "m.tsv"
    save_measures(f, rows, ["# hello"])
    back = load_measures(f)
    assert back[4].systems == [3, 4] and back[4].first == 20


# ------------------------------------------------------------------ Vivaldi: Latin, soloists, shared pages

LATIN = """\
page 9
movement 2
lyrics la
part S "Soprano I"
part A "Soprano II"
meta key=2 time=3/4 tempo=72
system 2
m 1
S   | a5:4 b5:4 r:4
S.la| Et in
A   | f#5:2.
A.la| pax
PR  | R
PL  | R
"""


def test_latin_lyrics_and_part_names():
    p = page(LATIN, "t/009b.cht")
    assert p.lyric_langs == ("la",) and p.parts == {"S": "Soprano I", "A": "Soprano II"}
    issues = check.check_pages([p])
    assert [i for i in issues if i.level == "E"] == []
    # A named "Soprano II" uses the soprano range: f#5 is no range warning
    assert not any("range" in i.msg for i in issues)
    # solo page ('part' lines): T and B are not expected
    assert not any("no 'T |'" in i.msg for i in issues)
    xml = comp.to_musicxml(comp.build([p], comp.Options(parts=comp.sung_voices([p]))))
    assert '<lyric name="la" number="1">' in xml
    assert "<part-name>Soprano I</part-name>" in xml and "<part-name>Soprano II</part-name>" in xml
    assert "<part-name>Tenor</part-name>" not in xml


def test_undeclared_lyric_line_is_an_error():
    with pytest.raises(ChtError):
        page(LATIN.replace("S.la|", "S.ru|"))
    bad = LATIN.replace("A.la| pax", "")
    errs = errors([page(bad)])
    assert any("no 'A.la |'" in e.msg for e in errs)


def test_page_shared_by_two_movements(tmp_path):
    f = tmp_path / "m.tsv"
    f.write_text("page\tmovement\tsystems\tcount\tfirst\tlast\tnote\n"
                 "9\t1\t4\t4\t69\t72\t\n9\t2\t5,4\t9\t1\t9\t\n10\t2\t5\t5\t10\t14\t\n")
    t = load_measures(f)
    assert t[9].movement == 1 and [r.movement for r in t.rows(9)] == [1, 2]
    assert t.row(9, 2).sys0 == 2 and t.row(9, 2).first == 1
    renumber(t)
    save_measures(f, t)
    back = load_measures(f)
    assert back.row(10, 2).first == 10 and len(back.all_rows()) == 3
    # check.py uses the row of the file's movement
    p = page(LATIN.replace("system 2\n", "system 2\n").replace("m 1\n", "m 2\n"), "t/009b.cht")
    errs = errors([p], back)
    assert any("should be m1" in e.msg for e in errs)


def test_staff_names_and_regroup():
    from pipeline.cht.workdir import staff_names
    from tools.omr import layout as lay
    assert staff_names(6) == ["S", "A", "T", "B", "PR", "PL"]
    assert staff_names(2) == ["PR", "PL"]
    assert staff_names(3, ["A"]) == ["A", "PR", "PL"]
    assert staff_names(4, ["S", "A"]) == ["S", "A", "PR", "PL"]
    # other layouts: four staves alone are the choir a cappella; names for every staff are taken as given
    assert staff_names(4) == ["S", "A", "T", "B"]
    assert staff_names(5) == ["S", "A", "T", "PR", "PL"]
    assert staff_names(5, ["S", "A", "B", "PR", "PL"]) == ["S", "A", "B", "PR", "PL"]
    assert staff_names(3, ["S", "A", "B"]) == ["S", "A", "B"]
    assert staff_names(3, ["S", "PR", "PL"]) == ["S", "PR", "PL"]
    assert staff_names(2, ["S", "A"]) == ["S", "A"]
    assert staff_names(7) == [f"st{i}" for i in range(1, 8)]
    st = [lay.Staff([y, y + 8, y + 16, y + 24, y + 32], 0, 900) for y in range(0, 1800, 100)]
    systems = [lay.System(st[:1]), lay.System(st[1:2]), lay.System(st[2:6]), lay.System(st[6:12]),
               lay.System(st[12:17]), lay.System(st[17:])]
    out = lay.regroup(systems, [6, 6, 6])
    assert [len(s.staves) for s in out] == [6, 6, 6]
    assert lay.regroup(systems, [6, 6]) is systems          # totals differ: unchanged


def test_compile_refuses_to_overwrite_a_maintained_musicxml(tmp_path):
    """work.yaml `source: musicxml`: the MusicXML is maintained directly (corrected after an audit);
    a compilation from the CHT pages must not overwrite it unless forced or sent elsewhere."""
    import pytest
    from pipeline.cht import compile as cc
    (tmp_path / "work.yaml").write_text(
        "movements:\n  - {file: mvt1.musicxml, id: mvt1, source: musicxml}\n  - {file: mvt2.musicxml, id: mvt2}\n",
        encoding="utf-8")
    assert cc.xml_is_source(tmp_path, 1) and not cc.xml_is_source(tmp_path, 2)
    with pytest.raises(SystemExit):
        cc.compile_movement(tmp_path, 1)


# ------------------------------------------------------------------ other layouts than S A T B + piano

SOLO = """page 1
movement 1
lyrics fr
part S "Voix"
meta key=0 time=2/4 tempo=60
m 0 dur=1/8
S   | c4:8
S.fr| Au
m 1
S   | d4:4 e4:4
S.fr| clair de
"""


def test_a_cappella_the_score_has_no_piano():
    out = comp.to_musicxml(comp.build([parse_text(SOLO)], comp.Options(parts=comp.sung_voices([parse_text(SOLO)]))))
    assert comp.sung_voices([parse_text(SOLO)]) == ("S",)
    assert out.count("<score-part ") == 1 and "<part-name>Voix</part-name>" in out and "Piano" not in out
    with_piano = SOLO + "PR  | c5:2\nPL  | c3:2\n"
    assert comp.sung_voices([parse_text(with_piano)]) == ("S", "PR", "PL")


def test_the_voices_expected_are_those_of_the_work():
    """A work for one voice (work.yaml: staves [S, PR, PL]): no warning for the alto, tenor and
    bass it does not have."""
    page = parse_text(SOLO.replace('part S "Voix"\n', ""))
    assert [i.msg[:10] for i in check.check_pages([page])] == ["no 'A |' l", "no 'T |' l", "no 'B |' l"] * 2
    assert check.check_pages([page], choir=["S", "PR", "PL"]) == []


def test_a_renamed_staff_takes_the_clef_and_the_range_of_its_name():
    src = ("page 1\nmovement 1\npart S \"Ténor I\"\npart A \"Ténor II\"\npart T \"Baryton\"\npart B \"Basse\"\n"
           "meta key=0 time=2/4 tempo=60\nm 1\nS   | g3:2\nA   | e3:2\nT   | c3:2\nB   | c2:2\n")
    page = parse_text(src)
    out = comp.to_musicxml(comp.build([page], comp.Options(parts=comp.sung_voices([page]))))
    assert out.count("<clef-octave-change>-1</clef-octave-change>") == 2          # the two tenors
    assert out.count("<sign>F</sign>") == 2                                         # baritone and bass
    assert [check.range_voice(page, v) for v in "SATB"] == ["T", "T", "B", "B"]
    assert not [i for i in check.check_pages([page]) if "range" in i.msg and "S:" in i.msg]


def test_a_clef_at_the_start_of_a_measure_holds_when_the_staff_has_two_voices():
    """The left hand goes up into the treble clef and comes back to the bass clef at the next
    barline, under a held note written as a second voice."""
    import xml.etree.ElementTree as ET
    text = (
        "page 1\nmovement 1\nmeta key=1 time=3/4 tempo=63\n"
        "m 1\nS | g4:2.\nPR | g4:2.\nPL | g2:4 clef:G g4:8 a4:8 g4:8 a4:8\nPL2 | g2:2.\n"
        "m 2\nS | g4:2.\nPR | g4:2.\nPL | clef:F g2:4 clef:G g4:8 a4:8 g4:8 a4:8\nPL2 | g2:2.\n"
        "m 3\nS | g4:2.\nPR | g4:2.\nPL | clef:F g2:2.\nPL2 | s:2.\n"
    )
    xml = comp.to_musicxml(comp.build([parse_text(text, "t/001.cht")], comp.Options(parts=("S", "PR", "PL"))))
    piano = [p for p in ET.fromstring(xml.encode()).iter("part")][-1]
    for number in ("2", "3"):
        measure = next(m for m in piano.iter("measure") if m.get("number") == number)
        # the first thing said of the lower staff in the measure, before any time has passed: its clef
        first = next(el for el in measure if el.tag in ("attributes", "forward") or el.findtext("staff") == "2")
        clefs = [c.findtext("sign") for c in first.iter("clef") if c.get("number", "1") == "2"]
        assert first.tag == "attributes" and clefs == ["F"], f"measure {number}: the lower staff does not start in the bass clef"
