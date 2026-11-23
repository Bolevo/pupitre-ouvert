"""Low-level image helpers for phone photos of printed scores.

All functions take/return numpy uint8 images (grayscale unless stated).
Ink is dark (0) on white (255).
"""
from __future__ import annotations

import cv2
import numpy as np


def to_gray(img: np.ndarray) -> np.ndarray:
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def normalize_background(gray: np.ndarray, ksize: int = 51) -> np.ndarray:
    """Flatten uneven lighting: divide by a median-blurred copy (the 'paper')."""
    ksize |= 1
    bg = cv2.medianBlur(gray, ksize)
    norm = cv2.divide(gray, bg, scale=255)
    return norm


def enhance(norm: np.ndarray, black: int = 120, white: int = 235) -> np.ndarray:
    """Contrast stretch for human reading: map [black, white] -> [0, 255]."""
    x = (norm.astype(np.float32) - black) * (255.0 / (white - black))
    return np.clip(x, 0, 255).astype(np.uint8)


# Faded print (a zone where the ink is grey: Taneyev p. 5, first system). Calibrated for the
# displayed page, 1300 px wide, after normalize_background: darkness = 255 - value.
FADE_TARGET = 150.0   # darkness the staff lines of a faded zone are brought up to
FADE_LOW = 90.0       # staff lines fainter than this get the full gain
FADE_HIGH = 130.0     # staff lines at least this dark are left alone (a well-printed page: 170 to 240)
FADE_MAX_GAIN = 3.0
FADE_MIN_AREA = 0.01  # a page has a faded zone when the gain reaches 1.5 on at least this share of it


