"""Print the structural facts of a work, used to write and check scores/<work>/fiche.md.

Usage:  python tools/fiche_data.py [work ...]      (default: every work of scores/)
        python tools/fiche_data.py <work> --words   (also print the full lyric stream per part)
        python tools/fiche_data.py --gap=1          (merge silences shorter than 1 measure only;
                                                     default 4: rests of < 4 measures are ignored)

Sources (read only):
- scores/<work>/work.yaml           titles, tempo words, pages, choir/solo (movements not in the pack too)
- scores/<work>/mvtN.musicxml       key signatures (fifths), time signatures, tempo words, metronome marks,
                                    other text directions (Solo/Tutti...), with their measure numbers
- app/public/packs/<work>/pack.json measures (count, ts, tonic/minor, t ms, q quarters), durationMs,
                                    notes per part (m = measure index)
- app/public/packs/<work>/mvtN.mei  lyric syllables (<verse n><syl wordpos con>) per staff

Keys: the MusicXML has no <mode>, so the pack's `minor` flag is always False. The mode is printed
here from the last chord (lowest note of the bass + all voices' last notes) and must be judged by
a human (e.g. 2 sharps ending on B = si mineur).
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEI_NS = "http://www.music-encoding.org/ns/mei"
NS = {"m": MEI_NS}

MAJOR = {-7: "Do♭", -6: "Sol♭", -5: "Ré♭", -4: "La♭", -3: "Mi♭", -2: "Si♭", -1: "Fa", 0: "Do",
         1: "Sol", 2: "Ré", 3: "La", 4: "Mi", 5: "Si", 6: "Fa♯", 7: "Do♯"}
MINOR = {-7: "la♭", -6: "mi♭", -5: "si♭", -4: "fa", -3: "do", -2: "sol", -1: "ré", 0: "la",
         1: "mi", 2: "si", 3: "fa♯", 4: "do♯", 5: "sol♯", 6: "ré♯", 7: "la♯"}
PC_FR = ["do", "do♯", "ré", "mi♭", "mi", "fa", "fa♯", "sol", "sol♯", "la", "si♭", "si"]
# Metronome marks printed in the score but missing from the MusicXML (the pack then plays the
# default 120): {(work, movement id): {measure n: quarter BPM}}. Better: write them in the score.
PRINTED_TEMPO: dict[tuple[str, str], dict[str, int]] = {}
IGNORE_WORDS = re.compile(r"^(cresc|dim|decresc|poco a poco|crescendo|rit|marcato)", re.I)


def load_yaml(path: Path) -> dict:
    import yaml  # pipeline dependency
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def fmt_ms(ms: float) -> str:
    s = round(ms / 1000)
    return f"{s // 60}:{s % 60:02d}"


def musicxml_facts(path: Path) -> dict:
    """Key/time changes, tempo words, metronome marks and text directions, by measure number."""
    root = ET.parse(path).getroot()
    names = {sp.get("id"): sp.findtext("part-name") for sp in root.iter("score-part")}
    keys, times, tempos, texts = [], [], [], []
    for i, part in enumerate(root.findall("part")):
        pname = names.get(part.get("id"), part.get("id"))
        for m in part.findall("measure"):
            n = m.get("number")
            if i == 0:
                for a in m.iter("attributes"):
                    for k in a.findall("key"):
                        keys.append((n, int(k.findtext("fifths")), k.findtext("mode")))
                    for t in a.findall("time"):
                        times.append((n, f"{t.findtext('beats')}/{t.findtext('beat-type')}"))
            for d in m.iter("direction"):
                words = " ".join(w.text.strip() for w in d.iter("words") if w.text and w.text.strip())
                mm = d.find(".//metronome")
                if mm is not None and i == 0:
                    tempos.append((n, "metronome", f"{mm.findtext('beat-unit')} = {mm.findtext('per-minute')}"))
                if words and not IGNORE_WORDS.match(words):
                    if i == 0:
                        tempos.append((n, "words", words))
                    texts.append((pname, n, words))
    # dedupe successive identical changes
    def dedupe(seq):
        out = []
        for x in seq:
            if not out or x[1:] != out[-1][1:]:
                out.append(x)
        return out
    return {"keys": dedupe(keys), "times": dedupe(times), "tempos": tempos, "texts": texts}


def effective_tempi(measures: list) -> list:
    """Quarter-note BPM actually used by the pack, per segment of constant tempo."""
    segs = []
    for a, b in zip(measures, measures[1:]):
        if a["t"] is None or b["t"] is None or b["t"] == a["t"]:
            continue
        bpm = round((b["q"] - a["q"]) / (b["t"] - a["t"]) * 60000)
        if not segs or abs(segs[-1][1] - bpm) > 1:
            segs.append((a["n"], bpm))
    return segs


def score_tempo_duration(measures: list, printed: dict) -> float:
    """Duration in ms when the pack's tempo segments are replaced by the printed marks."""
    seg = {n: b for n, b in effective_tempi(measures)}
    seg.update(printed)
    total, bpm = 0.0, None
    for i, m in enumerate(measures):
        bpm = seg.get(m["n"], bpm)
        if i + 1 < len(measures):
            dq = measures[i + 1]["q"] - m["q"]
        else:
            dq = m["ts"][0] * 4 / m["ts"][1]
        total += dq / bpm * 60000
    return total


