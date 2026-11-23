"""Parser for .cht transcription files (see docs/CHT_FORMAT.md).

Pure Python (no music21) so that check.py stays fast. Durations are
fractions of a quarter note (quarterLength).
"""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

VOICES = ("S", "A", "T", "B", "PR", "PL")
ALL_VOICES = VOICES + tuple(v + "2" for v in VOICES)
CHOIR = ("S", "A", "T", "B")
LYRIC_LANGS = ("ru", "tr")          # default lyric lines (Taneyev) when no 'lyrics' header
_LANG = re.compile(r"^[a-z]{2,8}$")
DYNAMICS = {"ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fz", "fp", "cresc", "dim"}
CLEFS = {"G": "treble", "F": "bass", "G8": "treble8vb"}

_PITCH = re.compile(r"^([a-g])(##|#|bb|b)?(-?\d)$")
_DUR = re.compile(r"^(1|2|4|8|16|32|64)(\.{0,3})$")
_TOKEN = re.compile(r"\{?<[^>]*>\S*|\S+")      # a chord '<a3 c#4>:4~' is one token
_STEP = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
_ALTER = {None: 0, "#": 1, "##": 2, "b": -1, "bb": -2}


class ChtError(Exception):
    def __init__(self, msg: str, path: str = "?", line: int = 0):
        super().__init__(f"{path}:{line}: {msg}")
        self.msg, self.path, self.line = msg, path, line


@dataclass(frozen=True)
class Pitch:
    step: str          # 'a'..'g'
    alter: int         # -2..2
    octave: int

    @classmethod
    def parse(cls, s: str) -> "Pitch":
        m = _PITCH.match(s)
        if not m:
            raise ValueError(f"bad pitch '{s}'")
        return cls(m.group(1), _ALTER[m.group(2)], int(m.group(3)))

    @property
    def midi(self) -> int:
        return 12 * (self.octave + 1) + _STEP[self.step] + self.alter

    def __str__(self) -> str:
        acc = {0: "", 1: "#", 2: "##", -1: "b", -2: "bb"}[self.alter]
        return f"{self.step}{acc}{self.octave}"


@dataclass
class Event:
    kind: str                       # note | rest | mrest | space | clef
    dur: Fraction = Fraction(0)     # sounding length in quarter notes
    base: int = 4                   # notated value: 1,2,4,8,16,32
    dots: int = 0
    pitches: list[Pitch] = field(default_factory=list)
    ties: list[bool] = field(default_factory=list)      # per pitch: tie to next
    fermata: bool = False
    dynamics: list[str] = field(default_factory=list)
    tuplet: tuple[int, int] | None = None               # (actual, normal)
    tuplet_pos: str | None = None                       # start | stop | None
    clef: str | None = None
    line: int = 0

    @property
    def sung(self) -> bool:
        return self.kind == "note"


@dataclass
class Syllable:
    text: str          # displayed text ('+' already turned into spaces), '' for melisma
    hyphen: bool       # word continues on the next syllable
    melisma: bool      # '_' : extends the previous syllable
    stressed: bool     # '*' : underlined in the print (translit)


@dataclass
class Meta:
    key: int | None = None
    time: tuple[int, int] | None = None
    tempo: float | None = None
    beat: str | None = None          # tempo referent as a duration ('4', '2', '4.')
    text: str | None = None
    line: int = 0


@dataclass
class Measure:
    number: int
    line: int
    mark: str | None = None
    dur: Fraction | None = None              # explicit (partial measure)
    meta: Meta | None = None                 # change applied before this measure
    system: int | None = None                # a new system starts here
    voices: dict[str, list[Event]] = field(default_factory=dict)
    voice_lines: dict[str, int] = field(default_factory=dict)
    lyrics: dict[tuple[str, str], list[Syllable]] = field(default_factory=dict)
    lyric_lines: dict[tuple[str, str], int] = field(default_factory=dict)


