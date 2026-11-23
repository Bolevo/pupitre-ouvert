"""Build a song pack from a work folder.

Usage: python pipeline/build_pack.py scores/<work> [--out DIR]

Work folder layout:
  work.yaml           title, composer, movements [{file, title}], optional parts/lyrics overrides
  <movement>.musicxml one file per movement (MusicXML 3/4, .mxl accepted)

Output (default scores/<work>/pack/):
  pack.json           metadata, parts, measures, notes (see docs/ARCHIVE.md and app/src/pack/types.ts)
  <movement>.mei      MEI with stable xml:ids, rendered by Verovio in the app
  fiche.md            copy of scores/<work>/fiche.md (the work's information sheet), if any

The MEI produced by Verovio is the single source of truth for ids: notes in pack.json
reference the MEI xml:ids, so the app can highlight, seek and score by id.

pack.json only carries what the app reads (app/src/pack/types.ts): the lyrics, staves, layers,
chords and fermatas are in the MEI, which the app renders.
"""
from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

import verovio
import yaml

# Verovio's remarks on the scores it reads ("an expansion cannot be generated…", once per
# repeat) are not ours to act on: only its errors are printed
verovio.enableLog(verovio.LOG_ERROR)

PACK_VERSION = 1
MEI_NS = "http://www.music-encoding.org/ns/mei"
XML_ID = "{http://www.w3.org/XML/1998/namespace}id"
NS = {"m": MEI_NS}
ET.register_namespace("", MEI_NS)
ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

STRESS = "ˈ"  # ˈ marks a stressed syllable in transliteration lyrics

PART_PATTERNS = [
    ("S", re.compile(r"^(sop|sopr|soprano|sopran|canto|s\b|s\.|cantus|treble)", re.I)),
    ("A", re.compile(r"^(alt|alto|contralto|a\b|a\.|altus|mezzo)", re.I)),
    ("T", re.compile(r"^(ten|tenor|ténor|tenore|t\b|t\.)", re.I)),
    ("B", re.compile(r"^(bass|basse|basso|bariton|b\b|b\.)", re.I)),
    ("P", re.compile(r"(piano|organ|orgue|org\.|pf|accomp|keyboard|continuo|clavier|harps|cembalo|réduction|reduction)", re.I)),
]
PART_NAMES_FR = {"S": "Soprano", "A": "Alto", "T": "Ténor", "B": "Basse", "P": "Piano"}


def read_musicxml(path: Path) -> str:
    if path.suffix == ".mxl":
        with zipfile.ZipFile(path) as z:
            container = z.read("META-INF/container.xml").decode()
            root = re.search(r'full-path="([^"]+)"', container).group(1)
            return z.read(root).decode("utf-8")
    return path.read_text(encoding="utf-8")


def musicxml_parts(xml: str) -> list[dict]:
    """Ordered parts with name and staff count, straight from MusicXML."""
    root = ET.fromstring(xml.encode("utf-8"))
    parts = []
    for sp in root.iter("score-part"):
        pid = sp.get("id")
        name = (sp.findtext("part-name") or pid).strip()
        part_el = next(p for p in root.iter("part") if p.get("id") == pid)
        staves = 1
        for st in part_el.iter("staves"):
            staves = max(staves, int(st.text))
        parts.append({"xmlId": pid, "name": name, "staves": staves})
    return parts


def classify_parts(parts: list[dict], overrides: dict | None) -> list[dict]:
    out, used, staff = [], {}, 1
    for p in parts:
        ov = (overrides or {}).get(p["name"]) or (overrides or {}).get(p["xmlId"]) or {}
        pid = ov.get("id")
        if not pid:
            pid = next((k for k, rx in PART_PATTERNS if rx.search(p["name"].strip())), None) or re.sub(r"\W", "", p["name"])[:6] or p["xmlId"]
            if p["staves"] > 1 and pid in "SATB":
                pid = "P"
        base = pid
        used[base] = used.get(base, 0) + 1
        if used[base] > 1:
            pid = f"{base}{used[base]}"
            # first occurrence becomes base+'1' only when duplicates exist
            for q in out:
                if q["id"] == base:
                    q["id"] = f"{base}1"
        kind = ov.get("kind") or ("accomp" if base == "P" or p["staves"] > 1 else "voice")
        name = ov.get("name") or (PART_NAMES_FR.get(base, p["name"]) if base in PART_NAMES_FR and used[base] == 1 else p["name"])
        out.append({"id": pid, "name": name, "sourceName": p["name"], "kind": kind,
                    "staves": list(range(staff, staff + p["staves"]))})
        staff += p["staves"]
    for q in out:  # numbered duplicates keep a readable name
        if re.match(r"^[SATB]\d$", q["id"]):
            q["name"] = f"{PART_NAMES_FR[q['id'][0]]} {q['id'][1]}"
    return out


