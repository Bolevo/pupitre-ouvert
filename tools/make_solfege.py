"""Generate the sung note names of the "Nom des notes" instrument.

    python tools/make_solfege.py                 # fetch + build MBROLA if needed, render all
    python tools/make_solfege.py --work DIR      # where MBROLA and its voices live / go
    python tools/make_solfege.py --out DIR       # elsewhere than app/public/sf/solfege

Output: app/public/sf/solfege/<name>_<voice>_<midi>.flac (mono, 16-bit, the voice's own rate),
manifest.json and LICENSE.txt. Requires gcc + make + git (to build MBROLA), numpy, soundfile,
pyworld (pip).

The instrument (app/src/audio/solfege.ts) sings the name of the note (do ré mi fa sol la si, the
accidental is not said) at the start of the note, ON THE NOTE'S OWN PITCH; a choir "ah" then holds
the pitch. One file per name and semitone over each voice's range (a man's voice for the low
parts, a woman's for soprano and alto): nothing is transposed in the app, and the name no longer
jumps an octave when the melody leaves the voice's speaking range (what the version of 10/2026
did: the name was spoken in a span of one octave, the note folded into it).

Pipeline, per file:
1. MBROLA (diphone synthesizer, https://github.com/numediart/MBROLA, AGPL-3.0) renders the
   syllable ONCE per voice, at a flat pitch in the middle of the voice's speaking range (REF), with
   the French voices fr1 (male, 16 kHz) or fr4 (female, 22.05 kHz) from
   https://github.com/numediart/MBROLA-voices (free for non-commercial use, with MBROLA only).
   MBROLA itself cannot sing: fr1 refuses above 330 Hz and loses the vowel before, and its
   rendering changes from one pitch to the next.
2. WORLD vocoder (pyworld, MIT; WORLD by M. Morise, modified BSD) analyses that one rendering
   (CheapTrick envelope, D4C aperiodicity, the pitch is MBROLA's known constant one): every note
   is then synthesised from the same analysis, at exactly its equal-tempered pitch, so the voice is
   the same from one note to the next. The voiced part is a sum of exact harmonics whose levels
   follow the envelope (see `harmonics`), the rest (breath, f, s) WORLD's noise. Two things are
   done to the envelope of the voiced frames, as a singer does:
   - the first formant is kept above the pitch (HEADROOM). A vowel whose first formant is under
     the note sung (the "i" of mi and si from B3 up for the man, every vowel at the top of the
     soprano) loses its fundamental and nearly all its level: measured -17 dB for "mi" on A4 by
     the man, inaudible on A5 by the woman. Singers open the vowel for that reason;
   - all formants move a little with the pitch (ratio ** FORMANT_FOLLOW: +11 % for the man's
     A4, -4 % for his low D), a smaller voice for a higher note.
   An unvoiced consonant (f, s) has no pitch: MBROLA's own is kept and WORLD takes over at the
   first voiced frame.
3. Levels. The head consonant is set against the vowel (CONS: a share of the vowel's RMS, the
   same on every note): as spoken, "f" is 16 dB under its vowel and "d" 12 dB, and against a choir
   "fa" and "la", "do" and "sol" could not be told apart. Trimmed, faded, 16-bit FLAC.

Manifest zone: name, voice ("m" | "f"), file, root (MIDI), cents (the file sounds at
root + cents/100; measured, a fraction of a cent), sr, onset (s from the start of the file to the
vowel: played before the beat so that the vowel lands on it), gain (brings the vowel to RMS
TARGET_RMS). `spans`: the notes each voice has a file for; outside it the app says the name one
or more octaves away (piano only, in practice).
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "public" / "sf" / "solfege"
DEFAULT_WORK = Path.home() / ".cache" / "pupitre-mbrola"

MBROLA_REPO = "https://github.com/numediart/MBROLA.git"
MBROLA_COMMIT = "274dead162f2826dc38c208fba92efeddb724c33"
VOICES_REPO = "https://github.com/numediart/MBROLA-voices.git"
VOICES_COMMIT = "fe05a0ccef6a941207fd6aaad0b31294a1f93a51"

# voice -> (MBROLA voice, lowest and highest MIDI note rendered). Man: D2..C5 (basses and tenors);
# woman: E3..C6 (altos and sopranos).
VOICES = {"m": ("fr1", 38, 72), "f": ("fr4", 52, 84)}
# Hz asked from MBROLA: the middle of each voice's speaking range (fr4's is given as 200 Hz)
REF = {"m": 120.0, "f": 200.0}
TARGET_RMS = 0.12
LEAD_S = 0.010
FADE_IN_S, FADE_OUT_S = 0.003, 0.04
FRAME_MS = 2.0
HEADROOM = 1.15          # the first formant's upper edge stays at least this far above the pitch
FORMANT_FOLLOW = 0.08    # formants move by (sung pitch / MBROLA's pitch) ** this

# syllable: phones (SAMPA, ms). The consonant is a quarter longer than spoken (it is sung before
# the beat, and it is what tells the names apart on a high note, where the vowels all open), the
# vowel a little long, as when naming notes.
SYL = {
    "do": [("d", 70), ("o", 230)],
    "re": [("R", 75), ("e", 230)],
    "mi": [("m", 80), ("i", 230)],
    "fa": [("f", 110), ("a", 230)],
    "sol": [("s", 120), ("O", 190), ("l", 80)],
    "la": [("l", 75), ("a", 230)],
    "si": [("s", 120), ("i", 230)],
}
VOWELS = set("aeiouyEO@29")
VOICED_CONS = set("dRml")
DISPLAY = {"do": "do", "re": "ré", "mi": "mi", "fa": "fa", "sol": "sol", "la": "la", "si": "si"}
PITCH_CLASS = {"do": 0, "re": 2, "mi": 4, "fa": 5, "sol": 7, "la": 9, "si": 11}

# Upper edge (Hz) of the first formant of each sound, where the envelope starts to fall away:
# measured on the two voices (CheapTrick envelope of MBROLA at 105 / 195 Hz, -3..-6 dB point).
EDGE = {
    "m": {"i": 300, "e": 400, "o": 380, "O": 500, "a": 800, "m": 280, "l": 300, "d": 220, "R": 300},
    "f": {"i": 270, "e": 430, "o": 430, "O": 580, "a": 950, "m": 280, "l": 400, "d": 230, "R": 300},
}
# Level of the head consonant, as a share of the vowel's RMS (as spoken by these voices: d 0.25,
# R 0.35, m 0.7, f 0.10-0.15, s 0.25-0.4, l 0.6-1.0). A voiced one is a murmur on the note: it is
# raised less (CONS_GAIN: least and most, voiced / unvoiced) than the noise of f and s.
CONS = {"d": 0.30, "R": 0.45, "m": 0.75, "f": 0.35, "s": 0.50, "l": 0.70}
CONS_GAIN = {True: (0.7, 2.0), False: (0.7, 4.0)}


def midi_hz(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def names_at(midi):
    """The names a note of this pitch can have with at most one sharp or flat."""
    return [n for n, pc in PITCH_CLASS.items() if min((midi - pc) % 12, (pc - midi) % 12) <= 1]


def ensure_mbrola(work: Path):
    work.mkdir(parents=True, exist_ok=True)
    src, voices = work / "MBROLA", work / "MBROLA-voices"
    if not (src / "Bin" / "mbrola").exists():
        if not src.exists():
            subprocess.run(["git", "clone", MBROLA_REPO, str(src)], check=True)
        subprocess.run(["git", "-C", str(src), "checkout", "-q", MBROLA_COMMIT], check=True)
        subprocess.run(["make", "-C", str(src)], check=True, capture_output=True)
    names = [v[0] for v in VOICES.values()]
    if not all((voices / "data" / v / v).exists() for v in names):
        if not voices.exists():
            subprocess.run(["git", "clone", "--filter=blob:none", "--sparse", VOICES_REPO,
                            str(voices)], check=True)
        subprocess.run(["git", "-C", str(voices), "sparse-checkout", "set",
                        *[f"data/{v}" for v in names]], check=True)
        subprocess.run(["git", "-C", str(voices), "checkout", "-q", VOICES_COMMIT], check=True)
    return src / "Bin" / "mbrola", voices / "data"


def mbrola(binary, voice_db, phones, f0, tmp: Path):
    """Render phones [(sampa, ms)] at a flat pitch f0. Returns (signal float64, sr)."""
    pho = "".join(f"{p} {d} 0 {f0:.4f} 100 {f0:.4f}\n" for p, d in phones)
    (tmp / "in.pho").write_text(pho)
    r = subprocess.run([str(binary), str(voice_db), str(tmp / "in.pho"), str(tmp / "out.wav")],
                       capture_output=True, text=True)
    if r.returncode != 0 or "rror" in r.stderr or "PANIC" in r.stderr:
        raise RuntimeError(f"mbrola failed: {r.stderr.strip()}")
    y, sr = sf.read(tmp / "out.wav", dtype="float64")
    return y, sr


def mbrola_near(binary, voice_db, phones, f, tmp):
    """MBROLA near f, at a pitch whose period is a whole number of samples (it uses
    floor(sr / f0): asked a little under sr / P). It refuses some pitches for some diphones
    ("check your pitch"): the next periods are tried. Returns (signal, sr, exact pitch)."""
    _, sr = mbrola(binary, voice_db, [("_", 20)], 120.0, tmp)       # the voice's rate
    for dp in (0, 1, -1, 2, -2, 3, -3):
        period = int(round(sr / f)) + dp
        try:
            y, sr = mbrola(binary, voice_db, phones, sr / (period + 0.3), tmp)
            return y, sr, sr / period
        except RuntimeError:
            continue
    raise RuntimeError(f"MBROLA refuses every pitch near {f:.1f} Hz")


def fine_f0(seg, sr, guess):
    """Pitch (Hz) of a steady voiced segment, within 60 cents of `guess`: the candidate whose
    harmonics carry the most energy (1-cent steps, then a parabola through the best three)."""
    n = len(seg)
    w = np.hanning(n)
    k = np.arange(1, max(2, min(12, int(0.45 * sr / guess))) + 1)
    t = np.arange(n) / sr
    cents = np.arange(-60, 61)
    power = np.empty(len(cents))
    for i, c in enumerate(cents):
        f = guess * 2.0 ** (c / 1200.0)
        power[i] = np.sum(np.abs(np.exp(-2j * np.pi * np.outer(k * f, t)) @ (seg * w)) ** 2)
    i = int(np.argmax(power))
    if 0 < i < len(cents) - 1:
        a, b, c = power[i - 1], power[i], power[i + 1]
        return guess * 2.0 ** ((cents[i] + 0.5 * (a - c) / (a - 2 * b + c)) / 1200.0)
    return guess * 2.0 ** (cents[i] / 1200.0)


def warp(env, sr, edge, edge_to, alpha):
    """Each frame's envelope (rows) redrawn along frequency: what was at edge[i] Hz goes to
    edge_to[i], what was at K / alpha goes to K (above K: everything simply moved by alpha),
    straight lines in between. K is well above the first formant, under the second of "i"."""
    n = env.shape[1]
    f = np.linspace(0.0, sr / 2, n)
    top = sr / 2 * max(1.0, alpha) + 1.0
    out = np.empty_like(env)
    for i in range(env.shape[0]):
        k = max(2.2 * edge_to[i], 1500.0 * alpha)
        src = np.interp(f, [0.0, edge_to[i], k, top], [0.0, edge[i], k / alpha, top / alpha])
        out[i] = np.interp(src, f, env[i])
    return out


def min_phase(mag):
    """Phase (rad) of the minimum-phase spectrum that has this magnitude (rfft grid)."""
    log = np.log(np.maximum(mag, 1e-9))
    full = np.concatenate([log, log[-2:0:-1]])
    cep = np.fft.ifft(full).real
    n = len(full)
    fold = np.zeros(n)
    fold[0] = fold[n // 2] = 1.0
    fold[1:n // 2] = 2.0
    return np.imag(np.fft.fft(cep * fold))[:len(mag)]


def harmonics(f0, power, voiced, sr, n):
    """The voiced part as a sum of harmonics of exactly f0: their levels follow the envelope
    (`power`, one row per frame), their phases never move. (WORLD's own synthesis filters each
    pulse through the envelope of its instant: when a formant moves, as it does all along a
    diphone, the phases move with it and the pitch wanders, 10 to 20 cents measured.) The phases
    are those of a natural pulse: the minimum phase of the vowel's mean envelope."""
    bins = power.shape[1]
    freq = np.linspace(0.0, sr / 2, bins)
    k = np.arange(1, int(0.47 * sr / f0) + 1)
    amp = np.sqrt(np.array([np.interp(k * f0, freq, row) for row in power])) * voiced[:, None]
    amp *= np.clip((0.47 * sr - k * f0) / (0.03 * sr), 0.0, 1.0)      # faded out near Nyquist
    phase = np.interp(k * f0, freq, min_phase(np.sqrt(power[voiced].mean(0))))
    t = np.arange(n) / sr
    at = np.arange(len(power)) * FRAME_MS / 1000.0
    x = np.zeros(n)
    for j, h in enumerate(k):
        x += np.interp(t, at, amp[:, j]) * np.cos(2 * np.pi * h * f0 * t + phase[j])
    return x