@dataclass
class Page:
    path: str
    page: int | None = None
    movement: int | None = None
    meta: Meta | None = None              # initial context (mandatory)
    measures: list[Measure] = field(default_factory=list)
    lyrics: tuple[str, ...] | None = None  # 'lyrics la' header: lyric lines, in verse order
    parts: dict[str, str] = field(default_factory=dict)   # 'part S Soprano I': staff/part names

    @property
    def lyric_langs(self) -> tuple[str, ...]:
        return self.lyrics or LYRIC_LANGS


# ---------------------------------------------------------------- tokens

def strip_comment(line: str) -> str:
    """'#' starts a comment at line start or after whitespace ('f#4' is a pitch)."""
    m = re.search(r"(^|\s)#", line)
    return line[:m.start()] if m else line


def parse_duration(s: str) -> tuple[int, int, Fraction]:
    m = _DUR.match(s)
    if not m:
        raise ValueError(f"bad duration '{s}'")
    base, dots = int(m.group(1)), len(m.group(2))
    q = Fraction(4, base)
    total = q * (2 - Fraction(1, 2 ** dots))
    return base, dots, total


def _normal_of(actual: int) -> int:
    n = 1
    while n * 2 < actual:
        n *= 2
    return n


def parse_note_token(tok: str, measure_dur: Fraction | None) -> Event:
    """One event token: a3:4 a3:4.~ <a3 c#4>:2 <a3~ c#4>:2 r:8 R R^ s:4 clef:F"""
    if tok.startswith("clef:"):
        c = tok[5:]
        if c not in CLEFS:
            raise ValueError(f"unknown clef '{c}' (G, F, G8)")
        return Event("clef", clef=CLEFS[c])
    fermata = tok.endswith("^")
    core = tok[:-1] if fermata else tok
    if core == "R":
        return Event("mrest", dur=measure_dur or Fraction(0), fermata=fermata)
    tie_all = core.endswith("~")
    if tie_all:
        core = core[:-1]
    if core.startswith("<"):
        close = core.find(">")
        if close < 0 or core[close + 1:close + 2] != ":":
            raise ValueError(f"bad chord '{tok}'")
        inner, dur_s = core[1:close], core[close + 2:]
        names = inner.split()
        if not names:
            raise ValueError("empty chord")
        pitches, ties = [], []
        for nm in names:
            t = nm.endswith("~")
            pitches.append(Pitch.parse(nm[:-1] if t else nm))
            ties.append(t or tie_all)
        base, dots, d = parse_duration(dur_s)
        return Event("note", d, base, dots, pitches, ties, fermata)
    name, sep, dur_s = core.partition(":")
    if not sep:
        raise ValueError(f"missing ':duration' in '{tok}'")
    base, dots, d = parse_duration(dur_s)
    if name == "r":
        return Event("rest", d, base, dots, fermata=fermata)
    if name == "s":
        return Event("space", d, base, dots)
    p = Pitch.parse(name)
    return Event("note", d, base, dots, [p], [tie_all], fermata)