def staff_parts(mv: dict) -> dict:
    return {s: p["id"] for p in mv["parts"] for s in p.get("staves", [])}


def mei_lyrics(path: Path, mv: dict) -> dict:
    """{part: {verse_n: [(measure_n, word), ...]}} built from the syllables (wordpos i/m/t/s)."""
    sp = staff_parts(mv)
    root = ET.parse(path).getroot()
    out: dict = {}
    pending: dict = {}
    for meas in root.iter(f"{{{MEI_NS}}}measure"):
        mn = meas.get("n")
        for staff in meas.findall("m:staff", NS):
            part = sp.get(int(staff.get("n")), f"staff{staff.get('n')}")
            for verse in staff.iter(f"{{{MEI_NS}}}verse"):
                vn = int(verse.get("n", "1"))
                for syl in verse.findall("m:syl", NS):
                    txt = "".join(syl.itertext()).strip()
                    wp = syl.get("wordpos", "s")
                    key = (part, vn)
                    if wp in ("i",):
                        pending[key] = (mn, txt)
                    elif wp == "m":
                        m0, t0 = pending.get(key, (mn, ""))
                        pending[key] = (m0, t0 + txt)
                    else:
                        if wp == "t":
                            m0, t0 = pending.pop(key, (mn, ""))
                            word = (m0, t0 + txt)
                        else:
                            word = (mn, txt)
                        out.setdefault(part, {}).setdefault(vn, []).append(word)
    return out


def norm(w: str) -> str:
    return re.sub(r"[^\w]", "", w.lower())


def phrases(words: list) -> list:
    """Split a word stream at punctuation marks into (first_measure, phrase) items."""
    out, cur, start = [], [], None
    for mn, w in words:
        if start is None:
            start = mn
        cur.append(w)
        if re.search(r"[.,;:!?»]$", w):
            out.append((start, " ".join(cur)))
            cur, start = [], None
    if cur:
        out.append((start, " ".join(cur)))
    return out


def unique_phrases(ph: list) -> list:
    seen, out = OrderedDict(), []
    for mn, p in ph:
        k = " ".join(norm(w) for w in p.split())
        if k and k not in seen:
            seen[k] = True
            out.append((mn, p))
    return out


def sung_ranges(notes: list, measures: list, part: str, gap: int = 4) -> list:
    """Measure-number ranges where `part` has notes (gaps shorter than `gap` measures merged)."""
    idx = sorted({n["m"] for n in notes if n["part"] == part})
    if not idx:
        return []
    ranges, a, b = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - b > gap:
            ranges.append((a, b))
            a = i
        b = i
    ranges.append((a, b))
    return [f"{measures[x]['n']}–{measures[y]['n']}" if x != y else measures[x]["n"] for x, y in ranges]


def last_chord(notes: list, measures: list) -> str:
    last = len(measures) - 1
    while last >= 0 and not any(n["m"] == last for n in notes):
        last -= 1
    fin = [n for n in notes if n["m"] == last]
    tmax = max(n["t"] for n in fin)
    tail = [n for n in fin if n["t"] + n["d"] >= tmax]
    pcs = sorted({PC_FR[n["midi"] % 12] for n in tail})
    bass = min(tail, key=lambda n: n["midi"])
    first = [n for n in notes if n["m"] == min(x["m"] for x in notes)]
    fbass = min(first, key=lambda n: n["midi"])
    return (f"premier son grave {PC_FR[fbass['midi'] % 12]} ; dernier accord (mes. {measures[last]['n']}) : "
            f"basse {PC_FR[bass['midi'] % 12]}, notes {', '.join(pcs)}")


GAP = 4


