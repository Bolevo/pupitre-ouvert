"""Offline checks of the looped multi-samples in app/public/sf/<id>/ (see tools/extract_sf2.py).

    python tools/check_sf.py                 # validate every instrument in app/public/sf
    python tools/check_sf.py DIR [DIR ...]   # validate given instrument folders
    python tools/check_sf.py --metrics DIR   # also per-zone quality metrics (used to pick sources)

Validation (each instrument), rendering long notes through the loop with numpy:
  * click at the loop seam: second difference across the seam vs. the 99.9th percentile of the
    second difference inside the loop (ratio <= 2 passes) and spectral flux at the seam vs. the
    median flux inside the loop;
  * pitch of every key 36..84 within +-5 cents of equal temperament (A4 = 440 Hz);
  * level: sustained RMS * gain of each key within +-3 dB of the instrument median.
Metrics (--metrics), per zone: tuning error of the declared root+cents, loop length, vibrato
(pitch modulation depth / rate inside the loop), tremolo (loudness modulation depth / rate),
harmonic-to-noise ratio (up to 8 kHz; low for ensembles, whose harmonics are smeared), noise
floor between 0.6 and 0.9 x Nyquist relative to the harmonic peaks (HFfloor) and the energy of
that band relative to the whole signal (HFrel, i.e. how audible hiss / breath can be).
Requires numpy, scipy and ffmpeg.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[1]
KEYS = range(36, 85)


def read_flac(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1",
                        "pipe:1"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, "<i2").astype(np.float64) / 32768.0


def midi_hz(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


# ---------------------------------------------------------------- pitch
def harmonic_pitch(y, sr, f_guess, span_cents=100.0, fmax=4000.0):
    """Mean f0 (Hz) of a sustained tone, robust to vibrato and to ensemble spread (choirs).

    1. coarse: harmonic sum on the magnitude spectrum, searched +-span_cents around f_guess;
    2. fine: power-weighted centroid of each harmonic (+-35 cents, noise floor removed), each
       divided by its harmonic number, averaged with the harmonic powers as weights (iterated).
    For an ensemble this is the power-weighted mean pitch of the voices, i.e. what is heard."""
    n = len(y)
    w = np.hanning(n)
    nfft = 1 << int(np.ceil(np.log2(n * 4)))
    pw = np.abs(np.fft.rfft((y - y.mean()) * w, nfft)) ** 2
    df = sr / nfft
    kmax = max(2, int(min(fmax, 0.45 * sr) / (f_guess * 2 ** (span_cents / 1200))))
    k = np.arange(1, kmax + 1)
    mag = np.sqrt(pw)
    grid = f_guess * 2 ** (np.arange(-span_cents, span_cents + 0.01, 1.0) / 1200)
    v = np.interp(k[:, None] * grid[None, :] / df, np.arange(len(mag)), mag)
    f0 = float(grid[int(np.argmax((v / np.sqrt(k)[:, None]).sum(0)))])
    floor = np.median(pw)
    for _ in range(3):
        num = den = 0.0
        for kk in k:
            lo = int(kk * f0 * 2 ** (-35 / 1200) / df)
            hi = int(np.ceil(kk * f0 * 2 ** (35 / 1200) / df)) + 1
            if hi >= len(pw):
                break
            p = np.maximum(pw[lo:hi] - floor, 0)
            if p.sum() <= 0:
                continue
            fc = (np.arange(lo, hi) * df * p).sum() / p.sum()
            num += p.sum() * fc / kk
            den += p.sum()
        if den <= 0:
            break
        f0 = num / den
    return float(f0)


def measure_pitch(y, sr, f_guess, span_cents=60.0):
    """Robust mean f0 of a sustained segment: the harmonic centroid and the median of a frame
    pitch track, averaged when they agree within 6 cents, else the track median (ensembles)."""
    f1 = harmonic_pitch(y, sr, f_guess, span_cents)
    tr, _ = pitch_track(y, sr, f1)
    tr = tr[np.isfinite(tr) & (tr > 0)]
    if not len(tr):
        return f1
    f2 = float(np.median(tr))
    return float(np.sqrt(f1 * f2)) if abs(cents(f1, f2)) <= 6 else f2


def cents(f, ref):
    return 1200.0 * np.log2(f / ref)


def tile_loop(x, ls, le, seconds, sr):
    """Attack + loop repeated to `seconds` (a looped sample never plays beyond loopEnd)."""
    n = int(seconds * sr)
    if ls is None:
        return x[:n]
    out = [x[:le]]
    total = le
    loop = x[ls:le]
    while total < n:
        out.append(loop)
        total += len(loop)
    return np.concatenate(out)[:n]


def loop_only(x, ls, le, seconds, sr):
    loop = x[ls:le]
    reps = int(np.ceil(seconds * sr / len(loop)))
    return np.tile(loop, reps)[: int(seconds * sr)]


# ---------------------------------------------------------------- seam
def seam_metrics(x, ls, le, sr):
    loop = x[ls:le]
    d2 = np.abs(np.diff(loop, 2))
    ref = np.percentile(d2, 99.9) + 1e-9
    seam = np.concatenate([x[le - 2:le], x[ls:ls + 2]])
    seam_d2 = np.abs(np.diff(seam, 2)).max()
    jump = abs(x[ls] - x[le - 1])
    # spectral flux at the seam vs inside the loop
    nfr = 1024 if sr >= 22050 else 512
    reps = max(3, int(np.ceil(8 * nfr / len(loop))))
    tiled = np.tile(loop, reps)
    hop = nfr // 4
    win = np.hanning(nfr)
    frames = np.lib.stride_tricks.sliding_window_view(tiled, nfr)[::hop]
    spec = np.log(np.abs(np.fft.rfft(frames * win, axis=1)) + 1e-6)
    flux = np.sqrt((np.diff(spec, axis=0) ** 2).mean(1))
    centres = np.arange(len(flux)) * hop + nfr // 2 + hop // 2
    seams = [len(loop) * i for i in range(1, reps)]
    near = np.zeros(len(flux), bool)
    for s in seams:
        near |= np.abs(centres - s) < nfr // 2
    flux_ratio = float(flux[near].max() / (np.median(flux[~near]) + 1e-9)) if near.any() and (~near).any() else float("nan")
    return dict(seam_d2_ratio=float(seam_d2 / ref), seam_jump=float(jump), flux_ratio=flux_ratio)


# ---------------------------------------------------------------- modulation
def pitch_track(y, sr, f0, frame_s=0.064, hop_s=0.01):
    n = int(frame_s * sr)
    n += n & 1
    hop = int(hop_s * sr)
    nfft = 1 << int(np.ceil(np.log2(n * 4)))
    w = np.hanning(n)
    kmax = max(1, int(min(3000.0, 0.45 * sr) / f0))
    out = []
    for i in range(0, len(y) - n, hop):
        mag = np.abs(np.fft.rfft(y[i:i + n] * w, nfft))
        df = sr / nfft
        est, wts = [], []
        for k in range(1, kmax + 1):
            c = k * f0 / df
            lo, hi = int(c * 2 ** (-0.6 / 12)), int(np.ceil(c * 2 ** (0.6 / 12))) + 1
            if hi + 1 >= len(mag) or lo < 1:
                break
            j = lo + int(np.argmax(mag[lo:hi]))
            a, b, cc = np.log(mag[j - 1:j + 2] + 1e-12)
            p = 0.5 * (a - cc) / (a - 2 * b + cc) if (a - 2 * b + cc) != 0 else 0.0
            est.append((j + p) * df / k)
            wts.append(mag[j])
        if est:
            out.append(np.average(est, weights=np.array(wts) ** 2))
    return np.array(out), 1.0 / hop_s


def modulation(track, rate_hz, lo=2.0, hi=12.0):
    """Depth (peak-to-peak of the 2-12 Hz component, from its RMS) and dominant rate."""
    t = track - np.polyval(np.polyfit(np.arange(len(track)), track, 1), np.arange(len(track)))
    spec = np.fft.rfft(t * np.hanning(len(t)))
    f = np.fft.rfftfreq(len(t), 1.0 / rate_hz)
    band = (f >= lo) & (f <= hi)
    bandpassed = np.fft.irfft(np.where((f >= lo) & (f <= hi), np.fft.rfft(t), 0), len(t))
    depth_pp = 2 * np.sqrt(2) * bandpassed.std()
    rate = float(f[band][np.argmax(np.abs(spec[band]))]) if band.any() else float("nan")
    return float(depth_pp), rate


def envelope_db(y, sr, frame_s=0.04):
    n = int(frame_s * sr)
    hop = n // 2
    fr = np.lib.stride_tricks.sliding_window_view(y, n)[::hop]
    return 10 * np.log10((fr ** 2).mean(1) + 1e-12), sr / hop


def noise_metrics(seg, sr, f0):
    w = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * w)) ** 2
    f = np.fft.rfftfreq(len(seg), 1.0 / sr)
    top = min(8000.0, 0.45 * sr)
    sel = (f > 0.5 * f0) & (f < top)
    k = np.round(f / f0)
    harm = (k >= 1) & (np.abs(f - k * f0) < np.maximum(3 * sr / len(seg), 0.03 * f0))
    hnr = 10 * np.log10(spec[sel & harm].sum() / (spec[sel & ~harm].sum() + 1e-20))
    hf = (f > 0.6 * sr / 2) & (f < 0.9 * sr / 2)
    floor = 10 * np.log10(np.median(spec[hf]) / (np.median(spec[sel & harm]) + 1e-20)) if hf.any() else float("nan")
    hf_rel = 10 * np.log10(spec[hf].sum() / (spec.sum() + 1e-20) + 1e-20) if hf.any() else float("nan")
    return float(hnr), float(floor), float(hf_rel)


# ---------------------------------------------------------------- per zone / instrument
def load(folder):
    folder = Path(folder)
    m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    for z in m["zones"]:
        z["pcm"] = read_flac(folder / z["file"])
    return m


def zone_metrics(z):
    x, sr, ls, le = z["pcm"], z["sr"], z["loopStart"], z["loopEnd"]
    f_decl = midi_hz(z["root"] + z["cents"] / 100.0)
    r = dict(file=z["file"], lo=z["lo"], hi=z["hi"], root=z["root"], sr=sr)
    if ls is None:
        seg = x[int(0.2 * sr): int(0.2 * sr) + int(1.0 * sr)]
        r["loop_s"] = None
    else:
        seg = loop_only(x, ls, le, max(2.0, 3 * (le - ls) / sr), sr)
        r["loop_s"] = (le - ls) / sr
        r.update(seam_metrics(x, ls, le, sr))
    f_meas = measure_pitch(seg[: int(4 * sr)], sr, f_decl)
    r["tune_err"] = float(cents(f_meas, f_decl))
    # octave sanity: energy of odd harmonics of f/2 relative to harmonics of f
    if len(seg) > 0:
        tr, rate = pitch_track(loop_only(x, ls, le, 6.0, sr) if ls is not None else seg, sr, f_meas)
        tr_c = cents(tr, f_meas)
        r["vib_pp"], r["vib_rate"] = modulation(tr_c, rate, 3.0, 9.0)
        env, erate = envelope_db(loop_only(x, ls, le, 6.0, sr) if ls is not None else seg, sr)
        r["trem_pp"], r["trem_rate"] = modulation(env, erate, 1.0, 12.0)
        env_c = env - env.mean()
        r["env_range"] = float(np.percentile(env_c, 97) - np.percentile(env_c, 3))
        one = x[ls:le] if ls is not None else seg
        if len(one) < sr // 4:
            one = loop_only(x, ls, le, 0.5, sr)
        r["hnr"], r["hf_floor"], r["hf_rel"] = noise_metrics(one, sr, f_meas)
    return r


def render_note(z, key, seconds=4.0):
    x, sr, ls, le = z["pcm"], z["sr"], z["loopStart"], z["loopEnd"]
    ratio = 2.0 ** ((key - z["root"] - z["cents"] / 100.0) / 12.0)
    src = tile_loop(x, ls, le, seconds * ratio + 0.1, sr)
    up = 4
    hi = resample_poly(src, up, 1)
    pos = np.arange(0, len(hi) - 1, up * ratio)
    y = np.interp(pos, np.arange(len(hi)), hi)
    seams = []
    if ls is not None:
        p = le
        while p < len(src):
            seams.append(int(p / ratio))
            p += le - ls
    return y[: int(seconds * sr)], seams


def zone_for(m, key):
    for z in m["zones"]:
        if z["lo"] <= key <= z["hi"]:
            return z
    return None


def validate(folder, metrics=False, verbose=True):
    m = load(folder)
    name = Path(folder).name
    problems, rows = [], []
    covered = [k for k in KEYS if zone_for(m, k) is not None]
    if len(covered) != len(KEYS):
        problems.append(f"keys not covered: {sorted(set(KEYS) - set(covered))}")
    levels = {}
    worst_pitch, worst_click = 0.0, 0.0
    for key in KEYS:
        z = zone_for(m, key)
        if z is None:
            continue
        y, seams = render_note(z, key)
        sr = z["sr"]
        sus = y[int(1.0 * sr):]
        if z["loopStart"] is None:
            sus = y[int(0.05 * sr): int(0.6 * sr)]
            if f"unlooped {z['file']}" not in problems:
                problems.append(f"unlooped {z['file']}")
        if len(sus) < 2048:
            problems.append(f"key {key}: note shorter than 2048 samples")
            continue
        f = measure_pitch(sus[: int(2.5 * sr)], sr, midi_hz(key))
        err = float(cents(f, midi_hz(key)))
        worst_pitch = max(worst_pitch, abs(err))
        if abs(err) > 5:
            problems.append(f"key {key}: pitch {err:+.1f} cents")
        levels[key] = 20 * np.log10(np.sqrt(np.mean(sus ** 2)) * z["gain"] + 1e-12)
        d2 = np.abs(np.diff(y, 2))
        ref = np.percentile(d2[int(0.5 * sr):], 99.9) + 1e-9  # sustain only (not the attack)
        for s in seams:
            if 2 < s < len(y) - 3:
                c = d2[s - 3:s + 2].max() / ref
                worst_click = max(worst_click, c)
                if c > 2.0:
                    problems.append(f"key {key}: click at seam (ratio {c:.1f})")
                    break
    med = float(np.median(list(levels.values())))
    dev = {k: v - med for k, v in levels.items()}
    worst_level = max(abs(v) for v in dev.values())
    for k, v in dev.items():
        if abs(v) > 3:
            problems.append(f"key {k}: level {v:+.1f} dB vs median")
    zm, seen = [], set()
    for z in (m["zones"] if metrics else []):
        if z["file"] in seen:
            continue
        seen.add(z["file"])
        r = zone_metrics(z)
        if "centsSf" in z:
            r["tune_err_sf"] = r["tune_err"] + z["cents"] - z["centsSf"]
        zm.append(r)
    for r in zm:
        if abs(r["tune_err"]) > 5:
            problems.append(f"{r['file']}: declared tuning off by {r['tune_err']:+.1f} cents")
    summary = dict(name=name, zones=len(m["zones"]),
                   zones_36_84=sum(1 for z in m["zones"] if 36 <= z["root"] + z["cents"] / 100 <= 84.5),
                   worst_pitch=worst_pitch, worst_click=worst_click, worst_level=worst_level,
                   median_dbfs=med, problems=problems, zone_metrics=zm,
                   bytes=sum(p.stat().st_size for p in Path(folder).iterdir()))
    if verbose:
        print_summary(summary)
    return summary


def print_summary(s):
    print(f"== {s['name']}: {s['zones']} zones ({s['zones_36_84']} rooted in 36-84), "
          f"{s['bytes'] / 1e6:.2f} MB | worst pitch {s['worst_pitch']:.1f} c, worst seam "
          f"{s['worst_click']:.2f}, level spread +-{s['worst_level']:.1f} dB (median "
          f"{s['median_dbfs']:.1f} dBFS)")
    if s["zone_metrics"]:
        print("   file  keys     root  sr     loop_s tune_c (sf)  seamD2 flux  vib_pp/rate  trem_pp/rate envR  HNR  HFfloor HFrel")
        for r in s["zone_metrics"]:
            loop = f"{r['loop_s']:.3f}" if r["loop_s"] else "  -  "
            print(f"   {r['file']} {r['lo']:3d}-{r['hi']:3d}  {r['root']:3d} {r['sr']:6d} {loop:>6} "
                  f"{r['tune_err']:+5.1f} ({r.get('tune_err_sf', float('nan')):+5.1f}) {r.get('seam_d2_ratio', float('nan')):6.2f} "
                  f"{r.get('flux_ratio', float('nan')):4.2f} {r['vib_pp']:5.1f}c/{r['vib_rate']:4.1f}Hz "
                  f"{r['trem_pp']:4.1f}dB/{r['trem_rate']:4.1f}Hz {r['env_range']:4.1f} "
                  f"{r['hnr']:5.1f} {r['hf_floor']:6.1f} {r['hf_rel']:6.1f}")
    for p in s["problems"]:
        print("   FAIL", p)
    print("   OK" if not s["problems"] else f"   {len(s['problems'])} problem(s)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("dirs", nargs="*")
    ap.add_argument("--metrics", action="store_true")
    ap.add_argument("--json", help="write the summaries to this file")
    a = ap.parse_args(argv)
    dirs = a.dirs or sorted(p for p in (ROOT / "app" / "public" / "sf").iterdir() if p.is_dir())
    out = [validate(d, a.metrics) for d in dirs]
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1), encoding="utf-8")
    return 1 if any(s["problems"] for s in out) else 0


if __name__ == "__main__":
    sys.exit(main())
