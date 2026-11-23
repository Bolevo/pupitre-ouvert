"""Compile .cht pages into MusicXML 4 (music21).

    python pipeline/cht/compile.py scores/<work>             # every movement -> scores/<work>/mvtN.musicxml
    python pipeline/cht/compile.py scores/<work> 1           # movement 1 only
    python pipeline/cht/compile.py scores/<work> 1 -o out.musicxml

Parts: "Soprano", "Alto", "Tenor" (treble-8 clef, sounding pitches), "Bass",
"Piano" (one part, two staves); a 'part S <name>' header renames a vocal part
(soloists). A movement only gets the vocal parts that sing in it, and the piano
only if it plays in it (none: a cappella).
Lyrics: one verse per line of the 'lyrics' header, in order, named by its
code (default 'lyrics ru tr': verse 1 name="ru", verse 2 name="translit";
'lyrics la': verse 1 name="la"). Stressed syllables ('*') are prefixed with
U+02C8.
"""
from __future__ import annotations

import argparse
import re
import sys
import dataclasses
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from music21 import (bar, clef, duration, dynamics, expressions, instrument,  # noqa: E402
                     key, layout, meter, note, chord, stream, tempo, tie)

from pipeline.cht.parse import (CHOIR, Context, Event, Measure, Page,  # noqa: E402
                                movement_files, parse_file)

STRESS = "ˈ"
EXTEND = "⁣"          # private marker -> <extend/> after export
PART_NAMES = {"S": "Soprano", "A": "Alto", "T": "Tenor", "B": "Bass"}
CLEF_OF = {"S": clef.TrebleClef, "A": clef.TrebleClef, "T": clef.Treble8vbClef,
           "B": clef.BassClef, "PR": clef.TrebleClef, "PL": clef.BassClef}
CLEF_NAMES = {"treble": clef.TrebleClef, "bass": clef.BassClef, "treble8vb": clef.Treble8vbClef}
# a vocal staff renamed by 'part' takes the clef of its name: `part S "Ténor I"` (men's choir
# written in the S A T B lines) is a tenor's staff, `part T "Baryton"` a bass staff
_CLEF_BY_NAME = [("sopr", clef.TrebleClef), ("alt", clef.TrebleClef), ("mezz", clef.TrebleClef),
                 ("ten", clef.Treble8vbClef), ("tén", clef.Treble8vbClef),
                 ("bas", clef.BassClef), ("bar", clef.BassClef)]


def clef_of(voice: str, names: dict[str, str] | None):
    name = ((names or {}).get(voice) or "").lower()
    return next((c for k, c in _CLEF_BY_NAME if name.startswith(k)), CLEF_OF[voice])
TYPE_OF = {1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "16th", 32: "32nd", 64: "64th"}
DYN_TEXT = {"cresc": "cresc.", "dim": "dim."}


@dataclass
class Options:
    parts: tuple[str, ...] = ("S", "A", "T", "B", "PR", "PL")   # staves to include
    system_breaks: bool = False
    measures: tuple[int, int] | None = None                    # inclusive range filter
    title: str | None = None
    part_names: dict[str, str] | None = None                   # 'part' headers: S -> "Soprano I"


def _pitch(p) -> str:
    acc = {0: "", 1: "#", 2: "##", -1: "-", -2: "--"}[p.alter]
    return f"{p.step.upper()}{acc}{p.octave}"


def _duration(ev: Event) -> duration.Duration:
    d = duration.Duration(type=TYPE_OF[ev.base], dots=ev.dots)
    if ev.tuplet:
        t = duration.Tuplet(ev.tuplet[0], ev.tuplet[1], durationActualType=TYPE_OF[ev.base])
        if ev.tuplet_pos:
            t.type = ev.tuplet_pos
        d.appendTuplet(t)
    return d


class TieTracker:
    """Pending ties per voice: pitches (midi) tied from the previous event."""

    def __init__(self):
        self.open: dict[str, set[int]] = {}

    def apply(self, voice: str, ev: Event, n) -> None:
        prev = self.open.get(voice, set())
        notes = [n] if isinstance(n, note.Note) else list(n.notes)
        nxt = set()
        for p, tied, nn in zip(ev.pitches, ev.ties, notes):
            stop = p.midi in prev
            if stop and tied:
                nn.tie = tie.Tie("continue")
            elif stop:
                nn.tie = tie.Tie("stop")
            elif tied:
                nn.tie = tie.Tie("start")
            if tied:
                nxt.add(p.midi)
        self.open[voice] = nxt

    def rest(self, voice: str) -> None:
        self.open[voice] = set()


