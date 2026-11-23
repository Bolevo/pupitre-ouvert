"""Extract looped multi-samples from a SoundFont (SF2 / SF3) for the app's sample engine.

    python tools/extract_sf2.py list    FILE.sf2                 # presets
    python tools/extract_sf2.py inspect FILE.sf2 0:52 [--vel 90]  # resolved zones
    python tools/extract_sf2.py export  FILE.sf2 0:52 OUT_DIR --id aahs --name "Choir Aahs" \
            --source "GeneralUser GS 2.0.3" --license-file LICENSE.txt [--vel 90] [--retune]
            [--channel mix|left] [--layers REGEX,...] [--keys 36-84]
    python tools/extract_sf2.py build-all --gu GeneralUser-GS.sf2 --gu-license LICENSE.txt \
            --ms "MS Basic.sf3" --ms-license "MS Basic_License.md"   # the app's instruments

Output (read by the engine), in OUT_DIR:
  zNN.flac       mono 16-bit FLAC at the sample's native rate (lossless: loop points stay exact)
  manifest.json  {"name", "source", "license", "zones": [{"file", "lo", "hi", "root", "cents", "sr",
                  "loopStart", "loopEnd", "release", "gain", ...}]}
  LICENSE.txt

Conventions of manifest.json:
  * loopStart / loopEnd: sample frames in the stored file; the loop is [loopStart, loopEnd)
    (frame loopEnd - 1 is followed by frame loopStart). Both null for an unlooped zone.
  * cents: the stored sample sounds at MIDI pitch root + cents/100. The engine plays key k with a
    pitch ratio 2 ** ((k - root - cents/100) / 12). (SoundFont semantics: the synth *applies*
    coarseTune*100 + fineTune + pitchCorrection, so cents = -(that sum).)
  * gain: linear factor = SoundFont initialAttenuation (x0.4, as FluidSynth) times a per-instrument
    loudness normalisation (median over keys 36-84 of sustained RMS * gain = 0.12; each zone
    brought within +-1.5 dB of that median).
  * release: volume-envelope release (seconds), from releaseVolEnv (timecents).
  * Stereo pairs (linked L/R samples, or two zones of the same instrument and key range such as
    "Ahh Choir D#3-L" / "-R"): mixed to mono, (L+R)/2, when both have the same loop points and
    length (otherwise, or with --channel left, the left sample is kept). The pairs measured are
    weakly correlated (spaced microphones), so the sum adds voices without strong comb filtering.
  * The PCM ends at loopEnd + 5 ms, and those last frames are the loop's continuation
    (x[loopStart...]), not the original post-loop data: an interpolator may read past loopEnd.
  * Loop seams that click (second difference across the seam > 2x the 99.9th percentile inside the
    loop; typical of SF3, whose Vorbis coding rings before loopEnd) get a 5 ms crossfade of the
    frames before loopEnd towards those before loopStart ("seamFade" in the manifest).
  * Loops shorter than 4096 frames are repeated (whole cycles) up to >= 4096 frames.
  * --retune replaces the SoundFont's tuning by the pitch measured on the loop ("centsSf" keeps
    the SoundFont's value).

Requires numpy, soundfile (libsndfile: sample-exact Ogg Vorbis decoding for SF3) and the ffmpeg
executable (FLAC encoding).
"""
import argparse
import json
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------- generators
GEN = {
    "startAddrsOffset": 0, "endAddrsOffset": 1, "startloopAddrsOffset": 2, "endloopAddrsOffset": 3,
    "startAddrsCoarseOffset": 4, "pan": 17, "endAddrsCoarseOffset": 12,
    "initialFilterFc": 8, "initialFilterQ": 9,
    "delayVolEnv": 33, "attackVolEnv": 34, "holdVolEnv": 35, "decayVolEnv": 36,
    "sustainVolEnv": 37, "releaseVolEnv": 38,
    "instrument": 41, "keyRange": 43, "velRange": 44, "startloopAddrsCoarseOffset": 45,
    "initialAttenuation": 48, "endloopAddrsCoarseOffset": 50, "coarseTune": 51, "fineTune": 52,
    "sampleID": 53, "sampleModes": 54, "scaleTuning": 56, "exclusiveClass": 57,
    "overridingRootKey": 58,
}
G = GEN
DEFAULTS = {G["initialFilterFc"]: 13500, G["delayVolEnv"]: -12000, G["attackVolEnv"]: -12000,
            G["holdVolEnv"]: -12000, G["decayVolEnv"]: -12000, G["releaseVolEnv"]: -12000,
            G["scaleTuning"]: 100, G["overridingRootKey"]: -1}
