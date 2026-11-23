"""Page straightening with one smooth surface (tools/omr/surface.py) on synthetic photos."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.omr.dewarp import staff_tracks  # noqa: E402
from tools.omr.surface import ANALYSIS_W, lines_of, rectify  # noqa: E402

W, H = 2300, 3200


def page(bend=0.0, seed=0):
    """A full-resolution 'photo': 14 staves, curved by `bend` px (a slow page curl), a little
    text and noise."""
    rng = np.random.default_rng(seed)
    img = np.full((H, W), 238, np.uint8)
    xs = np.arange(150, W - 150)
    u = (xs - W / 2) / (W / 2)
    for i in range(14):
        top = 200 + i * 200
        v = (top - H / 2) / (H / 2)
        curve = bend * (u ** 2 - 0.3 * u ** 3) * (1 + 0.4 * v)
        for k in range(5):
            y = top + 18 * k + curve
            pts = np.stack([xs, y], axis=1).astype(np.int32)
            cv2.polylines(img, [pts], False, 30, 2)
        for x in (150, 800, 1450, W - 150):
            c = bend * (((x - W / 2) / (W / 2)) ** 2) * (1 + 0.4 * v)
            cv2.line(img, (x, int(top + c)), (x, int(top + 72 + c)), 30, 3)
        cv2.putText(img, "Gra - ti - as a - gi - mus", (300, int(top + 130)), cv2.FONT_HERSHEY_SIMPLEX, 1.6, 40, 3)
    noise = rng.normal(0, 4, img.shape)
    return np.clip(img + noise, 0, 255).astype(np.uint8)


def flatness(img) -> float:
    """Median over the staves of the vertical spread (max - min) of the staff centre across the page."""
    small = cv2.resize(img, (ANALYSIS_W, round(img.shape[0] * ANALYSIS_W / img.shape[1])), interpolation=cv2.INTER_AREA)
    spreads = []
    for t, _sp in staff_tracks(lines_of(small), 40):
        ys = np.array([p[1] for p in t])
        if len(ys) >= 10:
            spreads.append(np.percentile(ys, 95) - np.percentile(ys, 5))
    return float(np.median(spreads))


def test_curved_page_comes_out_flat():
    img = page(bend=40)
    before = flatness(img)
    out, surf, _angle = rectify(img)
    assert surf.accepted, surf.reason
    assert out.shape == img.shape
    after = flatness(out)
    assert before > 8
    assert after < 0.25 * before


def test_flat_page_is_left_alone_and_deterministic():
    img = page(bend=0)
    out1, s1, _ = rectify(img)
    out2, s2, _ = rectify(img)
    assert not s1.accepted and s1.reason in ("already_flat", "no_clear_holdout_gain")
    assert np.array_equal(out1, out2)
    assert flatness(out1) < 2


def test_blank_page_does_not_fail():
    img = np.full((1600, 1150), 240, np.uint8)
    out, surf, _ = rectify(img)
    assert out.shape == img.shape
    assert not surf.accepted and surf.reason == "insufficient_tracks"