def parse_music(text: str, measure_dur: Fraction | None) -> list[Event]:
    """Content of a voice line -> events (tuplets resolved, dynamics attached)."""
    out: list[Event] = []
    pending_dyn: list[str] = []
    tup: tuple[int, int] | None = None
    tup_start = 0
    tokens = _TOKEN.findall(text)
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if tok.startswith("{<"):            # '{3 <a c>:8' written as '{<a c>:8' is not allowed
            raise ValueError("write the tuplet number: '{3 <..>:8 ...}'")
        if tok.startswith("{"):
            if tup:
                raise ValueError("nested tuplet")
            spec = tok[1:]
            a, _, n = spec.partition(":")
            if not a.isdigit():
                raise ValueError(f"bad tuplet '{tok}'")
            tup = (int(a), int(n) if n else _normal_of(int(a)))
            tup_start = len(out)
            continue
        closing = tok.endswith("}") and tok != "}"
        if tok == "}":
            closing, tok = True, ""
        elif closing:
            tok = tok[:-1]
        if tok.startswith("!"):
            d = tok[1:]
            if d not in DYNAMICS:
                raise ValueError(f"unknown dynamic '{tok}'")
            pending_dyn.append(d)
        elif tok:
            ev = parse_note_token(tok, measure_dur)
            if tup and ev.kind in ("note", "rest", "space"):
                ev.tuplet = tup
                ev.dur = ev.dur * tup[1] / tup[0]
            if pending_dyn and ev.kind != "clef":
                ev.dynamics, pending_dyn = pending_dyn, []
            out.append(ev)
        if closing:
            if not tup:
                raise ValueError("'}' without '{'")
            group = [e for e in out[tup_start:] if e.tuplet]
            if group:
                group[0].tuplet_pos = "start"
                group[-1].tuplet_pos = "stop" if len(group) > 1 else "start"
            tup = None
    if tup:
        raise ValueError("unclosed tuplet '{'")
    if pending_dyn:
        raise ValueError("dynamic without a following note")
    return out


def parse_lyrics(text: str, lang: str) -> list[Syllable]:
    out = []
    for tok in text.split():
        if tok == "_":
            out.append(Syllable("", False, True, False))
            continue
        stressed = tok.startswith("*")
        if stressed:
            tok = tok[1:]
        hyphen = tok.endswith("-") and len(tok) > 1
        if hyphen:
            tok = tok[:-1]
        out.append(Syllable(tok.replace("+", " "), hyphen, False, stressed))
    return out


def parse_meta(rest: str, line: int) -> Meta:
    meta = Meta(line=line)
    for item in shlex.split(rest):
        k, sep, v = item.partition("=")
        if not sep:
            raise ValueError(f"bad meta item '{item}'")
        if k == "key":
            meta.key = int(v)
        elif k == "time":
            a, _, b = v.partition("/")
            meta.time = (int(a), int(b))
        elif k == "tempo":
            meta.tempo = float(v)
        elif k == "beat":
            parse_duration(v)
            meta.beat = v
        elif k == "text":
            meta.text = v
        else:
            raise ValueError(f"unknown meta '{k}'")
    return meta


# ---------------------------------------------------------------- files

def time_dur(time: tuple[int, int]) -> Fraction:
    return Fraction(4 * time[0], time[1])