def sig_fifths(sig: str | None) -> int:
    """Number of sharps (> 0) or flats (< 0) of a MEI keySig ('3s', '2f', '0')."""
    if not sig or sig in ("0", "mixed"):
        return 0
    try:
        n = int(sig[:-1])
    except ValueError:
        return 0
    return n if sig.endswith("s") else -n


def key_tonic(sig: str | None, mode: str | None) -> int:
    """Pitch class of the tonic for a MEI keySig (e.g. '3s', '2f', '0')."""
    major = (sig_fifths(sig) * 7) % 12
    return (major + 9) % 12 if mode == "minor" else major


# Krumhansl-Kessler key profiles (tonic first): used to tell a major key from its relative minor
# when the score does not say (MusicXML exported without <mode>, as all the works here).
KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _correlation(hist: list[float], profile: list[float], tonic: int) -> float:
    p = [profile[(i - tonic) % 12] for i in range(12)]
    mh, mp = sum(hist) / 12, sum(p) / 12
    num = sum((a - mh) * (b - mp) for a, b in zip(hist, p))
    den = (sum((a - mh) ** 2 for a in hist) * sum((b - mp) ** 2 for b in p)) ** 0.5
    return num / den if den else 0.0


def guess_minor(notes: list[dict], fifths: int) -> bool:
    """Is this passage (notes under one key signature) in the relative minor rather than the
    major? Pitch-class durations correlated with both key profiles, plus the bass of the first
    and of the last chord (pieces and sections usually begin and end on their tonic)."""
    if not notes:
        return False
    major = (fifths * 7) % 12
    minor = (major + 9) % 12
    hist = [0.0] * 12
    for n in notes:
        hist[n["midi"] % 12] += n["d"]
    score = _correlation(hist, KK_MINOR, minor) - _correlation(hist, KK_MAJOR, major)
    first = min(n["t"] for n in notes)
    last = max(n["t"] for n in notes)
    for t, w in ((first, 0.05), (last, 0.1)):
        bass = min((n for n in notes if n["t"] <= t < n["t"] + n["d"] or n["t"] == t), key=lambda n: n["midi"])["midi"] % 12
        score += w if bass == minor else -w if bass == major else 0
    return score > 0


# Words that name a tempo (shown with the metronome value); "rit.", "cresc."… are not tempos.
TEMPO_WORDS = re.compile(
    r"^(a tempo|tempo\b|l'istesso|largo|larghetto|lento|adagio|adagietto|andante|andantino|moderato|"
    r"allegretto|allegro|vivace|vivo|presto|prestissimo|grave|maestoso|largamente|sostenuto|"
    r"più mosso|piu mosso|meno mosso|alla breve)", re.I)

CLEF_SIGNS = {"G": "G", "F": "F", "C": "C", "perc": "percussion"}


def _clef_entry(el) -> dict | None:
    """{sign, line, octave?} of a MEI clef (element or clef.* attributes of a staffDef)."""
    if localname(el) == "clef":
        shape, line, dis, place = el.get("shape"), el.get("line"), el.get("dis"), el.get("dis.place")
    else:
        shape, line, dis, place = el.get("clef.shape"), el.get("clef.line"), el.get("clef.dis"), el.get("clef.dis.place")
    if not shape or shape not in CLEF_SIGNS:
        return None
    out = {"sign": CLEF_SIGNS[shape], "line": int(line or {"G": 2, "F": 4, "C": 3}.get(shape, 3))}
    if dis in ("8", "15", "22"):
        out["octave"] = {"8": 1, "15": 2, "22": 3}[dis] * (-1 if place == "below" else 1)
    return out


SOUNDING = {"note", "rest", "chord", "mRest", "multiRest", "space", "mSpace", "beatRpt", "halfmRpt", "mRpt"}


def _clef_at_end(layer, clef) -> bool:
    """The clef comes after every note, rest and space of its layer (a change for the next measure)."""
    seen = False
    for x in layer.iter():
        if x is clef:
            seen = True
        elif seen and localname(x) in SOUNDING:
            return False
    return seen


def _add_clef(clefs: dict, staff: int, m: int, entry: dict) -> None:
    lst = clefs.setdefault(str(staff), [])
    if lst and lst[-1]["m"] == m:
        lst.pop()  # two clefs at the same measure (a staffDef then the layer's own): the later wins
    if lst and {k: v for k, v in lst[-1].items() if k != "m"} == entry:
        return
    lst.append({"m": m, **entry})


def _tempo_beat(el) -> float | None:
    """Beat unit (in quarters) of a printed metronome mark, when it is not the quarter note (the
    pipeline writes a quarter when the score gives no unit; the app then uses the time signature)."""
    unit = el.get("mm.unit")
    if not unit or not unit.isdigit() or int(unit) == 4 and not el.get("mm.dots"):
        return None
    q = 4 / int(unit)
    dots = int(el.get("mm.dots") or 0)
    return q * (2 - 0.5 ** dots)


