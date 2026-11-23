// A marimba-like bar struck by a mallet (11/2026): each note is clear from its first instant, the
// pitch heard at once, then it rings and fades; useful to hear exactly where the notes fall.
// Modal synthesis: a tuned bar sounds its fundamental and two partials tuned to 4× and 10× (as on
// marimbas and vibraphones), the upper ones dying faster (they give the "tok" of the mallet). Low
// notes ring longer than high ones. On small speakers and bone-conduction headphones the 4×
// partial (two octaves up) carries the pitch of low notes. Each pitch is computed once (a few ms)
// and kept while the movement needs it; nothing to download.
import type { Source, StopNote } from './instruments';
import { midiToHz } from './notes';
import { stopNote } from './sfont';

/** Partials of a tuned bar: frequency ratio, amplitude, decay time (to −60 dB) as a share of the
 *  fundamental's. */
const MODES: [number, number, number][] = [
  [1, 1, 1],
  [4, 0.32, 0.22],
  [10, 0.1, 0.07],
];
/** Partials above this are left out (harsh, and small speakers do not play them well). */
const TOP_HZ = 7000;
/** Peak of a note at full level: its strike (loudness over 0.4 s) as loud as the clarinet's
 *  steady tone, measured on the app's output. */
const PEAK = 0.2;

/** Decay time (s, to −60 dB) of the fundamental: ~3 s around G3, longer low, shorter high. */
export function malletDecay(f0: number): number {
  return Math.max(0.7, Math.min(4.5, 3 * Math.pow(196 / f0, 0.6)));
}

/** The note at pitch f0 (Hz), at sample rate sr: the sum of the bar's partials, each an
 *  exponentially decaying sine, with a 1.5 ms rise (the mallet's contact; no click). Peak 1. */
export function renderMallet(f0: number, sr: number): Float32Array {
  const t60 = malletDecay(f0);
  const n = Math.ceil((t60 + 0.05) * sr);
  const acc = new Float64Array(n);
  for (const [ratio, amp, share] of MODES) {
    const f = f0 * ratio;
    if (f > Math.min(TOP_HZ, sr / 2 - 500)) continue;
    const decay = Math.exp(Math.log(0.001) / (t60 * share * sr)); // per sample, −60 dB at the end
    // rotation of a phasor: one multiply-add per sample, no sine call
    const w = (2 * Math.PI * f) / sr;
    const c = Math.cos(w) * decay;
    const s = Math.sin(w) * decay;
    let re = amp;
    let im = 0;
    for (let i = 0; i < n; i++) {
      acc[i] += im;
      const r2 = re * c - im * s;
      im = re * s + im * c;
      re = r2;
    }
  }
  const rise = Math.round(0.0015 * sr);
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let v = acc[i];
    if (i < rise) v *= 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  // the last 20 ms fade to zero (the buffer ends in silence)
  const tail = Math.round(0.02 * sr);
  for (let i = Math.max(0, n - tail); i < n; i++) out[i] *= (n - i) / tail;
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

export class MalletVoice implements Source {
  loaded = true;
  private bufs = new Map<number, AudioBuffer>();
  constructor(private ctx: AudioContext) {}
  async load() {}

  private buf(midi: number): AudioBuffer {
    let b = this.bufs.get(midi);
    if (!b) {
      const d = renderMallet(midiToHz(midi), this.ctx.sampleRate);
      b = this.ctx.createBuffer(1, d.length, this.ctx.sampleRate);
      b.copyToChannel(d as Float32Array<ArrayBuffer>, 0);
      this.bufs.set(midi, b);
    }
    return b;
  }

  ready(midis: Iterable<number>) {
    for (const m of new Set(midis)) this.buf(Math.round(m));
  }
  async prepare(midis: Iterable<number>) {
    this.ready(midis);
  }
  /** Keeps only these pitches (those of the movement). */
  retain(midis: Iterable<number>) {
    const keep = new Set([...midis].map((m) => Math.round(m)));
    for (const m of this.bufs.keys()) if (!keep.has(m)) this.bufs.delete(m);
  }
  unload() {
    this.bufs.clear();
    return true;
  }
  play(dest: AudioNode, midi: number, when: number, dur: number, level = 1, elapsed = 0): StopNote {
    const ctx = this.ctx;
    const b = this.buf(Math.round(midi));
    if (elapsed >= b.duration - 0.05) return () => {}; // joined after it has died away
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    g.gain.value = 0; // never the default 1 before the first event
    const peak = PEAK * level;
    const end = when + Math.max(0.06, dur);
    if (elapsed > 0.005) {
      // joined in its course: from where it is, faded in (no new strike)
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(peak, when + 0.03);
    } else g.gain.setValueAtTime(peak, when);
    // the bar is damped at the end of the written note (if it still rings)
    g.gain.setValueAtTime(peak, end);
    g.gain.setTargetAtTime(0, end, 0.05);
    src.connect(g).connect(dest);
    src.start(when, elapsed);
    src.stop(Math.min(when + b.duration - elapsed, end + 0.35));
    return (at?: number, tau = 0.02) => stopNote(ctx, when, g.gain, [src], tau, at);
  }
}