def parse_text(text: str, path: str = "?") -> Page:
    page = Page(path=path)
    cur: Measure | None = None
    pending_meta: Meta | None = None
    pending_system: int | None = None
    time: tuple[int, int] | None = None
    for ln, raw in enumerate(text.splitlines(), 1):
        line = strip_comment(raw).strip()
        if not line:
            continue
        try:
            if "|" in line:
                if cur is None:
                    raise ValueError("voice line before any 'm N'")
                head, _, body = line.partition("|")
                head = head.strip()
                voice, _, lang = head.partition(".")
                if voice not in ALL_VOICES:
                    raise ValueError(f"unknown voice '{voice}'")
                if lang:
                    if lang not in page.lyric_langs:
                        raise ValueError(f"unknown lyric line '{head}' (this page declares "
                                         f"'lyrics {' '.join(page.lyric_langs)}')")
                    if (voice, lang) in cur.lyrics:
                        raise ValueError(f"duplicate line '{head}'")
                    cur.lyrics[(voice, lang)] = parse_lyrics(body, lang)
                    cur.lyric_lines[(voice, lang)] = ln
                else:
                    if voice in cur.voices:
                        raise ValueError(f"duplicate voice '{voice}' in measure {cur.number}")
                    mdur = cur.dur or (time_dur(time) if time else None)
                    evs = parse_music(body, mdur)
                    for e in evs:
                        e.line = ln
                    cur.voices[voice] = evs
                    cur.voice_lines[voice] = ln
                continue
            word, _, rest = line.partition(" ")
            if word == "page":
                page.page = int(rest)
            elif word == "movement":
                page.movement = int(rest)
            elif word == "lyrics":
                if page.measures:
                    raise ValueError("'lyrics' belongs to the header (before the first 'm N')")
                langs = tuple(rest.split())
                if not langs or not all(_LANG.match(x) for x in langs) or len(set(langs)) != len(langs):
                    raise ValueError("expected 'lyrics <code> [<code>...]', e.g. 'lyrics la' or 'lyrics ru tr'")
                page.lyrics = langs
            elif word == "part":
                if page.measures:
                    raise ValueError("'part' belongs to the header (before the first 'm N')")
                items = shlex.split(rest)
                if len(items) < 2 or items[0] not in VOICES or items[0] in ("PR", "PL"):
                    raise ValueError("expected 'part <S|A|T|B> <name>', e.g. 'part A \"Soprano II\"'")
                page.parts[items[0]] = " ".join(items[1:])
            elif word == "meta":
                meta = parse_meta(rest, ln)
                if page.meta is None and not page.measures:
                    if meta.key is None or meta.time is None or meta.tempo is None:
                        raise ValueError("first 'meta' must give key, time and tempo")
                    page.meta = meta
                elif cur is not None and not cur.voices and not cur.lyrics:
                    # 'meta' right after 'm N' (before its voices) belongs to that measure
                    if cur.meta is not None:
                        raise ValueError("two 'meta' lines for one measure: merge them")
                    cur.meta = meta
                else:
                    pending_meta = meta
                if meta.time:
                    time = meta.time
            elif word == "system":
                pending_system = int(rest)
            elif word == "m":
                parts = rest.split()
                if not parts or not parts[0].lstrip("-").isdigit():
                    raise ValueError("expected 'm <number>'")
                if page.meta is None:
                    raise ValueError("'meta key=.. time=.. tempo=..' must precede the first measure")
                cur = Measure(int(parts[0]), ln, meta=pending_meta, system=pending_system)
                pending_meta = pending_system = None
                for opt in parts[1:]:
                    k, _, v = opt.partition("=")
                    if k == "mark":
                        cur.mark = v
                    elif k == "dur":
                        a, _, b = v.partition("/")
                        cur.dur = Fraction(4 * int(a), int(b))
                    else:
                        raise ValueError(f"unknown measure option '{opt}'")
                page.measures.append(cur)
            else:
                raise ValueError(f"unknown line '{word}'")
        except ChtError:
            raise
        except ValueError as e:
            raise ChtError(str(e), path, ln) from None
    return page


def parse_file(path: str | Path) -> Page:
    p = Path(path)
    return parse_text(p.read_text(encoding="utf-8"), str(p))


def movement_files(src_dir: str | Path, movement: int | None = None) -> list[Page]:
    """All pages of src_dir (optionally one movement), in page order."""
    pages = [parse_file(f) for f in sorted(Path(src_dir).glob("*.cht"))]
    if movement is not None:
        pages = [p for p in pages if p.movement == movement]
    return sorted(pages, key=lambda p: (p.movement or 0, p.page or 0))


@dataclass
class Context:
    """Running key/time/tempo through a movement."""
    key: int = 0
    time: tuple[int, int] = (4, 4)
    tempo: float = 60
    beat: str | None = None

    def apply(self, meta: Meta | None) -> None:
        if not meta:
            return
        if meta.key is not None:
            self.key = meta.key
        if meta.time is not None:
            self.time = meta.time
        if meta.tempo is not None:
            self.tempo = meta.tempo
            self.beat = meta.beat

    def measure_dur(self, m: Measure) -> Fraction:
        return m.dur if m.dur is not None else time_dur(self.time)


def voice_duration(evs: list[Event], mdur: Fraction) -> Fraction:
    return sum((mdur if e.kind == "mrest" else e.dur) for e in evs if e.kind != "clef")