VERSE_NAMES = {"tr": "translit"}


def _lyric_queues(m: Measure, voice: str, langs) -> list[tuple[int, str, list]]:
    """[(verse number, verse name, syllables)] in the order of the 'lyrics' header."""
    return [(i + 1, VERSE_NAMES.get(lang, lang), list(m.lyrics.get((voice, lang), [])))
            for i, lang in enumerate(langs)]


class LyricState:
    """Running syllabic state per (voice, verse) across measures."""

    def __init__(self):
        self.in_word: dict[tuple[str, int], bool] = {}
        self.last: dict[tuple[str, int], note.Lyric] = {}

    def attach(self, voice: str, n, syl, number: int, name: str, stress_mark: bool) -> None:
        k = (voice, number)
        if syl.melisma:
            last = self.last.get(k)
            if last is not None and not last.text.endswith(EXTEND):
                last.text += EXTEND
            return
        text = syl.text
        if stress_mark and syl.stressed:
            text = STRESS + text
        cont = self.in_word.get(k, False)
        if cont and syl.hyphen:
            syllabic = "middle"
        elif cont:
            syllabic = "end"
        elif syl.hyphen:
            syllabic = "begin"
        else:
            syllabic = "single"
        ly = note.Lyric(text=text, number=number, syllabic=syllabic, identifier=name)
        n.lyrics.append(ly)
        self.in_word[k] = syl.hyphen
        self.last[k] = ly


def _make_event(ev: Event, mdur: Fraction):
    if ev.kind == "note":
        if len(ev.pitches) == 1:
            n = note.Note(_pitch(ev.pitches[0]))
        else:
            n = chord.Chord([_pitch(p) for p in ev.pitches])
        n.duration = _duration(ev)
    elif ev.kind == "mrest":
        n = note.Rest(quarterLength=float(mdur))
        n.fullMeasure = True
    else:
        n = note.Rest()
        n.duration = _duration(ev)
        if ev.kind == "space":
            n.style.hideObjectOnPrint = True
    if ev.fermata:
        n.expressions.append(expressions.Fermata())
    return n