def build_tempos(measures: list[dict], marks: dict, words: dict, first_word: str | None) -> list[dict]:
    """Tempo changes of a movement: {t, m, bpm, beat?, text?}. `bpm` is in quarter notes per
    minute and comes from the timing actually played (the timemap), so the app's tempo display
    always matches what is heard; `beat` and `text` come from the printed marks."""
    out: list[dict] = []
    cur_bpm, cur_text = None, None
    for i, m in enumerate(measures):
        nxt = measures[i + 1] if i + 1 < len(measures) else None
        bpm = None
        if nxt and nxt["t"] > m["t"] and nxt["q"] > m["q"]:
            bpm = round((nxt["q"] - m["q"]) * 60000 / (nxt["t"] - m["t"]), 1)
        mark = marks.get(i)
        if mark and mark.get("bpm"):
            bpm = mark["bpm"]
        if bpm is None:
            bpm = cur_bpm
        if bpm is None:
            continue
        text = words.get(i) or (first_word if i == 0 else None)
        changed = cur_bpm is None or abs(bpm - cur_bpm) > 0.5 or (text and text != cur_text) or mark
        if not changed:
            continue
        if out and out[-1]["m"] == i:
            out.pop()
        e = {"t": m["t"], "m": i, "bpm": int(bpm) if float(bpm).is_integer() else bpm}
        if mark and mark.get("beat"):
            e["beat"] = mark["beat"]
        if text:
            e["text"] = text
        # the same tempo marked again (a printed reminder): nothing changes
        if out and out[-1]["bpm"] == e["bpm"] and out[-1].get("beat") == e.get("beat") and not text:
            cur_bpm = bpm
            continue
        out.append(e)
        cur_bpm, cur_text = bpm, text or cur_text
    return out


def localname(el) -> str:
    return el.tag.split("}")[-1]


