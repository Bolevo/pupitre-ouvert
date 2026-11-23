"""Faded zones of a printed page (tools/omr/imgproc.py restore_faded) on a synthetic page."""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.omr import imgproc as ip  # noqa: E402

W, H = 1300, 1000


def page(staves):
    """White page; staves = [(top, ink)]: five 2 px lines 12 px apart and a few note heads, drawn
    with the darkness `ink` (255 = black)."""
    img = np.full((H, W), 255, np.uint8)
    for top, ink in staves:
        for k in range(5):
            img[top + 12 * k: top + 12 * k + 2, 60:W - 60] = 255 - ink
        for x in range(150, W - 100, 90):
            cv2.circle(img, (x, top + 30), 6, int(255 - min(255, ink * 1.6)), -1)
    return img


def test_a_well_printed_page_is_returned_untouched():
    img = page([(y, 200) for y in range(80, 900, 110)])
    assert ip.restore_faded(img) is img


def test_a_slightly_lighter_system_is_not_a_faded_zone():
    img = page([(100, 120)] + [(y, 200) for y in range(210, 900, 110)])
    assert ip.fade_gain(img).max() > 1.02                      # the gain sees it...
    assert ip.restore_faded(img) is img                        # ... but the page is left as it is


def test_faded_staves_get_darker_and_the_rest_does_not_move():
    faded, normal = [100, 210, 320], [560, 670, 780, 890]
    img = page([(y, 60) for y in faded] + [(y, 200) for y in normal])
    out = ip.restore_faded(img)
    assert out.shape == img.shape and out.dtype == np.uint8
    assert (out <= img).all()                                  # a tone treatment: nothing gets lighter
    assert (out[img == 255] == 255).all()                      # the paper stays white
    line = lambda a, top: 255 - float(a[top:top + 2, 300:1000].mean())
    for top in faded:
        assert line(img, top) == 60
        assert 130 <= line(out, top) <= 170                    # brought up to about FADE_TARGET
    for top in normal[1:]:
        assert (out[top - 20:top + 80] == img[top - 20:top + 80]).all()   # well-printed systems: identical


def test_the_gain_is_smooth_and_bounded():
    img = page([(y, 40) for y in (400, 510)] + [(y, 200) for y in (700, 810, 900)])
    g = ip.fade_gain(img)
    assert g.shape == img.shape
    assert g.min() >= 1 and g.max() <= ip.FADE_MAX_GAIN
    assert g[400:560, 300:1000].min() > 2.5                    # the faded staves: lines at 40, the cap is reached
    assert np.abs(np.diff(g, axis=0)).max() < 0.05 and np.abs(np.diff(g, axis=1)).max() < 0.05
    assert g[:120].max() < 1.05                                # the top margin, far from any staff