class Builder:
    def __init__(self, opts: Options):
        self.o = opts
        self.ties = TieTracker()
        self.lyr = LyricState()
        self.staves: dict[str, stream.Part] = {}
        for v in opts.parts:
            p = stream.PartStaff() if v in ("PR", "PL") else stream.Part()
            if v in PART_NAMES:
                p.partName = (opts.part_names or {}).get(v) or PART_NAMES[v]
                p.insert(0, instrument.Choir())
            self.staves[v] = p
        if "PR" in self.staves:
            self.staves["PR"].partName = "Piano"
            self.staves["PR"].insert(0, instrument.Piano())
        self.ctx = Context()
        self.langs: tuple[str, ...] = ("ru", "tr")
        self.first = True
        self.skipped = False
        self.top = opts.parts[0]

    # -- one measure of one staff
    def _voice_into(self, container, voice: str, evs: list[Event], mdur: Fraction, m: Measure,
                    vocal: bool) -> None:
        queues = _lyric_queues(m, voice, self.langs)
        prev_tied = self.ties.open.get(voice, set())
        for ev in evs:
            if ev.kind == "clef":
                container.append(CLEF_NAMES[ev.clef]())
                continue
            n = _make_event(ev, mdur)
            for d in ev.dynamics:
                if d in DYN_TEXT:
                    te = expressions.TextExpression(DYN_TEXT[d])
                    te.style.fontStyle = "italic"
                    container.insert(_offset(container), te)
                else:
                    container.insert(_offset(container), dynamics.Dynamic(d))
            if ev.kind == "note":
                attack = not all(p.midi in prev_tied for p in ev.pitches)
                self.ties.apply(voice, ev, n)
                prev_tied = self.ties.open.get(voice, set())
                if vocal and attack:
                    for number, name, q in queues:
                        if q:
                            self.lyr.attach(voice, n, q.pop(0), number, name, True)
            else:
                self.ties.rest(voice)
                prev_tied = set()
            container.append(n)
        # melisma syllables after the last attack would be extra: ignored (check.py reports)

    def add_measure(self, page: Page, m: Measure, new_page: bool) -> None:
        before = (self.ctx.key, self.ctx.time)
        self.langs = page.lyric_langs
        if new_page:
            self.ctx.apply(page.meta)      # page context (not printed)
        self.ctx.apply(m.meta)             # change printed at this measure
        mdur = self.ctx.measure_dur(m)
        if self.o.measures and not (self.o.measures[0] <= m.number <= self.o.measures[1]):
            self._skip(m)
            return
        key_changed = self.first or before[0] != self.ctx.key
        time_changed = self.first or before[1] != self.ctx.time
        shown = m.meta if (m.meta and (m.meta.tempo is not None or m.meta.text)) else None
        if self.first and not self.skipped and page.meta is not None:
            # opening tempo, only at the real start. The first measure may print the tempo word on
            # its own `meta text=` line while the value is on the page's `meta` line (Taneyev II:
            # "Andante sostenuto", ♩ = 72): the value must not be lost (it played at Verovio's 120).
            if shown is None:
                shown = page.meta
            elif shown.tempo is None and page.meta.tempo is not None:
                shown = dataclasses.replace(shown, tempo=page.meta.tempo, beat=shown.beat or page.meta.beat)
        for v, part in self.staves.items():
            meas = stream.Measure(number=m.number)
            if self.first:
                meas.append(clef_of(v, self.o.part_names)())
            if key_changed:
                meas.append(key.KeySignature(self.ctx.key))
            if time_changed:
                meas.append(meter.TimeSignature(f"{self.ctx.time[0]}/{self.ctx.time[1]}"))
            if self.o.system_breaks and m.system is not None and not self.first:
                meas.insert(0, layout.SystemLayout(isNew=True))
            if shown is not None and v in (self.top, "PR"):
                self._tempo(meas, shown)
            if v == self.top and m.mark:
                meas.insert(0, expressions.RehearsalMark(m.mark))
            self._fill(meas, v, m, mdur)
            part.append(meas)
        self.first = False

    def _fill(self, meas, v: str, m: Measure, mdur: Fraction) -> None:
        vocal = v in CHOIR
        v1 = m.voices.get(v) or [Event("mrest")]
        v2 = m.voices.get(v + "2")
        piano = v in ("PR", "PL")
        base = 4 if v == "PL" else 0
        if v2 or piano:
            # explicit voices; piano staff 2 uses voices 5/6 (unique within the part)
            for vid, evs, name in ((base + 1, v1, v), (base + 2, v2, v + "2")):
                if evs is None:
                    continue
                vo = stream.Voice(id=str(vid))
                self._voice_into(vo, name, evs, mdur, m, vocal)
                meas.insert(0, vo)
        else:
            self._voice_into(meas, v, v1, mdur, m, vocal)
        if piano:
            try:
                meas.makeBeams(inPlace=True)
            except Exception:   # noqa: BLE001 - beaming is cosmetic
                pass

    def _skip(self, m: Measure) -> None:
        """Measure outside the requested range: keep tie state in sync only."""
        self.skipped = True
        for v in self.o.parts:
            for vv in (v, v + "2"):
                for ev in m.voices.get(vv, []):
                    if ev.kind == "note":
                        n = note.Note() if len(ev.pitches) == 1 else chord.Chord([_pitch(p) for p in ev.pitches])
                        self.ties.apply(vv, ev, n)
                    elif ev.kind != "clef":
                        self.ties.rest(vv)

    def _tempo(self, meas, meta) -> None:
        """Tempo is stored in quarter notes per minute; `beat` only changes the
        printed referent (beat=2, tempo=288 prints 'half = 144')."""
        if meta.tempo is not None:
            beat = meta.beat or "4"
            ref = duration.Duration(type=TYPE_OF[int(beat.rstrip("."))], dots=beat.count("."))
            shown = meta.tempo / ref.quarterLength
            mm = tempo.MetronomeMark(text=meta.text, number=round(shown, 1) if shown % 1 else int(shown),
                                     referent=ref)
            mm.placement = "above"
            meas.insert(0, mm)
        elif meta.text:
            te = expressions.TextExpression(meta.text)
            te.style.fontWeight = "bold"
            te.placement = "above"
            meas.insert(0, te)

    def score(self) -> stream.Score:
        sc = stream.Score()
        for v in self.o.parts:
            sc.insert(0, self.staves[v])
        if "PR" in self.staves and "PL" in self.staves:
            sc.insert(0, layout.StaffGroup([self.staves["PR"], self.staves["PL"]],
                                           name="Piano", symbol="brace", barTogether=True))
        choir = [self.staves[v] for v in CHOIR if v in self.staves]
        if len(choir) > 1:
            sc.insert(0, layout.StaffGroup(choir, symbol="bracket", barTogether=False))
        if self.o.title:
            from music21 import metadata
            sc.metadata = metadata.Metadata(title=self.o.title)
        return sc


