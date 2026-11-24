"""From the files of a singer to the crops the notes are read on: the overview of the pages,
the measure table written from the page, barlines fitted to the counts or placed by hand,
staves put together by their spacing, a keyboard shown larger."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools import source  # noqa: E402
from tools.omr import imgproc as ip, layout as lay, pages  # noqa: E402
from pipeline.cht.measures import load_measures  # noqa: E402


def staff(img, top, x0=120, x1=1500, sp=16):
    for k in range(5):
        cv2.line(img, (x0, top + sp * k), (x1, top + sp * k), 0, 2)


def page(systems=2, staves=4, bars=(480, 800, 1150), joined=True, faint=None, between=260, inner=150):
    """A page of `systems` systems of `staves` staves. `joined`: the barlines run through the
    system (else each staff has its own, as where a bracket alone joins them). `faint`: the x of
    a barline drawn through the first staves only, 0..1 of them."""
    sp, x0, x1 = 16, 120, 1500
    height = 200 + systems * (staves * inner + between)
    img = np.full((height, 1640), 255, np.uint8)
    tops = []
    for s in range(systems):
        base = 160 + s * (staves * inner + between)
        ys = [base + i * inner for i in range(staves)]
        tops.append(ys)
        for y in ys:
            staff(img, y, x0, x1, sp)
        for x in (x0,) + tuple(bars) + (x1,):
            if joined:
                cv2.line(img, (x, ys[0]), (x, ys[-1] + 4 * sp), 0, 3)
            else:
                for y in ys:
                    cv2.line(img, (x, y), (x, y + 4 * sp), 0, 3)
        if faint:
            fx, share = faint
            for y in ys[:max(1, round(share * staves))]:
                cv2.line(img, (fx, y), (fx, y + 4 * sp), 0, 3)
    return img


def one_staff_system(barlines, weak=()):
    return lay.System([lay.Staff([0, 16, 32, 48, 64], 80, 900)], list(barlines), 80, False, list(weak))


def test_a_doubtful_stroke_becomes_the_barline_that_was_missing():
    s = one_staff_system([300, 900], weak=[600, 450])
    assert pages.reconcile(s, 3)
    assert s.barlines == [300, 600, 900]            # the best one first, and no more than asked


def test_a_barline_placed_by_hand_is_added_and_never_dropped():
    s = one_staff_system([300, 330, 900])
    assert pages.reconcile(s, 3, hand=[610])
    assert 610 in s.barlines and len(s.barlines) == 3


def test_hand_barlines_are_read_from_bars_tsv(tmp_path):
    (tmp_path / "bars.tsv").write_text("# page system x\n8\t2\t610 1220\n8\t3\t455\nnine\t1\t3\n", encoding="utf-8")
    assert pages.load_hand_bars(tmp_path) == {8: {2: [610, 1220], 3: [455]}}


def test_staves_that_no_line_joins_are_put_together_by_their_spacing():
    img = page(systems=3, staves=3, joined=False)
    _, systems = pages.clean_page(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR))
    assert [len(s.staves) for s in systems] == [3, 3, 3]
    assert all(s.guessed for s in systems)


def test_the_work_says_how_many_staves_a_system_has():
    img = page(systems=2, staves=4, joined=False, between=150)      # evenly spaced: nothing to tell them apart
    _, systems = pages.clean_page(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), per_system=4)
    assert [len(s.staves) for s in systems] == [4, 4]
    assert not any(s.guessed for s in systems)


def make_work(tmp_path, images):
    files = []
    for i, img in enumerate(images, 1):
        f = tmp_path / f"scan{i}.png"
        cv2.imwrite(str(f), img)
        files.append(str(f))
    work = tmp_path / "scores" / "piece"
    assert source.main([str(work), *files]) == 0
    return work


def test_the_pages_given_are_shown_small_on_one_sheet(tmp_path):
    work = make_work(tmp_path, [page(), page(), page()])
    sheet = cv2.imread(str(work / "work" / "apercu.png"))
    assert sheet is not None and sheet.shape[1] >= 3 * source.THUMB_W
    assert len(list((work / "work" / "source").glob("*.png"))) == 3


def test_the_first_run_writes_the_measure_table_and_numbers_the_crops(tmp_path, capsys):
    work = make_work(tmp_path, [page(), page()])
    assert pages.main(["--work", str(work)]) == 0
    table = load_measures(work / "work" / "measures.tsv")
    assert [r.systems for r in table.rows(1)] == [[4, 4]] and table.rows(2)[0].first == 9
    crops = (work / "work" / "img" / "crops.txt").read_text(encoding="utf-8")
    assert "p002 s2 m13-16: p002_s2_ch_m013-014.png p002_s2_ch_m015-016.png" in crops
    assert (work / "work" / "img" / "p002_s2_ch_m015-016.png").exists()
    assert "m1-8" in capsys.readouterr().out


def test_a_corrected_count_renumbers_every_page_and_fits_the_barlines(tmp_path):
    faint_x = 640                                   # a barline that only half of the staves show
    work = make_work(tmp_path, [page(faint=(faint_x, 0.5)), page()])
    assert pages.main(["--work", str(work)]) == 0
    tsv = work / "work" / "measures.tsv"
    assert load_measures(tsv).rows(1)[0].systems == [4, 4]           # not counted on its own
    tsv.write_text(tsv.read_text(encoding="utf-8").replace("4,4", "5,5", 1), encoding="utf-8")
    assert pages.main(["--work", str(work)]) == 0
    table = load_measures(tsv)
    assert table.rows(2)[0].first == 11
    layout = lay.from_dict(__import__("json").loads((work / "work" / "img" / "p001.json").read_text()))
    assert [len(s.barlines) for s in layout] == [5, 5]
    assert any(abs(x - faint_x) < 12 for x in layout[0].barlines)


def test_a_barline_no_fitting_finds_is_placed_by_hand(tmp_path):
    work = make_work(tmp_path, [page()])
    assert pages.main(["--work", str(work)]) == 0
    tsv = work / "work" / "measures.tsv"
    tsv.write_text(tsv.read_text(encoding="utf-8").replace("4,4", "5,4", 1), encoding="utf-8")
    (work / "work" / "bars.tsv").write_text("1\t1\t990\n", encoding="utf-8")
    assert pages.main(["--work", str(work)]) == 0
    layout = lay.from_dict(__import__("json").loads((work / "work" / "img" / "p001.json").read_text()))
    assert len(layout[0].barlines) == 5 and any(abs(x - 990) < 3 for x in layout[0].barlines)


def test_the_keyboard_is_shown_larger_than_the_voices(tmp_path):
    work = make_work(tmp_path, [page(systems=2, staves=6)])
    assert pages.main(["--work", str(work)]) == 0
    img = work / "work" / "img"
    voices = sorted(img.glob("p001_s1_ch_*.png"))
    keys = sorted(img.glob("p001_s1_pf_*.png"))
    assert voices and keys and len(keys) >= len(voices)
    sp = lay.from_dict(__import__("json").loads((img / "p001.json").read_text()))[0].staves[0].space
    assert pages.scale_for(sp, pages.KEYS_SPACE, 4) > pages.scale_for(sp, pages.CROP_SPACE, 4)


def test_a_work_that_names_its_voices_only_may_have_a_keyboard_under_them(tmp_path):
    from pipeline.cht import workdir
    (tmp_path / "work").mkdir()
    cfg = tmp_path / "work.yaml"
    cfg.write_text("staves: [S, A]\n", encoding="utf-8")
    assert workdir.system_sizes(tmp_path / "work") == [2, 4]
    cfg.write_text("staves: [S, A, PR, PL]\n", encoding="utf-8")
    assert workdir.system_sizes(tmp_path / "work") == [4]
    img = page(systems=2, staves=4, joined=False)                   # two voices and a piano, twice
    _, systems = pages.clean_page(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), per_system=[2, 4])
    assert [len(s.staves) for s in systems] == [4, 4]