RANGE_GENS = (G["keyRange"], G["velRange"])
UNSIGNED_GENS = (G["instrument"], G["sampleID"], G["sampleModes"])
# generators that are not allowed (ignored) at preset level
INSTRUMENT_ONLY = {0, 1, 2, 3, 4, 12, 45, 50, 54, 57, 58, 46, 47}


def _cstr(b):
    return b.split(b"\0", 1)[0].decode("latin-1").strip()


class SoundFont:
    def __init__(self, path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self._pcm_cache = {}
        self._parse()

    # ---- RIFF
    def _chunks(self, off, end):
        while off + 8 <= end:
            cid = self.data[off:off + 4]
            size = struct.unpack_from("<I", self.data, off + 4)[0]
            yield cid, off + 8, size
            off += 8 + size + (size & 1)

    def _parse(self):
        d = self.data
        if d[:4] != b"RIFF" or d[8:12] != b"sfbk":
            raise ValueError("not a SoundFont file")
        lists = {}
        for cid, off, size in self._chunks(12, len(d)):
            if cid == b"LIST":
                lists[d[off:off + 4]] = {c: (o, s) for c, o, s in self._chunks(off + 4, off + size)}
        info = lists.get(b"INFO", {})
        self.info = {c.decode(): _cstr(d[o:o + s]) for c, (o, s) in info.items() if c != b"ifil"}
        if b"ifil" in info:
            o, _ = info[b"ifil"]
            self.version = struct.unpack_from("<HH", d, o)
        else:
            self.version = (2, 0)
        sdta = lists[b"sdta"]
        self.smpl = sdta[b"smpl"]
        self.sm24 = sdta.get(b"sm24")
        p = lists[b"pdta"]

        def recs(name, fmt):
            o, s = p[name]
            n = struct.calcsize(fmt)
            return [struct.unpack_from(fmt, d, o + i * n) for i in range(s // n)]

        self.phdr = recs(b"phdr", "<20sHHHIII")
        self.pbag = recs(b"pbag", "<HH")
        self.pgen = recs(b"pgen", "<HH")
        self.inst = recs(b"inst", "<20sH")
        self.ibag = recs(b"ibag", "<HH")
        self.igen = recs(b"igen", "<HH")
        self.shdr = [dict(name=_cstr(r[0]), start=r[1], end=r[2], loopStart=r[3], loopEnd=r[4],
                          sr=r[5], pitch=r[6], corr=r[7], link=r[8], type=r[9])
                     for r in recs(b"shdr", "<20sIIIIIBbHH")[:-1]]
        self.compressed = any(s["type"] & 0x10 for s in self.shdr) or self.version[0] >= 3

    @staticmethod
    def _gen_value(oper, amount):
        if oper in RANGE_GENS:
            return (amount & 0xFF, amount >> 8)
        if oper in UNSIGNED_GENS:
            return amount
        return amount - 0x10000 if amount >= 0x8000 else amount

    def _zones(self, bags, gens, first, last, link_gen):
        """List of generator dicts for bags [first, last); global zone merged as defaults."""
        out, glob = [], {}
        for b in range(first, last):
            g0, g1 = bags[b][0], bags[b + 1][0]
            z = {}
            for oper, amount in gens[g0:g1]:
                z[oper] = self._gen_value(oper, amount)
            if link_gen not in z:
                if b == first:
                    glob = z
                continue
            merged = dict(glob)
            merged.update(z)
            out.append(merged)
        return out

    def presets(self):
        return [(_cstr(r[0]), r[2], r[1], i) for i, r in enumerate(self.phdr[:-1])]

    def find_preset(self, bank, program):
        for name, b, prog, i in self.presets():
            if b == bank and prog == program:
                return i, name
        raise KeyError(f"preset {bank}:{program} not found")

    def resolve(self, bank, program, vel=90):
        """All (preset zone x instrument zone) pairs active at velocity `vel`, generators merged."""
        pi, pname = self.find_preset(bank, program)
        pz = self._zones(self.pbag, self.pgen, self.phdr[pi][3], self.phdr[pi + 1][3], G["instrument"])
        result = []
        for pzone in pz:
            ii = pzone[G["instrument"]]
            iz = self._zones(self.ibag, self.igen, self.inst[ii][1], self.inst[ii + 1][1], G["sampleID"])
            for izone in iz:
                g = dict(DEFAULTS)
                g.update(izone)
                kr = _intersect(izone.get(G["keyRange"], (0, 127)), pzone.get(G["keyRange"], (0, 127)))
                vr = _intersect(izone.get(G["velRange"], (0, 127)), pzone.get(G["velRange"], (0, 127)))
                if kr is None or vr is None or not (vr[0] <= vel <= vr[1]):
                    continue
                for oper, val in pzone.items():
                    if oper in RANGE_GENS or oper == G["instrument"] or oper in INSTRUMENT_ONLY:
                        continue
                    g[oper] = g.get(oper, DEFAULTS.get(oper, 0)) + val
                s = self.shdr[g[G["sampleID"]]]
                result.append(dict(gens=g, keyRange=kr, velRange=vr, sample=s,
                                   sampleIndex=g[G["sampleID"]], instrument=_cstr(self.inst[ii][0]),
                                   preset=pname))
        return result

    # ---- sample data
    def pcm(self, sidx):
        """Whole sample as float32 in [-1, 1) plus (loopStart, loopEnd) relative to its start."""
        if sidx in self._pcm_cache:
            return self._pcm_cache[sidx]
        s = self.shdr[sidx]
        off, size = self.smpl
        if s["type"] & 0x10 or self.version[0] >= 3:
            ogg = self.data[off + s["start"]: off + s["end"]]
            x = _ffmpeg_decode(ogg)
            ls, le = s["loopStart"], s["loopEnd"]          # SF3: relative to the sample start
        else:
            x = np.frombuffer(self.data, "<i2", s["end"] - s["start"], off + 2 * s["start"])
            x = x.astype(np.float32) / 32768.0
            ls, le = s["loopStart"] - s["start"], s["loopEnd"] - s["start"]
        self._pcm_cache[sidx] = (x, ls, le)
        return self._pcm_cache[sidx]


def _intersect(a, b):
    lo, hi = max(a[0], b[0]), min(a[1], b[1])
    return (lo, hi) if lo <= hi else None


def _ffmpeg_decode(blob):
    """Decode one SF3 Ogg Vorbis sample. libsndfile (pip soundfile) honours the Ogg granule
    positions, so the length is exact; ffmpeg pads / drops up to a block at the end."""
    try:
        import io
        import soundfile
        y, _ = soundfile.read(io.BytesIO(blob), dtype="float32", always_2d=True)
        return y[:, 0].copy()
    except ImportError:
        print("warning: pip install soundfile for sample-exact SF3 decoding", file=sys.stderr)
    r = subprocess.run(["ffmpeg", "-v", "error", "-f", "ogg", "-i", "pipe:0", "-f", "f32le",
                        "-ac", "1", "pipe:1"], input=blob, capture_output=True, check=True)
    return np.frombuffer(r.stdout, "<f4").copy()


def write_flac(path, x, sr):
    pcm = np.clip(np.round(x * 32768.0), -32768, 32767).astype("<i2")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(sr), "-ac", "1",
                    "-i", "pipe:0", "-c:a", "flac", "-compression_level", "8", str(path)],
                   input=pcm.tobytes(), check=True)


def read_flac(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1",
                        "pipe:1"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, "<i2").astype(np.float32) / 32768.0


def tc_seconds(tc):
    return 0.0 if tc <= -12000 else 2.0 ** (tc / 1200.0)




# ---------------------------------------------------------------- zone extraction
def extract_zone(sf, z, channel="left", tail_ms=5.0, min_loop=4096):
    """Mono PCM for a resolved zone, cut at loopEnd + tail; returns dict (pcm + metadata)."""
    g, s = z["gens"], z["sample"]
    x, ls, le = sf.pcm(z["sampleIndex"])
    start = g.get(0, 0) + 32768 * g.get(4, 0)
    end = len(x) + g.get(1, 0) + 32768 * g.get(12, 0)
    ls = ls + g.get(2, 0) + 32768 * g.get(45, 0) - start
    le = le + g.get(3, 0) + 32768 * g.get(50, 0) - start
    x = x[start:end].astype(np.float32)
    mode = g.get(G["sampleModes"], 0) & 3
    looped = mode in (1, 3) and 0 <= ls < le <= len(x) and le - ls >= 32
    repaired = None
    if looped:
        x, repaired = repair_seam(x[:le], ls, le, s["sr"])
        if le - ls < min_loop:
            # very short loops (single-cycle clarinet loops of 1-50 ms): repeat the cycle so the
            # loop is >= min_loop frames. Lossless, and an engine that rescales the loop points
            # to another sample rate (rounding them) then errs by < 0.5/min_loop of a period.
            reps = -(-min_loop // (le - ls))
            x = np.concatenate([x[:le]] + [x[ls:le]] * (reps - 1))
            le = ls + reps * (le - ls)
        # tail: the loop's continuation (not the sample's post-loop data), so that an
        # interpolator reading a few samples past loopEnd still sees the looped signal
        tail = min(int(s["sr"] * tail_ms / 1000), le - ls)
        x = np.concatenate([x[:le], x[ls:ls + tail]])
    root = g[G["overridingRootKey"]] if g[G["overridingRootKey"]] >= 0 else s["pitch"]
    if root > 127:
        root = 60
    applied = g.get(G["coarseTune"], 0) * 100 + g.get(G["fineTune"], 0) + s["corr"]
    return dict(pcm=x.astype(np.float32), sr=s["sr"], root=int(root), cents=-float(applied),
                loopStart=int(ls) if looped else None, loopEnd=int(le) if looped else None,
                lo=z["keyRange"][0], hi=z["keyRange"][1],
                release=round(tc_seconds(g[G["releaseVolEnv"]]), 4),
                attenuation=g.get(G["initialAttenuation"], 0) / 10.0,   # dB (cB / 10)
                filterFc=g[G["initialFilterFc"]], scaleTuning=g[G["scaleTuning"]],
                sampleName=s["name"], sampleType=s["type"], link=s["link"],
                sampleIndex=z["sampleIndex"], pan=g.get(G["pan"], 0), seamRepair=repaired)


def seam_ratio(x, ls, le):
    """Second difference across the loop seam / 99.9th percentile inside the loop."""
    d2 = np.abs(np.diff(x[ls:le].astype(np.float64), 2))
    seam = np.concatenate([x[le - 2:le], x[ls:ls + 2]]).astype(np.float64)
    return float(np.abs(np.diff(seam, 2)).max() / (np.percentile(d2, 99.9) + 1e-9))


def repair_seam(x, ls, le, sr, limit=2.0, fade_s=0.005):
    """Fix a clicking loop seam (typically SF3: Vorbis ringing just before loopEnd, where the
    original sample jumped to unrelated post-loop data) with a short crossfade of the samples
    before loopEnd towards those before loopStart: frame loopEnd-1 then equals loopStart-1, so
    loopEnd-1 -> loopStart is as smooth as loopStart-1 -> loopStart. Returns (pcm, fade or None)."""
    if seam_ratio(x, ls, le) <= limit:
        return x, None
    n = int(min(fade_s * sr, ls, (le - ls) // 4))
    if n < 4:
        return x, None
    y = x.copy()
    w = (np.arange(1, n + 1) / n).astype(np.float32)
    y[le - n:le] = (1 - w) * x[le - n:le] + w * x[ls - n:ls]
    return y, n


def sustained_rms(x, sr, ls, le):
    if ls is not None:
        seg = x[ls:le]
    else:
        a = int(0.15 * sr)
        seg = x[a:max(a + 1, len(x) - int(0.1 * sr))]
    return float(np.sqrt(np.mean(seg.astype(np.float64) ** 2))) if len(seg) else 0.0


def measure_cents(e):
    """Measured pitch of a zone's sustain, in the manifest's convention (cents above root)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import check_sf as C
    x, sr, ls, le = e["pcm"].astype(np.float64), e["sr"], e["loopStart"], e["loopEnd"]
    f_decl = C.midi_hz(e["root"] + e["cents"] / 100.0)
    if ls is not None:
        seg = C.loop_only(x, ls, le, max(2.0, 3 * (le - ls) / sr), sr)[: int(4 * sr)]
    else:
        seg = x[int(0.15 * sr): int(1.5 * sr)]
    if len(seg) < 4096:
        return None
    return float(e["cents"] + C.cents(C.measure_pitch(seg, sr, f_decl), f_decl))


def _zone_sig(z):
    g = z["gens"]
    return (z["sampleIndex"], z["instrument"], tuple(sorted((k, v) for k, v in g.items()
            if k not in (G["keyRange"], G["velRange"], G["pan"], 15, 16, 21, 22, 23, 24))))


def build(sf, bank, program, vel=90, channel="left", target_rms=0.12, cover=(21, 108),
          layers=None, retune=False, notes=None, keyspan=None):
    """One zone per key range for the engine.

    layers: None -> keep the single instrument layer with the most key zones (a preset may
    layer e.g. oohs + synth voice); else a list of regular expressions on instrument names,
    in priority order: for each key the matching zone whose root is nearest is used (so a
    preset split into sections - basses, celli, violas, violins - becomes one sample set)."""
    import re
    notes = [] if notes is None else notes
    zones = sf.resolve(bank, program, vel)
    if not zones:
        raise SystemExit("no zone at this velocity")
    counts = {}
    for z in zones:
        counts.setdefault(z["instrument"], set()).add(z["keyRange"])
    if layers is None:
        keep = max(counts, key=lambda k: len(counts[k]))
        prio = {keep: 0}
    else:
        prio = {}
        for name in counts:
            for i, rx in enumerate(layers):
                if re.search(rx, name):
                    prio[name] = i
                    break
    for name in counts:
        if name not in prio:
            notes.append(f"dropped layer {name!r} ({len(counts[name])} zones)")
    zones = [z for z in zones if z["instrument"] in prio]
    if not zones:
        raise SystemExit(f"no layer matches {layers}; layers: {sorted(counts)}")

    def root_of(z):
        g = z["gens"]
        r = g[G["overridingRootKey"]]
        return r if r >= 0 else z["sample"]["pitch"]

    # stereo pairs: index the partner so that one choice covers both channels
    def is_right(z):
        return z["sample"]["type"] & 0x0F == 2
    mains = [z for z in zones if not is_right(z) and not z["sample"]["name"].rstrip().endswith(("-R", "R"))
             or not any(o is not z and o["keyRange"] == z["keyRange"] and o["instrument"] == z["instrument"]
                        for o in zones)] or zones
    choice = {}
    for key in range(128):
        cand = [z for z in mains if z["keyRange"][0] <= key <= z["keyRange"][1]]
        if cand:
            choice[key] = min(cand, key=lambda z: (abs(key - root_of(z)), prio[z["instrument"]],
                                                    z["keyRange"][1] - z["keyRange"][0]))
    if keyspan:                                    # only these keys get their own zone
        choice = {k: z for k, z in choice.items() if keyspan[0] <= k <= keyspan[1]}
    keys = sorted(choice)
    lo_key, hi_key = min(keys[0], cover[0]), max(keys[-1], cover[1])
    for key in range(lo_key, hi_key + 1):          # gaps and outer keys: nearest chosen zone
        if key not in choice:
            near = min(keys, key=lambda k: (abs(k - key), k))
            choice[key] = choice[near]
    # contiguous keys with the same zone -> one range
    ranges = []
    for key in range(lo_key, hi_key + 1):
        z = choice[key]
        same = ranges and _zone_sig(ranges[-1][0]) == _zone_sig(z)
        if same and ranges[-1][2] == key - 1:
            ranges[-1][2] = key
        else:
            ranges.append([z, key, key])
    cache, out = {}, []
    for z, lo, hi in ranges:
        ident = _zone_sig(z)
        if ident not in cache:
            e = extract_zone(sf, z)
            # the other channel: the linked right sample, or (unlinked pairs such as
            # "Ahh Choir D#3-L"/"-R") another zone of the same instrument and key range
            partner = [r for r in zones if r is not z and r["keyRange"] == z["keyRange"]
                       and r["instrument"] == z["instrument"] and r["sampleIndex"] != z["sampleIndex"]
                       and root_of(r) == root_of(z)]
            e["stereo"] = "left" if partner else "mono"
            if channel == "mix" and partner:
                e2 = extract_zone(sf, partner[0])
                if (e2["loopStart"], e2["loopEnd"], len(e2["pcm"])) == \
                        (e["loopStart"], e["loopEnd"], len(e["pcm"])):
                    e["pcm"] = 0.5 * (e["pcm"] + e2["pcm"])
                    e["stereo"] = "mix"
                else:
                    notes.append(f"{e['sampleName']}: L/R loops differ, left kept")
            e["centsSf"] = e["cents"]
            if retune:
                c = measure_cents(e)
                if c is not None:
                    e["cents"] = round(c, 1)
            cache[ident] = e
        out.append(dict(cache[ident], lo=lo, hi=hi))
    # gain: SoundFont attenuation and loudness normalisation (the velocity curve is the same for
    # every zone, so the normalisation cancels it). FluidSynth scales initialAttenuation by 0.4.
    for e in out:
        e["sfGain"] = 10 ** (-(e["attenuation"] * 0.4) / 20)
        e["rms"] = sustained_rms(e["pcm"], e["sr"], e["loopStart"], e["loopEnd"])
    eff = np.array([e["rms"] * e["sfGain"] for e in out])
    span = keyspan or (36, 84)
    per_key = [v for e, v in zip(out, eff) for k in range(e["lo"], e["hi"] + 1)
               if span[0] <= k <= span[1]] or list(eff)
    ref = float(np.median(per_key))                  # median over the keys actually played
    for e, v in zip(out, eff):
        # keep the designer's balance, but bring every zone within +-1.5 dB of the median
        lim = 10 ** (1.5 / 20)
        corr = float(np.clip(v, ref / lim, ref * lim) / v) if v > 0 else 1.0
        e["gain"] = round(e["sfGain"] * corr * target_rms / ref, 5)
    return out, notes


def export(sf, bank, program, out_dir, ident, name, source, license_text, vel=90, channel="left",
           layers=None, retune=False, keyspan=None):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in out_dir.glob("z*.flac"):
        f.unlink()
    notes = []
    zones, notes = build(sf, bank, program, vel, channel, layers=layers, retune=retune, notes=notes,
                         keyspan=keyspan)
    mz, files = [], {}
    for e in zones:
        k = (e["sampleIndex"], e["stereo"])
        if k not in files:
            files[k] = f"z{len(files):02d}.flac"
            write_flac(out_dir / files[k], e["pcm"], e["sr"])
        mz.append(dict(file=files[k], lo=e["lo"], hi=e["hi"], root=e["root"],
                       cents=round(e["cents"], 1), sr=e["sr"], loopStart=e["loopStart"],
                       loopEnd=e["loopEnd"], release=e["release"], gain=e["gain"],
                       length=len(e["pcm"]), centsSf=round(e["centsSf"], 1),
                       sample=e["sampleName"], channel=e["stereo"],
                       **({"seamFade": e["seamRepair"]} if e.get("seamRepair") else {})))
    _, pname = sf.find_preset(bank, program)
    manifest = dict(id=ident, name=name, source=f"{source}, preset {bank}:{program} {pname}",
                    license=license_text.strip().splitlines()[0] if license_text else "",
                    velocity=vel, zones=mz)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest, zones, notes


# ---------------------------------------------------------------- the app's instruments
# Chosen by objective checks (tools/check_sf.py --metrics on every candidate; see the commit).
GU = "GeneralUser GS 2.0.3 (S. Christian Collins)"
MS = "MS Basic.sf3 (MuseScore 4, S. Christian Collins; derived from FluidR3Mono / FluidR3 by Frank Wen)"
RECIPES = {
    # id: (soundfont key, bank:program, display name, layers, channel)
    "oohs": ("ms", "0:53", "Voice Oohs", None, "mix"),
    "aahs": ("ms", "0:52", "Choir Aahs", None, "mix"),
    "flute": ("gu", "0:73", "Flute", None, "mix"),
    "clarinet": ("ms", "0:71", "Clarinet", None, "mix"),
    "strings": ("ms", "0:48", "String Ensemble",
                [r"^(Celli|Violins) Fast_v1$", r"^(Celli|Violins) Fast_v2$"], "mix"),
}


def build_all(gu_path, ms_path, gu_license, ms_license, out_root, only=None):
    sfs = {"gu": (SoundFont(gu_path), GU, Path(gu_license).read_text(encoding="utf-8")),
           "ms": (SoundFont(ms_path), MS, Path(ms_license).read_text(encoding="utf-8"))}
    for ident, (key, preset, name, layers, channel) in RECIPES.items():
        if only and ident not in only:
            continue
        sf, source, lic = sfs[key]
        bank, prog = _bp(preset)
        out = Path(out_root) / ident
        manifest, zones, notes = export(sf, bank, prog, out, ident, name, source, lic, 90, channel,
                                        layers, retune=True, keyspan=(36, 84))
        first = "MIT License" if key == "ms" else "GeneralUser GS License v2.0 (free use, modification and redistribution)"
        manifest["license"] = first
        (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
        (out / "LICENSE.txt").write_text(
            f"{name} for Pupitre: {manifest['source']}.\n"
            f"Extracted with tools/extract_sf2.py (loop seams repaired where they clicked, tuning\n"
            f"measured, stereo pairs mixed to mono, re-encoded losslessly as FLAC).\n"
            f"License: {first}. Original license text follows.\n\n{lic}\n", encoding="utf-8")
        print(ident, len(manifest["zones"]), "zones;", *notes[:2])


# ---------------------------------------------------------------- CLI
def _bp(s):
    b, p = s.split(":")
    return int(b), int(p)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("list"); a.add_argument("sf")
    a = sub.add_parser("inspect"); a.add_argument("sf"); a.add_argument("preset")
    a.add_argument("--vel", type=int, default=90)
    a = sub.add_parser("export"); a.add_argument("sf"); a.add_argument("preset"); a.add_argument("out")
    a.add_argument("--id", required=True); a.add_argument("--name", required=True)
    a.add_argument("--source", required=True); a.add_argument("--license", default="")
    a.add_argument("--license-file"); a.add_argument("--vel", type=int, default=90)
    a.add_argument("--channel", choices=["left", "mix"], default="mix")
    a.add_argument("--layers", help="comma-separated regexes of instrument layers to use, in "
                   "priority order (default: the single layer with the most zones)")
    a.add_argument("--keys", default="36-84",
                   help="keys that get their own nearest zone; keys outside reuse the edge zones "
                   "(default 36-84, the choir range; 0-127 keeps every zone)")
    a.add_argument("--retune", action="store_true",
                   help="set each zone's cents from its measured pitch (see measure_cents)")
    a = sub.add_parser("build-all", help="export the app's instruments (RECIPES) to app/public/sf")
    a.add_argument("--gu", required=True, help="GeneralUser-GS.sf2")
    a.add_argument("--gu-license", required=True, help="GeneralUser GS documentation/LICENSE.txt")
    a.add_argument("--ms", required=True, help="MS Basic.sf3 (MuseScore share/sound)")
    a.add_argument("--ms-license", required=True, help="MS Basic_License.md")
    a.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "app" / "public" / "sf"))
    a.add_argument("only", nargs="*")
    args = ap.parse_args(argv)
    if args.cmd == "build-all":
        build_all(args.gu, args.ms, args.gu_license, args.ms_license, args.out, args.only)
        return 0
    sf = SoundFont(args.sf)
    if args.cmd == "list":
        for name, b, p, _ in sorted(sf.presets(), key=lambda t: (t[1], t[2])):
            print(f"{b:3d}:{p:3d}  {name}")
        return 0
    bank, prog = _bp(args.preset)
    if args.cmd == "inspect":
        for z in sf.resolve(bank, prog, args.vel):
            g, s = z["gens"], z["sample"]
            e = extract_zone(sf, z)
            print(f"{z['instrument'][:16]:16s} key {z['keyRange'][0]:3d}-{z['keyRange'][1]:3d} "
                  f"vel {z['velRange'][0]:3d}-{z['velRange'][1]:3d} {s['name'][:20]:20s} "
                  f"type {s['type']:#x} sr {s['sr']} root {e['root']} cents {e['cents']:+.0f} "
                  f"loop {e['loopStart']}-{e['loopEnd']} len {len(e['pcm'])} "
                  f"att {e['attenuation']:.1f}dB rel {e['release']:.2f}s fc {e['filterFc']} "
                  f"mode {g.get(54, 0)} pan {e['pan']}")
        return 0
    lic = Path(args.license_file).read_text(encoding="utf-8") if args.license_file else args.license
    manifest, zones, notes = export(sf, bank, prog, args.out, args.id, args.name, args.source, lic,
                                    args.vel, args.channel,
                                    args.layers.split(",") if args.layers else None, args.retune,
                                    tuple(int(v) for v in args.keys.split("-")))
    lic_out = f"{args.name}: {manifest['source']}\n\n{lic}\n"
    Path(args.out, "LICENSE.txt").write_text(lic_out, encoding="utf-8")
    for n in notes:
        print("note:", n)
    for z in manifest["zones"]:
        print(z)
    return 0


if __name__ == "__main__":
    sys.exit(main())