def reference(binary, voices, name, voice, tmp):
    """MBROLA's rendering of the syllable and its analysis: everything a note is sung from."""
    vdb = VOICES[voice][0]
    phones = [("_", 50)] + SYL[name] + [("_", 80)]
    y, sr, f_ref = mbrola_near(binary, voices / vdb / vdb, phones, REF[voice], tmp)
    edges = np.cumsum([0] + [d for _, d in phones]) / 1000.0
    t = np.arange(int(len(y) / sr * 1000 / FRAME_MS) + 1) * FRAME_MS / 1000.0
    vi = next(i for i, (p, _) in enumerate(phones) if p in VOWELS)
    v0, v1 = edges[vi], edges[vi + 1]
    # voiced frames: where the phones can be voiced and the signal is (the vowel always)
    can = np.zeros(len(t), bool)
    for (p, _), a, b in zip(phones, edges[:-1], edges[1:]):
        if p in VOWELS or p in VOICED_CONS:
            can |= (t >= a - 0.005) & (t < b + 0.03)
    fh, _ = pw.harvest(y, sr, f0_floor=f_ref * 0.7, f0_ceil=f_ref * 1.4, frame_period=FRAME_MS)
    fh = fh[:len(t)] if len(fh) >= len(t) else np.pad(fh, (0, len(t) - len(fh)))
    voiced = can & ((fh > 0) | ((t >= v0 + 0.01) & (t < v1 - 0.01)))
    f0 = np.where(voiced, f_ref, 0.0)
    sp = pw.cheaptrick(y, f0, t, sr, f0_floor=min(71.0, f_ref * 0.8))
    ap = pw.d4c(y, f0, t, sr)
    # the first formant's edge along the syllable (flat in each phone, a line between two)
    at, hz = [], []
    for (p, _), a, b in zip(phones, edges[:-1], edges[1:]):
        if p in EDGE[voice]:
            at += [a + 0.25 * (b - a), b - 0.25 * (b - a)]
            hz += [EDGE[voice][p]] * 2
    return dict(y=y, sr=sr, f_ref=f_ref, phones=phones, edges=edges, t=t, voiced=voiced, sp=sp, ap=ap,
                edge=np.interp(t, at, hz), v0=v0, v1=v1)