def build_movement(work_dir: Path, mv: dict, idx: int, cfg: dict, out_dir: Path) -> dict:
    src = work_dir / mv["file"]
    xml = read_musicxml(src)
    parts = classify_parts(musicxml_parts(xml), cfg.get("parts"))
    staff_part = {s: p["id"] for p in parts for s in p["staves"]}

    _chord_cache.clear()  # keyed by id(): never reuse an entry from a previous movement's tree

    tk = verovio.toolkit()
    tk.setOptions({"xmlIdSeed": 1000 + idx, "xmlIdChecksum": True})
    if not tk.loadData(xml):
        raise RuntimeError(f"Verovio failed to load {src}")
    mei = tk.getMEI({"removeIds": False})
    # The pack is linear: repeats are played once (write them out in the source if needed).
    mei = re.sub(r"<expansion[^>]*/>", "", mei)

    # Reload the MEI itself so every id below comes from the shipped file.
    tk2 = verovio.toolkit()
    tk2.setOptions({"xmlIdSeed": 1000 + idx, "xmlIdChecksum": True})  # deterministic, whatever ran before
    tk2.loadData(mei)
    timemap = tk2.renderToTimemap({"includeMeasures": True, "includeRests": False})

    on_ms, off_ms = {}, {}
    measure_on = {}
    for ev in timemap:
        for i in ev.get("on", []):
            on_ms[i] = ev["tstamp"]
        for i in ev.get("off", []):
            off_ms[i] = ev["tstamp"]
        if "measureOn" in ev:
            measure_on[ev["measureOn"]] = (ev["tstamp"], ev["qstamp"])

    root = ET.fromstring(mei.encode("utf-8"))
    lyric_cfg = {int(k): v for k, v in (cfg.get("lyrics") or {}).items()}

    measures, notes, verses_seen = [], [], set()
    cur_sig, cur_mode = None, None
    cur_meter = (4, 4)
    tie_start, tie_end = set(), set()
    tie_prev = {}  # end note id -> start note id of each MEI <tie> (the real tie chain)
    for tie in root.iter(f"{{{MEI_NS}}}tie"):
        a, b = tie.get("startid", "").lstrip("#"), tie.get("endid", "").lstrip("#")
        tie_start.add(a)
        tie_end.add(b)
        if a and b:
            tie_prev[b] = a

    body = root.find(".//m:music/m:body", NS)
    parent = {c: p for p in body.iter() for c in p}
    clefs: dict[str, list] = {}
    tempo_marks: dict[int, dict] = {}  # measure index -> printed metronome mark
    tempo_words: dict[int, str] = {}  # measure index -> tempo word (Allegro…)
    for el in body.iter():
        name = localname(el)
        # clefs: in a staffDef (start, or a change between measures) or inside a layer (a change
        # within the measure being read); `sameas` clefs repeat another layer's clef
        if name in ("clef", "staffDef") and not el.get("sameas"):
            entry = _clef_entry(el)
            if entry:
                up, staff_n, in_measure, layer = el, None, False, None
                while up is not None and (staff_n is None or not in_measure):
                    if staff_n is None and localname(up) in ("staffDef", "staff"):
                        staff_n = up.get("n")
                    if layer is None and localname(up) == "layer":
                        layer = up
                    in_measure = in_measure or localname(up) == "measure"
                    up = parent.get(up)
                if staff_n and staff_n.isdigit():
                    m = len(measures) - 1 if in_measure else len(measures)
                    # a clef after the last note of its measure prepares the next one (it is
                    # printed before the barline): it is the clef from the next measure on
                    if in_measure and layer is not None and _clef_at_end(layer, el):
                        m += 1
                    _add_clef(clefs, int(staff_n), m, entry)
        if name == "tempo" and measures:
            mi = len(measures) - 1
            mk = tempo_marks.setdefault(mi, {})
            if el.get("midi.bpm"):
                mk["bpm"] = float(el.get("midi.bpm"))
            if _tempo_beat(el):
                mk["beat"] = _tempo_beat(el)
            words = " ".join("".join(el.itertext()).split()).split("=")[0].strip()
            if words and TEMPO_WORDS.match(words) and mi not in tempo_words:
                tempo_words[mi] = words
        if name == "dir" and measures:
            words = " ".join("".join(el.itertext()).split())
            if words and TEMPO_WORDS.match(words) and len(measures) - 1 not in tempo_words:
                tempo_words[len(measures) - 1] = words
        if name in ("scoreDef", "staffDef"):
            ks = el.find("m:keySig", NS)
            if ks is not None and ks.get("sig"):
                cur_sig, cur_mode = ks.get("sig"), ks.get("mode", cur_mode)
            elif el.get("key.sig"):
                cur_sig, cur_mode = el.get("key.sig"), el.get("key.mode", cur_mode)
        if name == "meterSig" and el.get("count"):
            cur_meter = (int(el.get("count").split("+")[0]), int(el.get("unit", "4")))
        elif name in ("scoreDef", "staffDef") and el.get("meter.count"):
            cur_meter = (int(el.get("meter.count").split("+")[0]), int(el.get("meter.unit", "4")))
        if name == "keySig" and el.get("sig"):
            cur_sig, cur_mode = el.get("sig"), el.get("mode", cur_mode)
        if name != "measure":
            continue
        mid = el.get(XML_ID)
        t, q = measure_on.get(mid, (None, None))
        reh = el.find("m:reh", NS)
        mark = "".join(reh.itertext()).strip() if reh is not None else None
        midx = len(measures)
        measures.append({"id": mid, "n": el.get("n"), "t": t, "q": q, "mark": mark or None,
                         "tonic": key_tonic(cur_sig, cur_mode), "minor": cur_mode == "minor",
                         "fifths": sig_fifths(cur_sig), "ts": list(cur_meter),
                         "_mode": cur_mode})
        for staff in el.findall("m:staff", NS):
            sn = int(staff.get("n"))
            part = staff_part.get(sn, f"staff{sn}")
            for layer in staff.findall("m:layer", NS):
                # grace notes and chords are drawn, not timed (no metric value); Verovio's timemap
                # gives them time taken from the main note that follows (up to a whole beat for a
                # grace chord, Taneyev I.164): that note is given back its written onset
                grace_at = None
                for ev in layer.iter():
                    en = localname(ev)
                    if en not in ("chord", "note") or (en == "note" and _in_chord(ev, layer)):
                        continue
                    if ev.get("grace"):
                        first = next((on_ms[n.get(XML_ID)] for n in ([ev] if en == "note" else ev.findall(".//m:note", NS))
                                      if n.get(XML_ID) in on_ms), None)
                        if grace_at is None and first is not None:
                            grace_at = first
                        continue
                    k = len(notes)
                    _add_event(notes, ev, ev.findall(".//m:note", NS) if en == "chord" else [ev], part, sn, midx,
                               on_ms, off_ms, tk2, tie_start, tie_end, verses_seen)
                    for n in notes[k:]:
                        n["layer"] = layer.get("n")
                    if grace_at is not None:
                        for n in notes[k:]:
                            if grace_at < n["t"] <= grace_at + 2000:
                                n["d"] += n["t"] - grace_at
                                n["t"] = grace_at
                        grace_at = None

    tremolos = _slow_tremolos(notes, {p["id"] for p in parts if p["kind"] != "voice"})
    if tremolos:
        where = sorted({measures[x]["n"] for t in tremolos for x in range(t[3], t[4] + 1)}, key=lambda n: (len(n), n))
        print(f"{mv.get('id', f'mv{idx + 1}')}: tremolos played at half their written rate, "
              f"{sum(t[5] for t in tremolos)} strokes in measures {where[0]}-{where[-1]}")
    _merge_ties(notes, tie_prev)
    notes.sort(key=lambda n: (n["t"], n["part"], -n["midi"]))
    for n in notes:
        del n["staff"]  # only needed to merge ties (the app maps parts to staves via parts[].staves)
        n.pop("layer", None)  # only needed to find the tremolos
    duration = max((n["t"] + n["d"] for n in notes), default=0)
    for i, m in enumerate(measures):  # measures without onsets (full rests) get interpolated times
        if m["t"] is None:
            prev = measures[i - 1] if i else None
            m["t"] = prev["t"] if prev else 0
            m["q"] = prev["q"] if prev else 0

    # the key's name, when work.yaml gives it (`keys: [{m: printed measure, name: "si mineur"}]`);
    # tonic and mode (metronome pitches) from it, else from the MEI's mode, else guessed
    keys = key_names(measures, mv.get("keys"))
    set_modes(measures, notes, {measures[k["m"]]["n"]: k["name"] for k in keys})
    tempos = build_tempos(measures, tempo_marks, tempo_words, mv.get("tempo"))

    # Lyrics lines present
    lyric_lines = []
    for n in sorted(verses_seen):
        c = lyric_cfg.get(n, {})
        lyric_lines.append({"n": n, "id": c.get("id", f"v{n}"), "label": c.get("label", "Texte" if n == 1 else f"Couplet {n}"),
                            "lang": c.get("lang")})

    for p in parts:
        if p["kind"] != "voice":
            continue
        rng = [n["midi"] for n in notes if n["part"] == p["id"]]
        p["range"] = [min(rng), max(rng)] if rng else None

    mei_clean = clean_mei(root)
    mei_name = f"{mv.get('id', f'mv{idx + 1}')}.mei"
    (out_dir / mei_name).write_text(mei_clean, encoding="utf-8")

    return {
        "id": mv.get("id", f"mv{idx + 1}"),
        "title": mv.get("title", ""),
        "mei": mei_name,
        "parts": parts,
        "lyricLines": lyric_lines,
        "measures": measures,
        "notes": notes,
        "durationMs": duration,
        "clefs": clefs,
        "tempos": tempos,
        **({"keys": keys} if keys else {}),
    }


