// The clarinet, synthesized: one oscillator per note playing a fixed spectrum (PeriodicWave), the
// browser's band-limited wavetable. It replaced the SoundFont clarinet (11/2026), whose loops were
// ~0.1 s long and held breath noise only ~20 dB below the tone: repeated ten times a second, it was
// heard as a crackle under every long note. A clarinet holds a steady spectrum (no vibrato), which
// a static wave renders well. Its partials are smooth and fall off above 2.5 kHz (the recording
// had single harmonics nearly as strong as the fundamental up to 2 kHz and much energy at 4–5 kHz,
// harsh in bone-conduction headphones and through Bluetooth codecs); the 1.5–2.5 kHz presence is
// kept: there the followed voice stands out of the choir "ah" and the piano, which have little.
// Nothing to download; exact pitch; no loop, so no seam. One wave per pitch of the movement is
// kept (the browser holds its band-limited tables).
import type { Source, StopNote } from './instruments';
import { midiToHz } from './notes';
import { stopNote } from './sfont';

/** Highest partial kept (Hz): the timbre needs nothing above, and nothing aliases. */
const TOP_HZ = 6000;
/** The tone-hole cutoff of a clarinet: below it the odd harmonics dominate (the hollow sound). */
const CUTOFF_HZ = 1500;
/** Above this, partials fall off faster (the roll-off that removes the harshness). A first
 *  version cut from 1.4 kHz: as loud alone, but masked by the choir and the piano in the mix. */
const SOFT_HZ = 2500;
/** Steady level (RMS) of a note at full level: as loud (BS.1770) as the SoundFont clarinet it
 *  replaced, measured on the app's output (its peaks are 3 dB lower). */
const RMS = 0.058;

/** Amplitudes (index = harmonic number, [0] unused) of the steady tone at fundamental `f0`:
 *  -4 dB per octave of harmonic number; even harmonics 24 dB down below the cutoff (6 dB above);
 *  -18 dB per octave of frequency above SOFT_HZ; scaled to RMS 1. */
export function reedHarmonics(f0: number): Float32Array {
  const n = Math.max(1, Math.floor(TOP_HZ / f0));
  const a = new Float32Array(n + 1);
  let sum = 0;
  for (let k = 1; k <= n; k++) {
    const f = k * f0;
    let db = -4 * Math.log2(k);
    if (k % 2 === 0) db -= f < CUTOFF_HZ ? 24 : 6;
    if (f > SOFT_HZ) db -= 18 * Math.log2(f / SOFT_HZ);
    a[k] = Math.pow(10, db / 20);
    sum += a[k] * a[k];
  }
  const rms = Math.sqrt(sum / 2);
  for (let k = 1; k <= n; k++) a[k] /= rms;
  return a;
}

// one period of cosine, for wavePeak (cos(k·x_i) = COS[(k·i) mod N]: no trigonometry in its loop)
const N = 1024;
const COS = Float64Array.from({ length: N }, (_, i) => Math.cos((2 * Math.PI * i) / N));

/** Peak of the waveform sum(re[k] cos(kx) + im[k] sin(kx)) over one period, sampled at 1024
 *  points (22 per cycle of the highest partial kept at the lowest note: the peak to 1 %). */
export function wavePeak(re: Float32Array, im: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let k = 1; k < re.length; k++) {
      const j = (k * i) % N;
      v += re[k] * COS[j] + im[k] * COS[(j + N - N / 4) % N]; // sin(x) = cos(x − π/2)
    }
    peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

export class ReedVoice implements Source {
  loaded = true;
  /** Per pitch: the wave (normalized by the browser to a peak of 1) and the peak of our RMS-1
   *  spectrum, which the note's gain gives back. `disableNormalization` is not honoured by every
   *  browser (older Safari): this way the level is the same everywhere. */
  private waves = new Map<number, { w: PeriodicWave; peak: number }>();
  constructor(private ctx: AudioContext) {}
  async load() {}

  private wave(midi: number): { w: PeriodicWave; peak: number } {
    let w = this.waves.get(midi);
    if (!w) {
      const a = reedHarmonics(midiToHz(midi));
      // Schroeder phases: the same spectrum with a lower crest factor (headroom for the mix and
      // for the Bluetooth encoder); the ear does not hear the phases of a steady tone
      const re = new Float32Array(a.length);
      const im = new Float32Array(a.length);
      const n = a.length - 1;
      for (let k = 1; k <= n; k++) {
        const ph = (-Math.PI * k * (k - 1)) / n;
        re[k] = a[k] * Math.sin(ph);
        im[k] = a[k] * Math.cos(ph);
      }
      w = { w: this.ctx.createPeriodicWave(re, im), peak: wavePeak(re, im) };
      this.waves.set(midi, w);
    }
    return w;
  }

  /** The waves of these pitches made now (before playback starts: none is made late). */
  ready(midis: Iterable<number>) {
    for (const m of new Set(midis)) this.wave(Math.round(m));
  }
  /** The same, ahead of time and one at a time (the browser computes each wave's tables, about a
   *  millisecond, on this thread): a new pitch is not made in the middle of the music. */
  async prepare(midis: Iterable<number>) {
    for (const m of new Set(midis)) {
      if (this.waves.has(Math.round(m))) continue;
      this.wave(Math.round(m));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  /** Keeps only these pitches (those of the movement): each wave holds its tables in the browser. */
  retain(midis: Iterable<number>) {
    const keep = new Set([...midis].map((m) => Math.round(m)));
    for (const m of this.waves.keys()) if (!keep.has(m)) this.waves.delete(m);
  }

  play(dest: AudioNode, midi: number, when: number, dur: number, level = 1, elapsed = 0): StopNote {
    const ctx = this.ctx;
    const f0 = midiToHz(midi);
    const osc = ctx.createOscillator();
    const wave = this.wave(Math.round(midi));
    osc.setPeriodicWave(wave.w);
    osc.frequency.value = f0;
    // the tone opens like a reed starting to vibrate: the upper partials come in over ~80 ms
    // (a gentle low-pass, no resonance); a note joined in its course starts open
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    const open = Math.min(TOP_HZ * 1.5, ctx.sampleRate / 2 - 100);
    if (elapsed >= 0.03) lp.frequency.value = open;
    else {
      lp.frequency.setValueAtTime(Math.max(250, f0 * 1.8), when);
      lp.frequency.exponentialRampToValueAtTime(open, when + 0.08);
    }
    const g = ctx.createGain();
    g.gain.value = 0; // never the default 1 before the first event (a one-sample pop at the start)
    const peak = RMS * level * wave.peak;
    const attack = elapsed >= 0.03 ? 0.03 : 0.025;
    const end = when + Math.max(0.06, dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setValueAtTime(peak, end);
    g.gain.setTargetAtTime(0, end, 0.04);
    osc.connect(lp).connect(g).connect(dest);
    osc.start(when);
    osc.stop(end + 0.3);
    return (at?: number, tau = 0.025) => stopNote(ctx, when, g.gain, [osc], tau, at);
  }
}