def sing(ref, midi):
    """The syllable sung at the pitch of `midi`, from its reference. Returns the signal, and its
    voiced part alone."""
    y, sr, t, voiced, n = ref["y"], ref["sr"], ref["t"], ref["voiced"], len(ref["y"])
    target = midi_hz(midi)
    alpha = (target / ref["f_ref"]) ** FORMANT_FOLLOW
    edge_to = np.maximum(ref["edge"] * alpha, HEADROOM * target)
    sp = np.where(voiced[:, None], warp(ref["sp"], sr, ref["edge"], edge_to, alpha), ref["sp"])
    ap = np.where(voiced[:, None], warp(ref["ap"], sr, ref["edge"], edge_to, alpha), ref["ap"])
    # the periodic part of the voiced frames, and everything else (breath, unvoiced sounds)
    periodic = np.where(voiced[:, None], sp * (1.0 - ap ** 2), 1e-16)
    noise = np.where(voiced[:, None], sp * ap ** 2, sp)
    f0s = np.ascontiguousarray(np.where(voiced, target, 0.0))

    def world(env, aperiodicity):
        w = pw.synthesize(f0s, np.ascontiguousarray(env), np.ascontiguousarray(np.full_like(env, aperiodicity)), sr, FRAME_MS)
        return w[:n] if len(w) >= n else np.pad(w, (0, n - len(w)))

    xh = harmonics(target, periodic, voiced, sr, n)
    steady = slice(int((ref["v0"] + 0.04) * sr), int((ref["v1"] - 0.02) * sr))
    # WORLD's own periodic part gives the level (its envelope is a power density, not amplitudes)
    xh *= rms(world(periodic, 1e-6)[steady]) / rms(xh[steady])
    x = xh + world(noise, 1.0)
    first_voiced = t[int(np.argmax(voiced))]
    if first_voiced > ref["edges"][1] + 0.02:        # an unvoiced consonant: MBROLA's own
        a, b = int((first_voiced - 0.012) * sr), int((first_voiced - 0.002) * sr)
        w = np.zeros(n)
        w[:a] = 1.0
        w[a:b] = np.linspace(1.0, 0.0, b - a)
        x = w * y + (1.0 - w) * x
    return x, xh