FR_STEPS = {"do": 0, "ré": 2, "re": 2, "mi": 4, "fa": 5, "sol": 7, "la": 9, "si": 11}


def parse_key_name(name: str | None) -> tuple[int, bool] | None:
    """(tonic pitch class, minor) of a French key name: 'si mineur', 'Ré♭ majeur', 'fa dièse mineur'."""
    if not name:
        return None
    m = re.match(r"^\s*(do|ré|re|mi|fa|sol|la|si)\s*(♯|#|dièse|♭|b\b|bémol)?\s*(majeur|mineur)", name, re.I)
    if not m:
        return None
    pc = FR_STEPS[m.group(1).lower()]
    acc = (m.group(2) or "").lower()
    pc += 1 if acc in ("♯", "#", "dièse") else -1 if acc in ("♭", "b", "bémol") else 0
    return pc % 12, m.group(3).lower() == "mineur"


def key_names(measures: list[dict], cfg) -> list[dict]:
    """work.yaml `keys` ([{m: printed measure number, name}]) as [{m: measure index, name}];
    `name: null` = from there on, the key's name is not known (the app shows the signature only)."""
    out = []
    index = {m["n"]: i for i, m in enumerate(measures)}
    for k in cfg or []:
        i = index.get(str(k.get("m", 1)))
        if i is None:
            raise ValueError(f"work.yaml keys: no measure {k.get('m')}")
        name = k.get("name")
        if name is not None and parse_key_name(name) is None:
            raise ValueError(f"work.yaml keys: cannot read the key name {name!r}")
        out.append({"m": i, "name": name})
    return sorted(out, key=lambda k: k["m"])


def set_modes(measures: list[dict], notes: list[dict], names: dict | None = None) -> None:
    """Sets `tonic` and `minor` of each measure, passage by passage (a passage = consecutive
    measures under one key signature). `names`: {printed measure number: key name or None} for
    the passage starting there (work.yaml); a passage without a known name keeps the MEI's mode,
    or else the one guessed from its notes."""
    by_n = {str(k): v for k, v in (names or {}).items()}
    start = 0
    while start < len(measures):
        end = start
        while end + 1 < len(measures) and measures[end + 1]["fifths"] == measures[start]["fifths"] \
                and measures[end + 1]["_mode"] == measures[start]["_mode"] and measures[end + 1]["n"] not in by_n:
            end += 1
        fifths = measures[start]["fifths"]
        named = parse_key_name(by_n.get(measures[start]["n"]))
        mode = measures[start]["_mode"]
        if named is None and mode not in ("major", "minor"):
            passage = [n for n in notes if start <= n["m"] <= end]
            mode = "minor" if guess_minor(passage, fifths) else "major"
        for m in measures[start:end + 1]:
            if named:
                m["tonic"], m["minor"] = named
            else:
                m["minor"] = mode == "minor"
                m["tonic"] = key_tonic(f"{abs(fifths)}{'s' if fifths >= 0 else 'f'}", mode)
            del m["_mode"]
        start = end + 1