def _offset(container) -> float:
    return float(container.highestTime)


def part_names(pages: list[Page]) -> dict[str, str]:
    names: dict[str, str] = {}
    for pg in pages:
        for v, nm in pg.parts.items():
            names.setdefault(v, nm)
    return names


def sung_voices(pages: list[Page]) -> tuple[str, ...]:
    """Staves of a movement: the vocal parts with at least one note, then the piano (both
    staves) if it has one (none: a cappella)."""
    used = {v.rstrip("2") for pg in pages for m in pg.measures for v, evs in m.voices.items()
            if any(e.kind == "note" for e in evs)}
    piano = ("PR", "PL") if used & {"PR", "PL"} else ()
    return tuple(v for v in CHOIR if v in used) + piano


def build(pages: list[Page], opts: Options | None = None) -> stream.Score:
    opts = opts or Options()
    if opts.part_names is None:
        opts.part_names = part_names(pages)
    b = Builder(opts)
    for pg in pages:
        for i, m in enumerate(pg.measures):
            b.add_measure(pg, m, new_page=(i == 0))
    return b.score()


def postprocess(xml: str) -> str:
    """music21 export fix-ups: lyric extend markers -> <extend/>; tempo words,
    metronome and rehearsal marks placed above the staff."""
    xml = re.sub(r"<text>([^<]*?)" + EXTEND + r"</text>", r"<text>\1</text>\n          <extend />", xml)
    xml = xml.replace(EXTEND, "")

    def place(m: re.Match) -> str:
        block = m.group(0)
        if re.search(r"<(words|metronome|rehearsal)\b", block) and "<dynamics" not in block:
            return block.replace("<direction>", '<direction placement="above">', 1)
        return block
    return re.sub(r"<direction>.*?</direction>", place, xml, flags=re.S)


def to_musicxml(sc: stream.Score) -> str:
    from music21.musicxml.m21ToXml import GeneralObjectExporter
    data = GeneralObjectExporter(sc).parse()
    return postprocess(data.decode("utf-8"))


def xml_is_source(work: Path, movement: int) -> bool:
    """work.yaml marks the movement `source: musicxml`: its MusicXML is maintained directly (corrected
    beyond what the CHT pages hold) and must not be overwritten by a compilation."""
    import yaml
    cfg = work / "work.yaml"
    if not cfg.exists():
        return False
    for mv in (yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}).get("movements", []):
        if mv.get("file") == f"mvt{movement}.musicxml":
            return mv.get("source") == "musicxml"
    return False


def compile_movement(work: Path, movement: int, out: Path | None = None, force: bool = False) -> Path:
    if out is None and xml_is_source(work, movement) and not force:
        raise SystemExit(f"mvt{movement}.musicxml is the maintained source (work.yaml: source: musicxml); "
                         "compile to another file with -o, or use --force to overwrite it")
    pages = movement_files(work / "src", movement)
    if not pages:
        raise SystemExit(f"no .cht page for movement {movement} in {work / 'src'}")
    sc = build(pages, Options(parts=sung_voices(pages), title=f"Movement {movement}"))
    out = out or work / f"mvt{movement}.musicxml"
    out.write_text(to_musicxml(sc), encoding="utf-8")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("work", type=Path, help="score folder (scores/<work>)")
    ap.add_argument("movement", type=int, nargs="?", help="default: every movement of src/")
    ap.add_argument("-o", "--out", type=Path)
    ap.add_argument("--force", action="store_true", help="overwrite a MusicXML marked `source: musicxml`")
    a = ap.parse_args(argv)
    movements = [a.movement] if a.movement is not None else sorted({p.movement for p in movement_files(a.work / "src") if p.movement})
    if not movements:
        raise SystemExit(f"no .cht page in {a.work / 'src'}")
    if a.out and len(movements) > 1:
        raise SystemExit("-o needs one movement")
    for mv in movements:
        print(f"wrote {compile_movement(a.work, mv, a.out, a.force)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
