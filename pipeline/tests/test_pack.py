"""Song pack builder: MEI cleaning."""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_pack import clean_mei  # noqa: E402

MEI = """<mei xmlns="http://www.music-encoding.org/ns/mei">
   <meiHead>
      <encodingDesc>
         <appInfo>
            <application isodate="2026-10-26T10:00:00" version="6.3.0">
               <name>Verovio</name>
            </application>
         </appInfo>
      </encodingDesc>
   </meiHead>
   <music>
      <body>
         <measure n="1">
            <staff n="1">
               <layer n="1">
                  <note xml:id="n1" pname="c" oct="4" dur="4">
                     <verse n="1">
                        <syl wordpos="i" con="d">Glo</syl>
                     </verse>
                  </note>
                  <note xml:id="n2" pname="d" oct="4" dur="4">
                     <verse n="1">
                        <syl wordpos="t">ˈri a</syl>
                     </verse>
                  </note>
               </layer>
            </staff>
            <dir staff="1" tstamp="1">
               <rend fontweight="bold">Allegro</rend> <rend>molto</rend>
            </dir>
         </measure>
      </body>
   </music>
</mei>"""


def test_clean_mei_drops_indentation_keeps_text():
    out = clean_mei(ET.fromstring(MEI))
    assert "\n" not in out.split("<dir")[0]  # no indentation left between elements
    assert "isodate" not in out  # deterministic output
    assert '<syl wordpos="i" con="d">Glo</syl></verse></note>' in out
    # stressed syllable: bold, marker removed, inner space kept
    assert '<rend fontweight="bold">ri a</rend>' in out
    # text elements are left exactly as they were (their spacing may be shown)
    assert '<rend fontweight="bold">Allegro</rend> <rend>molto</rend>' in out
    assert "<dir" in out and "\n               <rend" in out
    # same elements otherwise (plus the <rend> of the stressed syllable)
    tags = lambda root: [e.tag.split("}")[-1] for e in root.iter()]
    assert sorted(tags(ET.fromstring(out))) == sorted(tags(ET.fromstring(MEI)) + ["rend"])


# ---------- score information carried by the pack (clefs, tempos, keys, fiche) ----------
import json  # noqa: E402
import shutil  # noqa: E402

import pytest  # noqa: E402

from build_pack import _clef_entry, build, build_tempos, guess_minor, key_names, parse_key_name, set_modes, sig_fifths  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def mei_el(xml: str):
    return ET.fromstring(xml.replace("<clef ", '<clef xmlns="http://www.music-encoding.org/ns/mei" ').replace(
        "<staffDef ", '<staffDef xmlns="http://www.music-encoding.org/ns/mei" '))


def test_sig_fifths():
    assert [sig_fifths(s) for s in ("3s", "2f", "0", None, "mixed")] == [3, -2, 0, 0, 0]


def test_clef_entry_reads_elements_and_attributes():
    assert _clef_entry(mei_el('<clef shape="G" line="2" dis="8" dis.place="below"/>')) == {"sign": "G", "line": 2, "octave": -1}
    assert _clef_entry(mei_el('<clef shape="F" line="4"/>')) == {"sign": "F", "line": 4}
    assert _clef_entry(mei_el('<staffDef n="1" clef.shape="C" clef.line="3"/>')) == {"sign": "C", "line": 3}
    assert _clef_entry(mei_el('<staffDef n="1"/>')) is None


def test_tempos_follow_the_timing_and_keep_the_printed_words():
    # 4/4 measures: 2000 ms each at 120, then 2400 ms (100) from the 3rd (index 2)
    ms = [{"t": t, "q": q} for t, q in [(0, 0), (2000, 4), (4000, 8), (6400, 12), (8800, 16)]]
    out = build_tempos(ms, {2: {"bpm": 100.0}}, {0: "Allegro", 2: "Moderato"}, "Fallback")
    assert out == [{"t": 0, "m": 0, "bpm": 120, "text": "Allegro"}, {"t": 4000, "m": 2, "bpm": 100, "text": "Moderato"}]
    # the timing alone (no printed mark) is enough to see the change
    assert [e["bpm"] for e in build_tempos(ms, {}, {}, None)] == [120, 100]
    # no word in the score: the first tempo takes work.yaml's
    assert build_tempos(ms[:3], {}, {}, "Allegro")[0]["text"] == "Allegro"
    # a printed beat unit (half note) is kept, in quarters
    assert build_tempos(ms[:3], {0: {"bpm": 120.0, "beat": 2.0}}, {}, None)[0]["beat"] == 2.0