def _in_chord(note, layer) -> bool:
    # ElementTree has no parent pointers; chords are handled from the chord element.
    return note in _chord_children(layer)


_chord_cache: dict[int, set] = {}


def _chord_children(layer) -> set:
    key = id(layer)
    if key not in _chord_cache:
        _chord_cache[key] = {n for c in layer.iter(f"{{{MEI_NS}}}chord") for n in c.iter(f"{{{MEI_NS}}}note")}
    return _chord_cache[key]


def _verses(ev, chord_notes) -> set[int]:
    """Lyric verse numbers sung on this event (the lyrics themselves are rendered from the MEI)."""
    out = set()
    for h in [ev] + [n for n in chord_notes if n is not ev]:
        for verse in h.findall("m:verse", NS):
            if verse.find("m:syl", NS) is not None:
                out.add(int(verse.get("n", "1")))
    return out


def _add_event(notes, ev, chord_notes, part, staff, midx, on_ms, off_ms, tk, tie_start, tie_end, verses_seen):
    verses_seen.update(_verses(ev, chord_notes))
    for nt in chord_notes:
        # a small note (MusicXML <cue/>) is drawn, never played: the printed note kept in grey
        # beside the note that corrects it
        if "true" in (nt.get("cue"), ev.get("cue")):
            continue
        nid = nt.get(XML_ID)
        if nid not in on_ms:
            continue  # notes inside tied continuations have no onset in the timemap
        midi = tk.getMIDIValuesForElement(nid).get("pitch")
        if midi is None:
            continue
        t = on_ms[nid]
        d = max(1, off_ms.get(nid, t) - t)
        tie = "i" if (nid in tie_start or nt.get("tie") in ("i", "m")) else None
        cont = nid in tie_end or nt.get("tie") in ("t", "m")
        notes.append({
            "id": nid, "part": part, "staff": staff, "m": midx, "sp": _spelling(nt),
            "t": t, "d": d, "midi": midi,
            **({"tie": tie} if tie else {}),
            **({"cont": True} if cont else {}),
        })


SOLFEGE = {"c": "do", "d": "re", "e": "mi", "f": "fa", "g": "sol", "a": "la", "b": "si"}


def _spelling(nt) -> str:
    """French note name with its sounding accidental: 'do', 'fas' (fa sharp), 'sib' (si flat)."""
    name = SOLFEGE.get((nt.get("pname") or "").lower(), "")
    acc = nt.get("accid.ges") or nt.get("accid")
    for a in nt.iter(f"{{{MEI_NS}}}accid"):
        acc = a.get("accid.ges") or a.get("accid") or acc
    return name + {"s": "s", "f": "b", "ss": "s", "x": "s", "ff": "b"}.get(acc or "", "")


# A tremolo written out stroke by stroke (Taneyev II.31-46, III.164-177: demisemiquavers where the
# print has the tremolo's abbreviation, 18 strokes a second in each hand) is played at half its
# written rate. Nobody plays it that fast, it sounds like a machine, and it is by far the heaviest
# thing the app has to play: up to 76 notes to start in one second, which a locked phone does not
# always manage without small gaps (reported on 2026-11-22).
TREMOLO_MS = 70  # strokes closer than this are a tremolo (more than 14 a second)...
TREMOLO_MIN = 8  # ...when at least this many follow one another


