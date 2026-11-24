"""Framing a page (tools/omr/frame.py): what is printed is kept, what surrounds it is cut."""
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.omr import frame  # noqa: E402

SP = 16
W, H = 2400, 3200


def page(surroundings=True, title=True, number=True):
    """A straightened page: three systems of two staves, a title, a page number, lyrics; around
    the sheet, the dark of a table (left and bottom) and the thin edge of the sheet."""
    img = np.full((H, W), 255, np.uint8)
    x0, x1 = 500, 2000
    tops = [900, 1500, 2100]
    for top in tops:
        for st in (0, 9 * SP):
            for k in range(5):
                img[top + st + k * SP: top + st + k * SP + 3, x0:x1] = 0
            for nx in range(x0 + 60, x1 - 20, 90):
                cv2.ellipse(img, (nx, top + st + 2 * SP), (10, 8), 0, 0, 360, 0, -1)
        cv2.line(img, (x0, top), (x0, top + 13 * SP), 0, 4)
        cv2.putText(img, "Glo - ri - a in ex - cel - sis", (x0 + 40, top + 16 * SP), cv2.FONT_HERSHEY_SIMPLEX, 1.4, 0, 3)
    cv2.putText(img, "Sop.", (x0 - 150, tops[0] + 3 * SP), cv2.FONT_HERSHEY_SIMPLEX, 1.3, 0, 3)
    if title:
        cv2.putText(img, "GLORIA", (1000, 760), cv2.FONT_HERSHEY_SIMPLEX, 2.6, 0, 6)
    if number:
        cv2.putText(img, "12", (x0 - 140, 700), cv2.FONT_HERSHEY_SIMPLEX, 1.4, 0, 3)
    if surroundings:
        img[:, :180] = 40                                   # the table, at the left
        img[H - 260:, :] = 60                               # and below
        cv2.line(img, (300, 200), (300, H - 400), 110, 3)   # the edge of the sheet
        cv2.line(img, (300, 200), (W - 150, 200), 110, 3)
    return img


def test_the_printed_page_is_kept_with_a_margin_and_the_surroundings_are_cut():
    box = frame.content_box(page())
    assert box is not None
    x0, y0, x1, y1 = box
    # everything printed is inside: the page number and the voice's name at the left, the title
    # above, the lyrics of the last system below, the right end of the staves
    assert x0 < 500 - 150 and y0 < 660 and x1 > 2000 and y1 > 2100 + 16 * SP
    # the table and the edge of the sheet are outside
    assert x0 > 300 and y0 > 200 and y1 < H - 260
    # and the margin is a few staff spaces, not the whole sheet
    assert x0 > 500 - 150 - 6 * SP and y1 < 2100 + 16 * SP + 6 * SP and x1 < 2000 + 6 * SP


def test_a_page_already_framed_is_left_whole():
    tight = page(surroundings=False)[620:2420, 300:2080]
    assert frame.content_box(tight) is None


def test_a_page_without_staves_is_left_whole():
    blank = np.full((H, W), 255, np.uint8)
    cv2.putText(blank, "Table des matieres", (400, 600), cv2.FONT_HERSHEY_SIMPLEX, 2, 0, 5)
    assert frame.content_box(blank) is None


def test_a_speck_of_dust_does_not_pull_the_frame_but_a_lone_page_number_does():
    plain = page(title=False, number=False, surroundings=False)
    x0, y0, x1, y1 = frame.content_box(plain)
    dusty = plain.copy()
    cv2.circle(dusty, (1300, 690), 3, 0, -1)                 # a speck above the first system
    assert frame.content_box(dusty) == (x0, y0, x1, y1)
    numbered = plain.copy()
    cv2.putText(numbered, "7", (1300, 700), cv2.FONT_HERSHEY_SIMPLEX, 1.4, 0, 3)
    assert frame.content_box(numbered)[1] < 660 < y0         # the number, as small, is print


def test_the_margin_stops_where_the_grain_of_a_table_begins():
    """A sheet on a striped table, the title close to the top edge of the sheet: the frame keeps
    the title and stops short of the table, instead of taking its usual margin into it."""
    img = page(surroundings=False, number=False)
    top = 760 - 70                                           # above the title (its baseline is at 760)
    edge = top - SP                                          # the edge of the sheet: one staff space higher
    for x in range(0, W, 120):                               # pale stripes: no ink, but not paper
        img[:edge, x:x + 60] = 170
    x0, y0, x1, y1 = frame.content_box(img)
    assert edge - 4 <= y0 < top                              # the title is whole, the stripes are out
    assert y1 > 2100 + 16 * SP
    # without the table, the same page takes its full margin above the title
    assert frame.content_box(page(surroundings=False, number=False))[1] < edge - 4


def test_dark_streaks_of_a_table_beside_the_sheet_are_not_taken_for_print():
    """Below the footer the sheet ends and a wooden table begins: grey, with darker streaks that
    do not reach the border of the photo. They stand in grey, not on paper: the frame stops at
    the sheet."""
    img = page(surroundings=False)
    foot = 2100 + 16 * SP + 30                               # under the last lyrics
    edge = foot + 3 * SP                                     # the sheet ends three staff spaces lower
    plain = frame.content_box(img)
    img[edge:edge + 200, 200:W - 200] = 185                  # the table, lit
    for x in range(260, W - 300, 70):                        # its grain: short dark streaks
        img[edge + 8:edge + 14, x:x + 40] = 120
    box = frame.content_box(img)
    assert box is not None and box[3] <= edge + 2            # nothing of the table
    assert box[3] > 2100 + 16 * SP and box[:3] == plain[:3]


def test_what_a_scanner_leaves_in_the_margins_is_cut():
    """A library scan: a dark band along the bottom with a blot beside it, the shadow of the
    binding down the left rim, a streak at the very top, a lone stain beside the staves. None
    of it is print; the page number, the title and the name of the voice still are."""
    clean = page(surroundings=False)
    img = clean.copy()
    img[H - 90:H - 40, 0:1100] = 0                            # the band, from the left border
    cv2.ellipse(img, (160, H - 150), (45, 60), 0, 0, 360, 0, -1)       # a blot just above it
    img[2000:2500, 60:72] = 0                                 # the binding's shadow
    img[8:14, 200:260] = 0                                    # a streak under the top border
    cv2.circle(img, (90, 1300), 9, 0, -1)                     # a stain in the left margin
    box, plain = frame.content_box(img), frame.content_box(clean)
    assert box is not None and plain is not None
    assert box[0] > 72 and box[3] < H - 210                   # the shadow, the blot and the band are out
    assert abs(box[0] - plain[0]) <= 2 and abs(box[1] - plain[1]) <= 2 and abs(box[3] - plain[3]) <= 2
