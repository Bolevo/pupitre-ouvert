"""Where the music starts in the first measure of a system (tools/page_starts.py): synthetic
pages in the manner of two editions, then the page data of the works themselves."""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools import page_starts as ps  # noqa: E402

SP = 8          # staff space (px)
W, H = 1300, 1500
X0 = 70         # left edge of the systems


def draw_system(img, top, acc, time, edition, staves=4, first_gap=2.5, tied=False, width=46, music=0):
    """One system of `staves` staves from y = top: left barline, clef, `acc` accidentals, a time
    signature if `time`, then notes (`music`: their spacing, different in every system as in a
    real score). edition = (width of an accidental, blank after the clef), in staff spaces.
    `tied`: ties come from the previous system, in every staff (no blank before the notes).
    Returns (staves, x1 of the first measure, end of the signatures, first notes)."""
    acc_w, clef_gap = edition
    out, x1 = [], X0 + width * SP
    for j in range(staves):
        y = top + j * 13 * SP
        for k in range(5):
            img[y + k * SP: y + k * SP + 2, X0:W - 60] = 0
        cv2.line(img, (X0, y), (X0, y + 4 * SP), 0, 2)
        x = X0 + SP
        cv2.ellipse(img, (x + 11, y + 2 * SP), (11, 20), 0, 0, 360, 0, -1)                 # the clef
        x += 22 + round(clef_gap * SP)
        for a in range(acc):
            cv2.rectangle(img, (x, y + SP * (a % 3)), (x + round(0.8 * acc_w * SP), y + SP * (a % 3) + 14), 0, -1)
            x += round(acc_w * SP)
        if time:
            x += 4
            cv2.rectangle(img, (x, y + 2), (x + 13, y + 4 * SP - 2), 0, -1)
            x += 13
        end, notes = x, x + round(first_gap * SP)
        if tied:
            cv2.line(img, (end + 2, y + 5 * SP), (notes, y + 5 * SP), 0, 4)
        if j == 1:   # one voice begins with an altered note: its accidental stands before the others' heads
            cv2.rectangle(img, (notes - 9, y + SP), (notes - 4, y + 3 * SP), 0, -1)
        for i, nx in enumerate([notes] + list(range(notes + (3 + (music + j) % 4) * SP + 3 * (music % 5), W - 80, (4 + (j + music) % 3) * SP))):
            cv2.ellipse(img, (nx + 5, y + SP * (1 + (i + j) % 3)), (5, 4), 0, 0, 360, 0, -1)
            cv2.line(img, (nx + 10, y + SP * (1 + (i + j) % 3)), (nx + 10, y - 2 * SP + SP * ((i + j) % 3)), 0, 1)
        cv2.line(img, (x1, y), (x1, y + 4 * SP), 0, 1)
        out.append({"top": y, "bottom": y + 4 * SP})
    return out, x1, end - X0, notes - X0