def _slow_tremolos(notes, parts: set[str]) -> list[tuple]:
    """Play the written-out tremolos of the accompaniment (`parts`) at half their rate.
    A tremolo: in one layer of a staff, at least TREMOLO_MIN strokes of the same short length, one
    right after the other, repeating one chord or alternating two (A B A B...). Of each pair of
    strokes one is played, for the length of both, at the time of the first: A, then B, then A...
    The score is not touched (the MEI keeps every stroke); the heads of the strokes left out join
    the `ids` of a played note of the same pitch, so that each head drawn still belongs to a note.
    A B is played where an A is drawn: it is marked `moved`, for the app not to take the place of
    its head for the place of its time (the line of the piano would shake).
    Returns the tremolos found: (part, staff, layer, first measure, last measure, strokes)."""
    layers: dict[tuple, dict[int, list[dict]]] = {}
    for n in notes:
        if n["part"] in parts:
            layers.setdefault((n["part"], n["staff"], n.get("layer")), {}).setdefault(n["t"], []).append(n)
    found, left_out = [], set()
    for (part, staff, layer), by_t in layers.items():
        evs = [by_t[t] for t in sorted(by_t)]
        pitches = [frozenset(n["midi"] for n in e) for e in evs]
        short = [all(n["d"] == e[0]["d"] and not n.get("tie") and not n.get("cont") for n in e) and e[0]["d"] < TREMOLO_MS
                 for e in evs]

        def follows(j: int) -> bool:  # struck as the stroke before ends, and as long as it
            a, b = evs[j - 1][0], evs[j][0]
            return abs(a["t"] + a["d"] - b["t"]) <= 2 and abs(a["d"] - b["d"]) <= 2

        i = 0
        while i < len(evs):
            j = i + 1
            while short[i] and j < len(evs) and short[j] and follows(j) and (j < i + 2 or pitches[j] == pitches[j - 2]):
                j += 1
            if j - i < TREMOLO_MIN:
                i += 1
                continue
            run, played, rests = evs[i:j], [], []
            for k in range(0, len(run) - 1, 2):  # a last stroke without its pair stays as written
                first, second = run[k], run[k + 1]
                t, end, m = first[0]["t"], second[0]["t"] + second[0]["d"], first[0]["m"]
                alternate = pitches[i + k] != pitches[i + k + 1] and (k // 2) % 2 == 1
                play, rest = (second, first) if alternate else (first, second)
                for n in play:
                    n["t"], n["d"], n["m"] = t, end - t, m
                    if alternate:  # played one stroke before the place where its head is drawn
                        n["moved"] = True
                played.append(play)
                rests.append(rest)
            for k, rest in enumerate(rests):
                for r in rest:
                    left_out.add(id(r))
                    # with the played stroke of the same pitch in its group of four (A B A B)
                    order = (k, k + 1, k - 1) if k % 2 == 0 else (k, k - 1, k + 1)
                    near = [played[x] for x in order if 0 <= x < len(played)]
                    owner = next((n for ev in near for n in ev if n["midi"] == r["midi"]), None)
                    if owner is not None:
                        owner.setdefault("ids", [owner["id"]]).append(r["id"])
            found.append((part, staff, layer, run[0][0]["m"], run[-1][0]["m"], len(run)))
            i = j
    notes[:] = [n for n in notes if id(n) not in left_out]
    return found


def _merge_ties(notes, tie_prev: dict[str, str] | None = None):
    """Fold tie continuations into their start note (sung/played as one sound).
    The chain is followed through the MEI <tie> links when there are some (`tie_prev`: end id ->
    start id): another layer of the same staff re-striking the same pitch in between must not
    break it (Taneyev III.27, III.54). Without a link, the last note of the same part, staff and
    pitch is taken (tie attributes on the notes)."""
    tie_prev = tie_prev or {}
    by_key = {}
    owner = {}  # note id -> the kept note whose sound includes it
    keep = []
    seen = set()
    for n in sorted(notes, key=lambda x: x["t"]):
        if n["id"] in seen:  # the same note reached twice
            continue
        seen.add(n["id"])
        key = (n["part"], n["staff"], n["midi"])
        if n.get("cont"):
            linked = owner.get(tie_prev.get(n["id"], ""))
            prev = linked if linked is not None and linked["midi"] == n["midi"] else by_key.get(key)
            if prev and prev["t"] <= n["t"] and n["t"] + n["d"] <= prev["t"] + prev["d"] + 30:
                prev.setdefault("ids", [prev["id"]]).append(n["id"])  # already inside a tie chain
                owner[n["id"]] = prev
                continue
            if prev and (prev.get("tie") or linked is prev) and abs(prev["t"] + prev["d"] - n["t"]) < 30:
                prev["d"] = n["t"] + n["d"] - prev["t"]
                prev.setdefault("ids", [prev["id"]]).append(n["id"])
                owner[n["id"]] = prev
                if not n.get("tie"):
                    prev.pop("tie", None)
                else:
                    prev["tie"] = n["tie"]
                continue
        n.pop("cont", None)
        keep.append(n)
        by_key[key] = n
        owner[n["id"]] = n
    for n in keep:
        n.pop("cont", None)
        n.pop("tie", None)
    notes[:] = _merge_unisons(keep)


def _merge_unisons(notes):
    """One sound per (part, onset, pitch): two layers of a staff often share a note head.
    (Verovio's timemap reports such shared notes inconsistently from run to run.)"""
    best = {}
    order = []
    for n in notes:
        key = (n["part"], n["t"], n["midi"])
        b = best.get(key)
        if b is None:
            best[key] = n
            order.append(key)
            continue
        keep, drop = (n, b) if n["d"] > b["d"] else (b, n)
        keep.setdefault("ids", [keep["id"]])
        for i in drop.get("ids", [drop["id"]]):
            if i not in keep["ids"]:
                keep["ids"].append(i)
        best[key] = keep
    return [best[k] for k in order]


# MEI elements whose text is shown: whitespace inside them is never touched
TEXT_ELEMENTS = {"syl", "rend", "dir", "tempo", "reh", "dynam", "label", "labelAbbr", "harm", "fing",
                 "title", "persName", "name", "date", "p", "lb", "annot", "ref", "num", "text"}


def strip_indentation(root) -> None:
    """Drop the indentation Verovio writes between elements (about half of each MEI file, parsed
    again by the app at every render). Only whitespace-only runs containing a line break are
    removed, and never inside or around an element whose text is shown (syllables, directions,
    labels): the rendered SVG is unchanged."""
    for el in root.iter():
        if localname(el) in TEXT_ELEMENTS:
            continue
        if el.text is not None and not el.text.strip() and "\n" in el.text:
            el.text = None
        for c in el:
            if c.tail is not None and not c.tail.strip() and "\n" in c.tail:
                c.tail = None


def clean_mei(root) -> str:
    """Strip page headers and turn stress markers into bold syllables. The output is deterministic
    for a given score: Verovio's encoding timestamp is dropped (it changed every MEI at every
    build, so every published work looked updated and was downloaded again by each device).
    The indentation between elements is removed (see strip_indentation)."""
    for app in root.iter(f"{{{MEI_NS}}}application"):
        app.attrib.pop("isodate", None)
    for pg in list(root.iter(f"{{{MEI_NS}}}pgHead")) + list(root.iter(f"{{{MEI_NS}}}pgFoot")):
        for parent in root.iter():
            if pg in list(parent):
                parent.remove(pg)
                break
    # short staff names on following systems (some exporters write "Ch" for every choir staff)
    for sd in root.iter(f"{{{MEI_NS}}}staffDef"):
        lab = sd.find("m:label", NS)
        abbr = sd.find("m:labelAbbr", NS)
        if lab is not None and abbr is not None and (lab.text or "").strip():
            name = lab.text.strip()
            abbr.text = name[0] + "." if name.split()[0].lower() in ("soprano", "alto", "tenor", "bass", "basse", "ténor") else abbr.text
    for syl in root.iter(f"{{{MEI_NS}}}syl"):
        if syl.text and STRESS in syl.text:
            txt = syl.text.replace(STRESS, "")
            syl.text = None
            rend = ET.SubElement(syl, f"{{{MEI_NS}}}rend", {"fontweight": "bold"})
            rend.text = txt
    strip_indentation(root)
    return ET.tostring(root, encoding="unicode", xml_declaration=False)


def build(work_dir: Path, out_dir: Path | None = None) -> Path:
    cfg = yaml.safe_load((work_dir / "work.yaml").read_text(encoding="utf-8"))
    out_dir = out_dir or work_dir / "pack"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.mei"):
        old.unlink()
    movements = []
    by_number = {}  # movement number in work.yaml (1-based) -> pack movement id
    for i, mv in enumerate(cfg["movements"]):
        if not (work_dir / mv["file"]).exists():   # draft work.yaml: movement not compiled yet
            print(f"skip {work_dir.name}/{mv['file']}: not found")
            continue
        movements.append(build_movement(work_dir, mv, i, cfg, out_dir))
        by_number[i + 1] = movements[-1]["id"]
    pages = []
    pages_dir = work_dir / "pages"
    if (pages_dir / "pages.json").exists():
        import shutil
        (out_dir / "pages").mkdir(exist_ok=True)
        for old in (out_dir / "pages").glob("*.webp"):
            old.unlink()
        for pg in json.loads((pages_dir / "pages.json").read_text(encoding="utf-8")):
            for m in pg["measures"]:
                m["mv"] = by_number.get(m["mv"])
            pg["measures"] = [m for m in pg["measures"] if m["mv"]]
            if not pg["measures"]:   # page of a movement not compiled yet
                continue
            shutil.copy2(pages_dir / pg["img"], out_dir / "pages" / pg["img"])
            pg["img"] = "pages/" + pg["img"]
            pages.append(pg)
    pack = {
        "version": PACK_VERSION,
        "id": cfg["id"],
        "title": cfg["title"],
        "composer": cfg.get("composer", ""),
        "notice": cfg.get("notice", ""),
        "defaultPart": cfg.get("defaultPart"),
        "movements": movements,
        "pages": pages,
    }
    # the work's information sheet (structure, text and translation), shown by the app
    fiche = work_dir / "fiche.md"
    if fiche.exists():
        (out_dir / "fiche.md").write_bytes(fiche.read_bytes())
        pack["fiche"] = "fiche.md"
    elif (out_dir / "fiche.md").exists():
        (out_dir / "fiche.md").unlink()
    (out_dir / "pack.json").write_text(json.dumps(pack, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return out_dir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work", type=Path)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    out = build(a.work, a.out)
    pack = json.loads((out / "pack.json").read_text(encoding="utf-8"))
    for mv in pack["movements"]:
        print(f"{mv['id']}: {len(mv['measures'])} measures, {len(mv['notes'])} notes, "
              f"parts {[p['id'] for p in mv['parts']]}, "
              f"{mv['durationMs'] / 1000:.0f} s")


if __name__ == "__main__":
    main()