def report(work: str, show_words: bool) -> None:
    sdir = ROOT / "scores" / work
    pdir = ROOT / "app" / "public" / "packs" / work
    cfg = load_yaml(sdir / "work.yaml")
    pack = json.loads((pdir / "pack.json").read_text(encoding="utf-8"))
    in_pack = {m["id"]: m for m in pack["movements"]}
    print(f"# {cfg['title']} — {cfg['composer']}")
    print(f"notice: {cfg.get('notice')}")
    total = sum(m["durationMs"] for m in pack["movements"])
    print(f"durée totale (mouvements du pack, au tempo de l'app) : {fmt_ms(total)}\n")
    for ym in cfg["movements"]:
        mid = ym["id"]
        print(f"## {mid} · {ym['title']}")
        extra = {k: v for k, v in ym.items() if k not in ("file", "id", "title")}
        if extra:
            print(f"  work.yaml: {extra}")
        mv = in_pack.get(mid)
        if mv is None:
            print("  ABSENT DU PACK (mouvement non transcrit)\n")
            continue
        ms, notes = mv["measures"], mv["notes"]
        mx = musicxml_facts(sdir / ym["file"])
        print(f"  mesures : {len(ms)} (n° {ms[0]['n']} à {ms[-1]['n']}) ; durée (pack) {fmt_ms(mv['durationMs'])}")
        printed = PRINTED_TEMPO.get((work, mid))
        if printed:
            print(f"  ATTENTION tempo imprimé absent du MusicXML {printed} ; durée au tempo de la partition : "
                  f"{fmt_ms(score_tempo_duration(ms, printed))}")
        print("  armures (MusicXML) : " + " ; ".join(
            f"mes. {n} : {abs(f)}{'♯' if f > 0 else '♭' if f < 0 else ''} (= {MAJOR[f]} majeur / {MINOR[f]} mineur)"
            + (f" mode={mo}" if mo else "") for n, f, mo in mx["keys"]))
        tonics = []
        for m in ms:
            k = (m["tonic"], m["minor"])
            if not tonics or tonics[-1][1:] != k:
                tonics.append((m["n"], *k))
        print("  tonique (pack) : " + " ; ".join(f"mes. {n} : {PC_FR[t]}{' mineur' if mi else ''}" for n, t, mi in tonics))
        print("  " + last_chord(notes, ms))
        print("  mesures (MusicXML) : " + " ; ".join(f"mes. {n} : {t}" for n, t in mx["times"]))
        tss = []
        for m in ms:
            if not tss or tss[-1][1] != m["ts"]:
                tss.append((m["n"], m["ts"]))
        print("  mesures (pack) : " + " ; ".join(f"mes. {n} : {a}/{b}" for n, (a, b) in tss))
        print("  tempo (MusicXML) : " + " ; ".join(f"mes. {n} : {v}" for n, k, v in mx["tempos"]))
        print("  tempo joué (pack, noire/min) : " + " ; ".join(f"mes. {n} : {b}" for n, b in effective_tempi(ms)))
        if mx["texts"]:
            print("  indications de texte : " + " ; ".join(f"{p} mes. {n} « {w} »" for p, n, w in mx["texts"]))
        if mv["measures"][0].get("q") is not None and len(ms) > 1:
            first_q = ms[1]["q"] - ms[0]["q"]
            full_q = ms[0]["ts"][0] * 4 / ms[0]["ts"][1]
            if first_q < full_q:
                print(f"  levée : la mesure 1 dure {first_q} noire(s)")
        lyr = mei_lyrics(pdir / mv["mei"], mv)
        for p in mv["parts"]:
            pid = p["id"]
            cnt = sum(1 for n in notes if n["part"] == pid)
            rng = sung_ranges(notes, ms, pid, GAP)
            state = "TACET" if cnt == 0 else f"{cnt} notes ; mesures {', '.join(rng)}"
            print(f"  [{pid}] {state}")
            for vn, words in sorted(lyr.get(pid, {}).items()):
                up = unique_phrases(phrases(words))
                print(f"     paroles v{vn} ({len(words)} mots) — phrases uniques :")
                for mn, ph in up:
                    print(f"       m{mn}: {ph}")
                if show_words:
                    print("     flux : " + " ".join(f"[{mn}]{w}" if i == 0 or words[i - 1][0] != mn else w
                                               for i, (mn, w) in enumerate(words)))
        print()


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_words = "--words" in sys.argv
    global GAP
    for a in sys.argv[1:]:
        if a.startswith("--gap="):
            GAP = int(a.split("=")[1])
    for w in args or sorted(p.parent.name for p in (ROOT / "scores").glob("*/work.yaml")):
        report(w, show_words)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
