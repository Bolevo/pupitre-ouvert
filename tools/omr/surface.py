"""Straighten a photographed page with ONE smooth surface (replaces dewarp.py for the page images).

dewarp.py joined the staff centres found in narrow strips with straight segments: every small
detection error became a real kink of the staff lines, notes and words (visible waves). Here the
whole page shares one slow vertical displacement field, fitted to all staves at once:

    y_source = r_s + f(x, y)          r_s: the staff's own height, f: polynomial surface
    f(u, v) = sum c_jk u^j v^k        j = 1..4 (along the line), k = 0..2 (down the page)

(u, v in [-1, 1]; j = 0 is left out: a vertical shift alone is the staff's r_s). The fit is
robust (Huber weights) and lightly regularised; it is kept only if it predicts the staff lines of
strips left out of the fit better than the tilt alone, and if it stays gentle (geometry guard).
Otherwise the page is only deskewed. The rotation and the surface are applied in one resampling
of the full-resolution photo.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from tools.omr import imgproc as ip
from tools.omr.dewarp import staff_tracks

ANALYSIS_W = 1150      # the layout detector's working width
DEG_X, DEG_Y = 4, 2
N_STRIPS = 40


@dataclass
class Surface:
    coeff: np.ndarray          # (DEG_X * (DEG_Y + 1),) in analysis pixels
    w: int                     # analysis frame size
    h: int
    accepted: bool = False
    reason: str = ""
    gain: float = 0.0          # holdout error reduction vs. tilt only
    stats: dict = field(default_factory=dict)
    box: tuple[float, float, float, float] = (0, 0, 0, 0)   # x0, x1, y0, y1 of the staves seen

    def f(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """The displacement; beyond the area the staves cover (margins), held at its edge value
        (a polynomial extrapolated there would bend the margins wildly)."""
        if not self.accepted:
            return np.zeros_like(x, dtype=np.float32)
        x0, x1, y0, y1 = self.box
        return (_basis(np.clip(x, x0, x1), np.clip(y, y0, y1), self.w, self.h) @ self.coeff).astype(np.float32)


def _basis(x, y, w, h) -> np.ndarray:
    u = (np.asarray(x, np.float64) - w / 2) / (w / 2)
    v = (np.asarray(y, np.float64) - h / 2) / (h / 2)
    cols = [u ** j * v ** k for j in range(1, DEG_X + 1) for k in range(DEG_Y + 1)]
    return np.stack(cols, axis=-1)


def _clean(track: list[tuple[float, float]]) -> tuple[np.ndarray, np.ndarray]:
    """Drop samples far from their local median (a wrong 5-line grouping)."""
    tx = np.array([p[0] for p in track])
    ty = np.array([p[1] for p in track])
    med = np.array([np.median(ty[max(0, i - 3):i + 4]) for i in range(len(ty))])
    good = np.abs(ty - med) < 2.5
    return tx[good], ty[good]


def _samples(tracks, min_len: int):
    """-> x, y, staff index, strip index of every sample of the staves kept."""
    xs, ys, ss = [], [], []
    for t, _sp in tracks:
        tx, ty = _clean(t)
        if len(tx) < min_len:
            continue
        s = len({*ss}) if not ss else max(ss) + 1
        xs += list(tx)
        ys += list(ty)
        ss += [s] * len(tx)
    return np.array(xs), np.array(ys), np.array(ss, dtype=int)


def _fit(x, y, s, n_staves, w, h, lam=2.0, iters=8, delta=1.0):
    """Joint robust least squares: y = r_s + B c. -> (r, c)."""
    B = _basis(x, y, w, h)
    S = np.zeros((len(x), n_staves))
    S[np.arange(len(x)), s] = 1
    A = np.hstack([S, B])
    reg = np.zeros(A.shape[1])
    reg[n_staves:] = lam            # only the surface is regularised
    wts = np.ones(len(x))
    sol = np.zeros(A.shape[1])
    for _ in range(iters):
        Aw = A * wts[:, None]
        sol = np.linalg.solve(Aw.T @ A + np.diag(reg), Aw.T @ y)
        res = np.abs(y - A @ sol)
        wts = np.where(res <= delta, 1.0, delta / np.maximum(res, 1e-9))
    return sol[:n_staves], sol[n_staves:]


def _rms_tilt_only(x, y, s, n):
    """Residual of the tilt-only page (each staff flat at its robust height)."""
    r = np.array([np.median(y[s == k]) if np.any(s == k) else 0 for k in range(n)])
    return r


def fit_surface(lines_mask: np.ndarray) -> Surface:
    """`lines_mask`: staff-line mask of the deskewed page in the analysis frame."""
    h, w = lines_mask.shape
    tracks = staff_tracks(lines_mask, N_STRIPS)
    x, y, s = _samples(tracks, min_len=10)
    n = int(s.max()) + 1 if len(s) else 0
    out = Surface(np.zeros(DEG_X * (DEG_Y + 1)), w, h)
    out.stats = {"staves": n, "samples": int(len(x))}
    if n < 3 or len(x) < 80:
        out.reason = "insufficient_tracks"
        return out
    strip = np.round(x / (w / N_STRIPS)).astype(int)
    hold = strip % 3 == 1                       # every third strip is kept out of the fit
    keep = [k for k in range(n) if np.sum((s == k) & ~hold) >= 6 and np.sum((s == k) & hold) >= 2]
    if len(keep) < 3:
        out.reason = "insufficient_tracks"
        return out
    remap = {k: i for i, k in enumerate(keep)}
    m = np.isin(s, keep)
    x, y, s, hold = x[m], y[m], np.array([remap[k] for k in s[m]]), hold[m]
    n = len(keep)
    # holdout: fitted on the other strips, judged on these
    r_fit, c_fit = _fit(x[~hold], y[~hold], s[~hold], n, w, h)
    pred = r_fit[s[hold]] + _basis(x[hold], y[hold], w, h) @ c_fit
    r_tilt = _rms_tilt_only(x[~hold], y[~hold], s[~hold], n)
    e_model = float(np.median(np.abs(y[hold] - pred)))
    e_tilt = float(np.median(np.abs(y[hold] - r_tilt[s[hold]])))
    out.gain = 0.0 if e_tilt < 1e-6 else 1 - e_model / e_tilt
    out.stats.update({"holdout_err_model": round(e_model, 3), "holdout_err_tilt": round(e_tilt, 3)})
    if e_tilt < 0.6:
        out.reason = "already_flat"
        return out
    if out.gain < 0.15:
        out.reason = "no_clear_holdout_gain"
        return out
    # final fit on everything
    _r, c = _fit(x, y, s, n, w, h)
    # geometry guard: gentle over the area of the staves (a few % of the height, no folding)
    out.box = (float(x.min()), float(x.max()), float(y.min()), float(y.max()))
    gx, gy = np.meshgrid(np.linspace(x.min(), x.max(), 48), np.linspace(y.min(), y.max(), 64))
    fv = (_basis(gx, gy, w, h) @ c)
    dfy = np.diff(fv, axis=0) / np.diff(gy, axis=0)
    dfx = np.diff(fv, axis=1) / np.diff(gx, axis=1)
    out.stats.update({"max_shift": round(float(np.abs(fv).max()), 2),
                      "max_dfdy": round(float(np.abs(dfy).max()), 4),
                      "max_dfdx": round(float(np.abs(dfx).max()), 4)})
    if np.abs(fv).max() > 0.04 * h or np.abs(dfy).max() > 0.08 or np.abs(dfx).max() > 0.15:
        out.reason = "geometry_guard"
        return out
    out.coeff = c
    out.accepted = True
    out.reason = "ok"
    return out


def lines_of(norm: np.ndarray) -> np.ndarray:
    return ip.line_mask(norm) | ip.binarize(norm, 205)


def rectify(gray: np.ndarray) -> tuple[np.ndarray, Surface, float]:
    """Full-resolution grayscale photo -> (white-background, deskewed, straightened page at the
    same resolution, surface, angle in degrees)."""
    H, W = gray.shape
    k = max(51, int(51 * W / ANALYSIS_W)) | 1
    norm = ip.normalize_background(gray, k)
    sc = ANALYSIS_W / W
    small = cv2.resize(norm, (ANALYSIS_W, round(H * sc)), interpolation=cv2.INTER_AREA)
    angle = ip.estimate_skew(ip.binarize(small, 205))
    small_r = ip.rotate(small, angle)
    surf = fit_surface(lines_of(small_r))
    # one resampling: output (X, Y) -> rotated frame (X, Y + f) -> photo (inverse rotation)
    M = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)   # photo -> rotated
    Mi = cv2.invertAffineTransform(M)                          # rotated -> photo
    xs = np.arange(W, dtype=np.float32)
    out = np.empty_like(norm)
    band = 512                                                 # rows at a time: bounded memory
    for y0 in range(0, H, band):
        ys = np.arange(y0, min(H, y0 + band), dtype=np.float32)
        X, Y = np.meshgrid(xs, ys)
        ax, ay = X * sc, Y * sc
        d = surf.f(ax, ay)
        d = surf.f(ax, ay + d)                                  # one fixed-point step
        Yr = Y + d / sc
        mx = (Mi[0, 0] * X + Mi[0, 1] * Yr + Mi[0, 2]).astype(np.float32)
        my = (Mi[1, 0] * X + Mi[1, 1] * Yr + Mi[1, 2]).astype(np.float32)
        out[y0:y0 + len(ys)] = cv2.remap(norm, mx, my, interpolation=cv2.INTER_CUBIC,
                                         borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    return out, surf, angle