def make_work(tmp_path, systems, edition):
    """Pages of three systems each. systems = [(accidentals, time, more)]; the measure numbers
    are 1, 11, 21... Returns (pages, signatures, what was drawn: number -> (end, notes))."""
    pages, sigs, drawn = [], {}, {}
    for p in range(0, len(systems), 3):
        img = np.full((H, W), 255, np.uint8)
        pg = {"page": p // 3 + 1, "img": f"p{p // 3 + 1:03d}.png", "w": W, "h": H, "systems": [], "measures": []}
        for k, (acc, time, more) in enumerate(systems[p:p + 3]):
            n, top = 10 * (p + k) + 1, 60 + k * 480
            staves, x1, end, notes = draw_system(img, top, acc, time, edition, music=p + k, **more)
            pg["systems"].append({"top": top, "bottom": staves[-1]["bottom"], "staves": staves})
            box = {"mv": 1, "sys": k, "y0": top - 20, "y1": staves[-1]["bottom"] + 20}
            pg["measures"] += [{**box, "n": n, "x0": X0, "x1": x1}, {**box, "n": n + 1, "x0": x1, "x1": W - 60}]
            sigs[(1, str(n))] = (acc, time)
            drawn[n] = (end, notes)
        cv2.imwrite(str(tmp_path / pg["img"]), img)
        pages.append(pg)
    return pages, sigs, drawn


def starts(pages):
    return {m["n"]: m["xn"] - m["x0"] for pg in pages for m in pg["measures"] if "xn" in m}


PLAIN = [(2, False, {})] * 7 + [(2, True, {})] + [(5, False, {})] * 3 + [(5, True, {})]


@pytest.mark.parametrize("edition", [(1.1, 0.3), (2.2, 1.4)], ids=["narrow accidentals", "wide accidentals, a blank after the clef"])
def test_the_playhead_starts_after_the_signatures_just_before_the_notes(tmp_path, edition):
    """Whatever the edition: an accidental 1.1 staff spaces wide right after the clef, or twice as
    wide after a blank as wide as the one before the notes. Never on the clef or the key signature
    (the measure's left edge), never after the first note."""
    pages, sigs, drawn = make_work(tmp_path, PLAIN, edition)
    report = ps.annotate(pages, tmp_path, sigs)
    assert report[0].startswith(f"{len(PLAIN)}/{len(PLAIN)} systems measured")
    found = starts(pages)
    assert sorted(found) == sorted(drawn)            # the first measure of every system, no other
    for n, (end, notes) in drawn.items():
        assert end - 1 <= found[n] <= notes - 4, (n, end, found[n], notes)       # after the signatures...
        assert notes - found[n] <= 3 * SP, (n, found[n], notes)                  # ...where a barline would be


def test_ties_across_the_gap_the_edition_places_the_start(tmp_path):
    """No blank before the notes (a tie in every staff): the start is where the other systems of
    the work say the signatures end, and the report names the system."""
    systems = [(3, False, {})] * 8 + [(3, False, {"tied": True})]
    pages, sigs, drawn = make_work(tmp_path, systems, (1.3, 0.3))
    report = ps.annotate(pages, tmp_path, sigs)
    assert report[0].startswith("8/9 systems measured") and "p3 s3: the first note was not found" in report[1]
    end, notes = drawn[81]
    assert end - SP <= starts(pages)[81] <= notes


def test_a_short_first_measure(tmp_path):
    """An upbeat after five flats and a time signature (Taneyev II): the signatures take most of
    the measure, the start is still found."""
    systems = [(5, False, {})] * 6 + [(5, True, {"width": 24}), (5, True, {"width": 17})]
    pages, sigs, drawn = make_work(tmp_path, systems, (1.3, 0.3))
    ps.annotate(pages, tmp_path, sigs)
    found = starts(pages)
    for n in (61, 71):
        assert drawn[n][0] - 1 <= found[n] <= drawn[n][1], (n, drawn[n], found[n])


def test_no_start_when_the_signatures_fill_the_measure():
    """Nothing found and the edition's place leaves no room to cross: the barline is kept."""
    rows = [{"sig": (2, False), "sp": 8.0, "gaps": [(50, 70), (90, 100)], "width": 360} for _ in range(5)]
    rows.append({"sig": (2, False), "sp": 8.0, "gaps": [], "width": 60})
    ps.place_starts(rows)
    assert [r["xn"] for r in rows] == [58] * 5 + [None] and rows[-1]["how"] == "model"


def test_nothing_for_a_movement_not_compiled_and_a_second_run_changes_nothing(tmp_path):
    pages, sigs, _ = make_work(tmp_path, [(2, False, {})] * 6, (1.1, 0.3))
    del sigs[(1, "41")]                                   # as if this system belonged to another movement
    pages[0]["measures"][1]["xn"] = 999                    # left by an earlier run: removed
    ps.annotate(pages, tmp_path, sigs)
    first = starts(pages)
    assert sorted(first) == [1, 11, 21, 31, 51]
    ps.annotate(pages, tmp_path, sigs)
    assert starts(pages) == first


def test_signatures_read_from_the_score(tmp_path):
    def measure(n, attrs=""):
        return f'<measure number="{n}">{attrs}<note><rest/><duration>4</duration></note></measure>'
    key = lambda f: f"<key><fifths>{f}</fifths></key>"   # noqa: E731
    time = lambda b: f"<time><beats>{b}</beats><beat-type>4</beat-type></time>"   # noqa: E731
    part = (measure(1, f"<attributes><divisions>1</divisions>{key(-5)}{time(3)}</attributes>") + measure(2)
            + measure(3, f"<attributes>{key(3)}{time(4)}</attributes>") + measure(4, f"<attributes>{time(4)}</attributes>"))
    (tmp_path / "m.musicxml").write_text(f'<score-partwise><part id="P1">{part}</part></score-partwise>', encoding="utf-8")
    (tmp_path / "work.yaml").write_text("id: t\nmovements:\n  - {file: absent.musicxml, id: a}\n  - {file: m.musicxml, id: m}\n", encoding="utf-8")
    assert ps.signatures(tmp_path) == {(2, "1"): (5, True), (2, "2"): (5, False), (2, "3"): (3, True), (2, "4"): (3, False)}


@pytest.mark.parametrize("work", sorted(p.parents[1].name for p in (ROOT / "scores").glob("*/pages/pages.json")))
def test_the_works_every_system_has_its_start_inside_its_first_measure(work):
    pages = json.loads((ROOT / "scores" / work / "pages" / "pages.json").read_text(encoding="utf-8"))
    sigs = ps.signatures(ROOT / "scores" / work)
    systems = 0
    for pg in pages:
        for k in range(len(pg["systems"])):
            ms = sorted((m for m in pg["measures"] if m["sys"] == k), key=lambda m: m["x0"])
            if not ms or (ms[0]["mv"], str(ms[0]["n"])) not in sigs:
                assert not any("xn" in m for m in ms)
                continue
            systems += 1
            assert ms[0]["x0"] < ms[0]["xn"] < ms[0]["x1"], (pg["page"], k)
            assert not any("xn" in m for m in ms[1:]), (pg["page"], k)
    assert systems > 0