def test_mode_guess_tells_relative_minor_from_major():
    def chord(t, *midis):
        return [{"t": t, "d": 1000, "midi": m} for m in midis]
    # B minor (2 sharps): B-D-F#, A#, ends on B
    bm = chord(0, 47, 62, 66) + chord(1000, 54, 58, 61) + chord(2000, 47, 62, 66)
    assert guess_minor(bm, 2)
    # D major: D-F#-A, A-C#-E, D
    dm = chord(0, 50, 66, 69) + chord(1000, 45, 61, 64) + chord(2000, 50, 66, 69)
    assert not guess_minor(dm, 2)


def test_set_modes_by_passage_with_names():
    ms = [{"n": str(i + 1), "fifths": 2 if i < 2 else -1, "_mode": None} for i in range(4)]
    notes = [{"t": 0, "d": 100, "midi": 62, "m": 0}, {"t": 100, "d": 100, "midi": 65, "m": 2}]
    set_modes(ms, notes, {"3": "ré mineur"})
    assert [(m["tonic"], m["minor"]) for m in ms] == [(2, False), (2, False), (2, True), (2, True)]  # D major, D minor
    assert "_mode" not in ms[0]


def test_key_names_from_work_yaml():
    assert parse_key_name("si mineur") == (11, True)
    assert parse_key_name("Ré♭ majeur") == (1, False)
    assert parse_key_name("fa dièse mineur") == (6, True)
    assert parse_key_name("la mineur → mi") == (9, True)
    ms = [{"n": str(i + 1)} for i in range(40)]
    assert key_names(ms, [{"m": 31, "name": None}, {"m": 1, "name": "Ré♭ majeur"}]) == [{"m": 0, "name": "Ré♭ majeur"}, {"m": 30, "name": None}]
    with pytest.raises(ValueError):
        key_names(ms, [{"m": 1, "name": "Ré"}])


@pytest.fixture(scope="module")
def bach_pack(tmp_path_factory):
    work = tmp_path_factory.mktemp("bach")
    for f in ("work.yaml", "choral1.musicxml", "choral2.musicxml"):   # the example work, without its pages
        shutil.copy(ROOT / "scores" / "deux-chorals" / f, work / f)
    (work / "fiche.md").write_text("# Fiche\n\n## Choral\n", encoding="utf-8")
    out = build(work, work / "pack")
    return work, out, json.loads((out / "pack.json").read_text(encoding="utf-8"))


def test_pack_carries_clefs_tempos_keys_and_fiche(bach_pack):
    work, out, pack = bach_pack
    mv = pack["movements"][0]
    assert mv["clefs"]["1"][0] == {"m": 0, "sign": "G", "line": 2}
    assert mv["clefs"]["4"][0]["sign"] == "F"
    assert mv["tempos"][0]["m"] == 0 and mv["tempos"][0]["bpm"] > 0
    assert all("fifths" in m and "_mode" not in m for m in mv["measures"])
    assert pack["fiche"] == "fiche.md"
    assert (out / "fiche.md").read_text(encoding="utf-8").startswith("# Fiche")
    # deterministic, and a removed fiche leaves no stale copy
    (work / "fiche.md").unlink()
    again = json.loads((build(work, out) / "pack.json").read_text(encoding="utf-8"))
    assert "fiche" not in again and not (out / "fiche.md").exists()
    assert again["movements"] == pack["movements"]


def test_a_clef_after_the_last_note_belongs_to_the_next_measure():
    from build_pack import _clef_at_end
    ns = 'xmlns="http://www.music-encoding.org/ns/mei"'
    end = ET.fromstring(f'<layer {ns}><note/><beam><note/><note/></beam><clef shape="G" line="2"/></layer>')
    mid = ET.fromstring(f'<layer {ns}><note/><clef shape="G" line="2"/><beam><note/></beam></layer>')
    assert _clef_at_end(end, end.find("{http://www.music-encoding.org/ns/mei}clef"))
    assert not _clef_at_end(mid, mid.find("{http://www.music-encoding.org/ns/mei}clef"))