def rms(x):
    return float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0


def render(ref, name, voice, midi):
    (x, voiced_part), sr, phones = sing(ref, midi), ref["sr"], ref["phones"]
    c0, v0, v1 = ref["edges"][1], ref["v0"], ref["v1"]
    # The beat goes where the vowel starts. After f or s the voice comes in a little after the phone
    # is said to start (the diphone's noise runs into it): where the voiced part reaches 40 % of
    # its steady level.
    beat = v0
    if phones[1][0] not in VOICED_CONS:
        win = int(0.01 * sr)
        level = np.sqrt(np.convolve(voiced_part ** 2, np.ones(win) / win, "same"))
        beat = max(v0, float(np.argmax(level > 0.4 * rms(voiced_part[int((v0 + 0.04) * sr):int((v1 - 0.02) * sr)]))) / sr)
    steady = slice(int((v0 + 0.04) * sr), int((v1 - 0.02) * sr))
    # the head consonant against the vowel
    head = phones[1][0]
    cons = rms(x[int(c0 * sr):int(v0 * sr)])
    g = float(np.clip(CONS[head] * rms(x[steady]) / (cons + 1e-9), *CONS_GAIN[head in VOICED_CONS]))
    a, b = int((v0 - 0.012) * sr), int((v0 + 0.008) * sr)
    env = np.ones(len(x))
    env[:a] = g
    env[a:b] = 1.0 + (g - 1.0) * 0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, b - a)))
    x = x * env
    f = fine_f0(x[steady], sr, midi_hz(midi))
    cents = 1200 * np.log2(f / midi_hz(midi))
    # trim, fade
    peak = np.abs(x).max()
    nz = np.nonzero(np.abs(x) > 2e-3 * peak)[0]
    first = max(0, int(nz[0] - LEAD_S * sr))
    last = min(len(x), int(nz[-1] + 0.01 * sr))
    x = x[first:last].copy()
    n_in, n_out = int(FADE_IN_S * sr), int(FADE_OUT_S * sr)
    x[:n_in] *= np.linspace(0, 1, n_in) ** 2
    x[-n_out:] *= np.linspace(1, 0, n_out) ** 2
    x *= 0.9 / np.abs(x).max()
    q = np.round(x * 32767).astype(np.int16)
    xq = q.astype(np.float64) / 32768.0
    a, b = int(v0 * sr) - first, int(v1 * sr) - first
    level = rms(xq[a + int(0.04 * sr):b - int(0.02 * sr)])
    return dict(name=name, voice=voice, file=f"{name}_{voice}_{midi}.flac", root=midi,
                cents=round(float(cents), 2), sr=sr, onset=round(beat - first / sr, 4),
                gain=round(TARGET_RMS / level, 5), _pcm=q, _cons=g)