def line_strength(norm: np.ndarray, step: int = 40, win: int = 200, run: int = 45) -> np.ndarray:
    """Darkness of the staff lines, one value per `step` px (NaN where a `win` px window holds no
    staff line). The lines are the yardstick of the print: thin, of one weight all over a page, and
    present in every system. Found as long thin horizontal strokes, whatever their darkness."""
    d = 255 - norm.astype(np.float32)
    thin = cv2.morphologyEx(d, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 7)))
    long_runs = cv2.morphologyEx(thin, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (run, 1)))
    mask = long_runs > 12
    h, w = d.shape
    out = np.full((-(-h // step), -(-w // step)), np.nan, np.float32)
    for i in range(out.shape[0]):
        for j in range(out.shape[1]):
            cy, cx = i * step + step // 2, j * step + step // 2
            sl = (slice(max(0, cy - win // 2), cy + win // 2), slice(max(0, cx - win // 2), cx + win // 2))
            m = mask[sl]
            if m.sum() >= 150:
                out[i, j] = np.percentile(d[sl][m], 70)
    return out


def fade_gain(norm: np.ndarray, step: int = 40, sigma: float = 1.2) -> np.ndarray:
    """Per-pixel factor (>= 1) by which the darkness of a faded zone must be multiplied for its
    staff lines to reach FADE_TARGET. 1 wherever the lines are at least FADE_HIGH, and away from
    any staff; smooth in between (no visible edge)."""
    strength = line_strength(norm, step)
    valid = ~np.isnan(strength)
    s = np.where(valid, strength, FADE_HIGH)
    t = np.clip((FADE_HIGH - s) / (FADE_HIGH - FADE_LOW), 0, 1)
    weight = t * t * (3 - 2 * t)                                  # 0 above FADE_HIGH, 1 below FADE_LOW
    g = 1 + (np.clip(FADE_TARGET / np.maximum(s, 1), 1, FADE_MAX_GAIN) - 1) * weight
    g = np.where(valid, g, 0).astype(np.float32)
    known = cv2.GaussianBlur(valid.astype(np.float32), (0, 0), sigma)
    g = cv2.GaussianBlur(g, (0, 0), sigma) / np.maximum(known, 1e-3)   # windows without lines take their neighbours' value
    g = 1 + (g - 1) * np.clip((known - 0.25) / 0.5, 0, 1)             # ... and nothing far from any staff (margins)
    h, w = norm.shape
    full = cv2.resize(g.astype(np.float32), (g.shape[1] * step, g.shape[0] * step), interpolation=cv2.INTER_CUBIC)[:h, :w]
    return np.clip(full, 1, FADE_MAX_GAIN)


def restore_faded(norm: np.ndarray, lo: int = 8, hi: int = 30) -> np.ndarray:
    """Darkens the zones of a page where the print is faded (grey ink, staff lines about to vanish
    in `enhance`). A tone treatment only: every pixel stays where it is and can only get darker, by
    a smooth local factor measured on the staff lines (fade_gain). The paper's grain (darkness under
    `lo`) is left alone. A page without a faded zone (FADE_MIN_AREA) comes back unchanged (the same
    array): the small differences of weight of an ordinary print are not touched."""
    g = fade_gain(norm)
    if float((g >= 1.5).mean()) < FADE_MIN_AREA:
        return norm
    d = 255 - norm.astype(np.float32)
    t = np.clip((d - lo) / (hi - lo), 0, 1)
    return np.clip(255 - d * (1 + (g - 1) * (t * t * (3 - 2 * t))), 0, 255).astype(np.uint8)


def binarize(norm: np.ndarray, level: int | None = None) -> np.ndarray:
    """Ink mask (255 = ink). Otsu by default; a fixed `level` (e.g. 205) is more
    lenient and keeps the faint, thin staff lines of the photos."""
    if level is not None:
        return np.where(norm < level, 255, 0).astype(np.uint8)
    _, ink = cv2.threshold(norm, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return ink


def line_mask(norm: np.ndarray, thickness: int = 7, level: int = 30) -> np.ndarray:
    """Thin dark strokes (staff lines, stems...) via a vertical black-hat.
    Robust to blur and uneven ink: isolates lines even where they merge with
    the paper tone in a plain threshold."""
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, thickness))
    bh = cv2.morphologyEx(norm, cv2.MORPH_BLACKHAT, k)
    return np.where(bh > level, 255, 0).astype(np.uint8)


def estimate_skew(ink: np.ndarray, max_deg: float = 4.0, step: float = 0.05) -> float:
    """Angle (degrees) that makes staff lines horizontal.

    Maximises the variance of the row projection of long horizontal strokes.
    Positive angle = rotate the image counter-clockwise to fix it.
    """
    h, w = ink.shape
    scale = 1000.0 / max(h, w)
    small = cv2.resize(ink, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    center = (small.shape[1] / 2, small.shape[0] / 2)

    def score(a: float) -> float:
        m = cv2.getRotationMatrix2D(center, a, 1.0)
        r = cv2.warpAffine(small, m, (small.shape[1], small.shape[0]), flags=cv2.INTER_NEAREST)
        prof = r.sum(axis=1, dtype=np.float64)
        return float(np.var(prof))

    coarse = np.arange(-max_deg, max_deg + 1e-9, 0.25)
    best = max(coarse, key=score)
    fine = np.arange(best - 0.25, best + 0.25 + 1e-9, step)
    return float(max(fine, key=score))


def rotate(img: np.ndarray, angle: float, border: int = 255) -> np.ndarray:
    if abs(angle) < 1e-3:
        return img
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC, borderValue=border)


def upscale(img: np.ndarray, factor: float) -> np.ndarray:
    if factor == 1:
        return img
    h, w = img.shape[:2]
    return cv2.resize(img, (int(w * factor), int(h * factor)), interpolation=cv2.INTER_CUBIC)


def for_omr(gray: np.ndarray, factor: float = 2.2) -> np.ndarray:
    """Image prepared for Audiveris: background-normalised, upscaled, Otsu-binarised."""
    norm = normalize_background(gray)
    big = upscale(norm, factor)
    _, bw = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return bw