def test_merge_ties_follows_mei_tie_links_across_a_restruck_unison():
    """Taneyev III.27: la3 tied over the barline while another layer of the same staff strikes
    la3 in between; the continuation belongs to the tied note (no re-attack)."""
    from build_pack import _merge_ties
    base = {"part": "P", "staff": 2, "midi": 57, "m": 0, "sp": "la"}
    notes = [
        {**base, "id": "a", "t": 0, "d": 1000, "tie": "i"},
        {**base, "id": "b", "t": 500, "d": 250},           # other layer, same pitch
        {**base, "id": "c", "t": 1000, "d": 1000, "cont": True},
    ]
    _merge_ties(notes, {"c": "a"})
    by = {n["id"]: n for n in notes}
    assert set(by) == {"a", "b"}
    assert by["a"]["d"] == 2000 and by["a"]["ids"] == ["a", "c"]
    assert by["b"]["d"] == 250


CORRECTED = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Bass</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><key><fifths>3</fifths></key>
<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>
<note><pitch><step>G</step><alter>1</alter><octave>3</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type>
<lyric number="1"><syllabic>begin</syllabic><text>ди</text></lyric><lyric number="2"><syllabic>begin</syllabic><text>ˈdi</text></lyric></note>
<note color="#7A3FD0"><pitch><step>C</step><alter>1</alter><octave>3</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type>
<lyric number="1"><syllabic>end</syllabic><text>ла</text></lyric><lyric number="2" color="#7A3FD0"><syllabic>end</syllabic><text>la</text></lyric></note>
<note color="#B4B4B4"><cue/><chord/><pitch><step>A</step><octave>2</octave></pitch><duration>2</duration><voice>1</voice><type size="cue">quarter</type></note>
<note><pitch><step>F</step><alter>1</alter><octave>3</octave></pitch><duration>4</duration><voice>1</voice><type>half</type></note>
</measure></part></score-partwise>"""


def test_a_corrected_note_is_played_and_the_printed_one_is_only_drawn(tmp_path):
    """A place where the app does not follow the printed edition (Taneyev I.75, basses): the note
    sung is written in colour, the printed one stays beside it as a small grey note (<cue/>).
    The pack plays one note there; the MEI the app engraves keeps both, and the colours."""
    (tmp_path / "work.yaml").write_text(
        'id: t\ntitle: T\nmovements:\n  - {file: m.musicxml, id: m1, title: M}\n'
        'lyrics:\n  1: {id: ru, label: Russe}\n  2: {id: tr, label: Phonétique}\n', encoding="utf-8")
    (tmp_path / "m.musicxml").write_text(CORRECTED, encoding="utf-8")
    out = build(tmp_path, tmp_path / "pack")
    mv = json.loads((out / "pack.json").read_text(encoding="utf-8"))["movements"][0]
    assert [n["midi"] for n in mv["notes"]] == [56, 49, 54]          # G sharp, C sharp (not the printed A), F sharp
    assert [n["sp"] for n in mv["notes"]] == ["sols", "dos", "fas"]
    assert mv["parts"][0]["range"] == [49, 56]                       # the printed note is not in the range
    assert [line["n"] for line in mv["lyricLines"]] == [1, 2]
    mei = ET.parse(out / mv["mei"]).getroot()
    ns = "{http://www.music-encoding.org/ns/mei}"
    chord = mei.find(f".//{ns}chord")
    drawn = {(n.get("pname"), n.get("oct")): n for n in chord.findall(f"{ns}note")}
    assert drawn[("c", "3")].get("color") == "#7A3FD0" and drawn[("c", "3")].get("cue") is None
    assert drawn[("a", "2")].get("color") == "#B4B4B4" and drawn[("a", "2")].get("cue") == "true"
    assert drawn[("c", "3")].get("{http://www.w3.org/XML/1998/namespace}id") == mv["notes"][1]["id"]
    assert [v.get("color") for v in chord.findall(f"{ns}verse")] == [None, "#7A3FD0"]   # the corrected syllable


def _strokes(chords, t=0, d=50, layer="1", prefix="s"):
    """One stroke after the other, each a chord (list of MIDI pitches), `d` ms long."""
    return [{"id": f"{prefix}{i}.{p}", "part": "P", "staff": 5, "layer": layer, "m": 0, "sp": "", "t": t + i * d, "d": d, "midi": p}
            for i, ch in enumerate(chords) for p in ch]


def test_a_written_out_tremolo_is_played_at_half_its_rate():
    """Taneyev II.32: two chords alternating in demisemiquavers, 18 strokes a second in each hand.
    Of each pair of strokes one is played, for the length of both: A, B, A, B at half the rate.
    Every head drawn still belongs to a played note of its pitch."""
    from build_pack import _slow_tremolos
    a, b = [64, 68], [61]
    notes = _strokes([a, b] * 4)
    found = _slow_tremolos(notes, {"P"})
    assert found == [("P", 5, "1", 0, 0, 8)]
    assert [(n["t"], n["d"], n["midi"]) for n in notes] == [
        (0, 100, 64), (0, 100, 68), (100, 100, 61), (200, 100, 64), (200, 100, 68), (300, 100, 61)]
    assert [n["ids"] for n in notes] == [
        ["s0.64", "s2.64"], ["s0.68", "s2.68"], ["s3.61", "s1.61"],     # the four strokes of a group: A B A B
        ["s4.64", "s6.64"], ["s4.68", "s6.68"], ["s7.61", "s5.61"]]
    # a B sounds where an A is drawn: the app does not align its line on that head
    assert [n.get("moved") for n in notes] == [None, None, True, None, None, True]


def test_a_repeated_note_tremolo_too_and_an_odd_last_stroke_stays():
    from build_pack import _slow_tremolos
    notes = _strokes([[61]] * 9)
    _slow_tremolos(notes, {"P"})
    assert [(n["t"], n["d"]) for n in notes] == [(0, 100), (100, 100), (200, 100), (300, 100), (400, 50)]
    assert [n.get("ids") for n in notes] == [["s0.61", "s1.61"], ["s2.61", "s3.61"], ["s4.61", "s5.61"], ["s6.61", "s7.61"], None]
    assert not any(n.get("moved") for n in notes)   # each is played where its first head is drawn


def test_only_tremolos_are_slowed():
    """Left as written: the voices, strokes a pianist can play (fewer than 14 a second), a run of
    fewer than eight, notes that neither repeat nor alternate, and the other layers of the staff."""
    from build_pack import _slow_tremolos
    same = lambda notes: [(n["id"], n["t"], n["d"]) for n in notes]  # noqa: E731
    for case in (
        [{**n, "part": "T"} for n in _strokes([[64], [61]] * 8)],            # a voice
        _strokes([[64], [61]] * 8, d=75),                                    # 13 strokes a second
        _strokes([[64], [61]] * 3 + [[64]]),                                 # seven strokes
        _strokes([[60], [62], [64], [65], [67], [69], [71], [72], [74]]),    # a fast scale
    ):
        before = same(case)
        assert _slow_tremolos(case, {"P"}) == [] and same(case) == before
    held = {"id": "held", "part": "P", "staff": 5, "layer": "2", "m": 0, "sp": "", "t": 0, "d": 400, "midi": 40}
    notes = _strokes([[64], [61]] * 4) + [held]
    _slow_tremolos(notes, {"P"})
    assert len(notes) == 5 and held in notes and held["d"] == 400 and "ids" not in held


def _tremolo_score() -> str:
    def note(step, octave, dur, typ, alter=0, chord=False, beam=""):
        return (f"<note>{'<chord/>' if chord else ''}<pitch><step>{step}</step>{f'<alter>{alter}</alter>' if alter else ''}"
                f"<octave>{octave}</octave></pitch><duration>{dur}</duration><voice>1</voice><type>{typ}</type>{beam}</note>")
    a = note("E", 4, 1, "32nd") + note("G", 4, 1, "32nd", alter=1, chord=True)
    b = note("C", 4, 1, "32nd", alter=1)
    attrs = ('<attributes><divisions>8</divisions><key><fifths>4</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>'
             '<clef><sign>G</sign><line>2</line></clef></attributes><direction><sound tempo="138"/></direction>')
    tenor = (a + b) * 8 + note("E", 4, 16, "half")                                           # a singer's notes are never touched
    piano = (a + b) * 8 + (note("E", 4, 2, "16th") + note("C", 4, 2, "16th", alter=1)) * 4 + note("E", 4, 8, "quarter")
    return ('<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list>'
            '<score-part id="P1"><part-name>Tenor</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part>'
            f'</part-list><part id="P1"><measure number="1">{attrs}{tenor}</measure></part>'
            f'<part id="P2"><measure number="1">{attrs}{piano}</measure></part></score-partwise>')


def test_the_pack_plays_the_tremolo_slower_and_the_score_keeps_every_stroke(tmp_path):
    (tmp_path / "work.yaml").write_text('id: t\ntitle: T\nmovements:\n  - {file: m.musicxml, id: m1, title: M}\n', encoding="utf-8")
    (tmp_path / "m.musicxml").write_text(_tremolo_score(), encoding="utf-8")
    out = build(tmp_path, tmp_path / "pack")
    mv = json.loads((out / "pack.json").read_text(encoding="utf-8"))["movements"][0]
    assert {p["id"]: p["kind"] for p in mv["parts"]} == {"T": "voice", "P": "accomp"}
    tenor = [n for n in mv["notes"] if n["part"] == "T"]
    piano = [n for n in mv["notes"] if n["part"] == "P"]
    beat = 60000 / 138
    assert len(tenor) == 25 and min(n["d"] for n in tenor) < 60               # the voice: every demisemiquaver
    tremolo = [n for n in piano if n["t"] < 2 * beat - 5]
    onsets = sorted({n["t"] for n in tremolo})
    assert len(onsets) == 8 and all(abs(t - k * beat / 4) <= 2 for k, t in enumerate(onsets))   # semiquavers
    assert all(abs(n["d"] - beat / 4) <= 2 and len(n["ids"]) == 2 for n in tremolo)
    assert [sorted(n["midi"] for n in tremolo if n["t"] == t) for t in onsets] == [[64, 68], [61]] * 4
    rest = [n for n in piano if n["t"] >= 2 * beat - 5]
    assert len(rest) == 9 and all("ids" not in n for n in rest)               # written semiquavers: as they are
    mei = ET.parse(out / mv["mei"]).getroot()
    ns, xid = "{http://www.music-encoding.org/ns/mei}", "{http://www.w3.org/XML/1998/namespace}id"
    drawn = {n.get(xid) for st in mei.iter(f"{ns}staff") if st.get("n") == "2" for n in st.iter(f"{ns}note")}
    assert len(drawn) == 33 and drawn == {i for n in piano for i in n.get("ids", [n["id"]])}


SILENT_END = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Tenor</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time>
<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef></attributes>
<direction><sound tempo="60"/></direction>
<note><pitch><step>G</step><octave>3</octave></pitch><duration>3</duration><type>half</type><dot/></note></measure>
<measure number="2"><note><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
<note><rest/><duration>2</duration><type>half</type></note></measure>
<measure number="3"><note><rest measure="yes"/><duration>3</duration></note></measure>
<measure number="4"><note><rest measure="yes"/><duration>3</duration></note></measure>
</part></score-partwise>
"""


def test_a_movement_ends_with_its_last_measure_even_when_the_voices_are_silent_there(tmp_path):
    """The voices alone, under a closing ritornello that was not transcribed: the last note ends
    in measure 2, the movement goes on to the end of measure 4 (the archive was refused before:
    'durationMs is not after the last measure's start')."""
    (tmp_path / "work.yaml").write_text('id: t\ntitle: T\nmovements:\n  - {file: m.musicxml, id: m1, title: M}\n', encoding="utf-8")
    (tmp_path / "m.musicxml").write_text(SILENT_END, encoding="utf-8")
    out = build(tmp_path, tmp_path / "pack")
    mv = json.loads((out / "pack.json").read_text(encoding="utf-8"))["movements"][0]
    assert [m["t"] for m in mv["measures"]] == [0, 3000, 6000, 9000]
    assert mv["durationMs"] == 12000
    sys.path.insert(0, str(ROOT / "pipeline"))
    import check_pack
    errors, _warnings, _info = check_pack.check(check_pack.read_archive(out))
    assert errors == []