LICENSE_TXT = """Nom des notes (sung note names) - sources and licenses
=======================================================

Every file in this folder was synthesised by tools/make_solfege.py with:

* MBROLA speech synthesizer, https://github.com/numediart/MBROLA (commit {mc})
  License: GNU Affero General Public License v3.0. Only the program's output is stored here.

* MBROLA French diphone voices, https://github.com/numediart/MBROLA-voices (commit {vc})
  - fr1 (files *_m_*): French male voice, (c) 1998 Faculte Polytechnique de Mons -
    TCTS lab (Thierry Dutoit).
  - fr4 (files *_f_*): French female voice, (c) Faculte Polytechnique de Mons;
    original diphone database (c) Babel Technologies SA, Belgium.
  Terms (MBROLA-voices LICENSE.md and each voice's licence): "Permission is granted to use this
  database for synthesizing speech with and only with MBROLA program made available from the
  MBROLA project web page [...] this database may not be sold or incorporated into any product
  which is sold without prior permission from the particular author of the voice database file.
  When no charge is made, this database may be copied and distributed freely, provided that
  this notice is copied and distributed with it." The databases carry no warranty.

* WORLD vocoder (M. Morise, modified BSD licence) through pyworld (MIT): analysis and synthesis
  of MBROLA's output. Only the result is stored here.

Use here: NON-COMMERCIAL ONLY. These sounds are speech synthesised with the MBROLA program from
those databases, for a personal, free choir-practice tool (Pupitre). They must not be sold or
included in a product that is sold without permission from the voice authors (fr1: Faculte
Polytechnique de Mons / T. Dutoit; fr4: Babel Technologies, now Acapela Group).

Processing: MBROLA renders each name once per voice, at a flat pitch in the voice's speaking
range; from WORLD's analysis of it each note is synthesised at its exact pitch, the first formant
kept above that pitch; the consonant is levelled against the vowel; trimmed, faded, 16-bit FLAC.
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", type=Path, default=DEFAULT_WORK)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args(argv)
    binary, voices = ensure_mbrola(a.work)
    tmp = a.work / "tmp"
    tmp.mkdir(exist_ok=True)
    if a.out.exists():
        shutil.rmtree(a.out)
    a.out.mkdir(parents=True)
    zones, worst = [], 0.0
    for voice, (_vdb, lo, hi) in VOICES.items():
        refs = {name: reference(binary, voices, name, voice, tmp) for name in SYL}
        for midi in range(lo, hi + 1):
            for name in names_at(midi):
                z = render(refs[name], name, voice, midi)
                sf.write(a.out / z["file"], z["_pcm"], z["sr"], subtype="PCM_16", format="FLAC")
                print(f"{z['file']:14s} cents={z['cents']:+6.2f} onset={z['onset']:.3f}s "
                      f"len={len(z['_pcm']) / z['sr']:.2f}s gain={z['gain']} consonant x{z['_cons']:.2f}")
                worst = max(worst, abs(z["cents"]))
                zones.append({k: v for k, v in z.items() if not k.startswith("_")})
    manifest = {
        "id": "solfege",
        "name": "Nom des notes",
        "kind": "sung-names",
        "source": "MBROLA diphone synthesis (github.com/numediart/MBROLA) with the French voices "
                  "fr1 (male, low parts) and fr4 (female, high parts) from "
                  "github.com/numediart/MBROLA-voices, brought to the pitch of each note with the "
                  "WORLD vocoder (pyworld); generated by tools/make_solfege.py",
        "license": "MBROLA voices: non-commercial use only, must not be sold; see LICENSE.txt",
        "names": DISPLAY,
        "spans": {v: [lo, hi] for v, (_vdb, lo, hi) in VOICES.items()},
        "zones": zones,
    }
    (a.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
                                         encoding="utf-8")
    (a.out / "LICENSE.txt").write_text(LICENSE_TXT.format(mc=MBROLA_COMMIT, vc=VOICES_COMMIT),
                                       encoding="utf-8")
    total = sum(p.stat().st_size for p in a.out.iterdir())
    print(f"{len(zones)} zones, {total / 1e6:.2f} MB in {a.out}; pitch within {worst:.2f} cents")
    if worst > 3.0:
        print("a file is more than 3 cents off its note", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
