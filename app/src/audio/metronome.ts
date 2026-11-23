// Metronome: a short "tac" on the first beat of each measure (on the tonic of the key), light "tic"s
// on the other beats (on the dominant). The clicks are computed once per movement from the
// measures (time signature, start time, quarter position) and scheduled by the engine with the
// notes, on the audio clock. The two sounds of a key are synthesised once into small buffers.

import type { Measure } from '../pack/types';
import { midiToHz } from './notes';

/** What is clicked: the beats of the time signature (default), the first beat only, or a fixed value. */
export type MetroSub = 'beat' | 'measure' | 'half' | 'quarter' | 'eighth';

export interface Click {
  st: number; // score ms
  accent: boolean; // first beat of a measure
  level: number; // 0..1: 1 first beat, 0.65 other beats, 0.4 subdivisions
  midi: number;
}

/** Quarters per beat: the denominator, or a dotted value for compound meters (6/8 = 2 beats). */
export function beatQuarters([num, den]: [number, number]): number {
  const unit = 4 / den;
  return num > 3 && num % 3 === 0 && den >= 8 ? unit * 3 : unit;
}

export function clicksFor(measures: Measure[], durationMs: number, sub: MetroSub): Click[] {
  const out: Click[] = [];
  measures.forEach((m, i) => {
    const next = measures[i + 1];
    const full = (m.ts[0] * 4) / m.ts[1]; // quarters in a whole measure
    const len = next ? next.q - m.q : full;
    const t1 = next ? next.t : durationMs;
    if (len <= 0 || t1 <= m.t) return;
    // a first measure shorter than its time signature is a pickup: its beats are the last ones
    const offset = i === 0 && len < full - 1e-6 ? full - len : 0;
    const beat = beatQuarters(m.ts);
    const step = sub === 'measure' ? full : sub === 'half' ? 2 : sub === 'quarter' ? 1 : sub === 'eighth' ? 0.5 : beat;
    const tonic = 72 + (((m.tonic % 12) + 12) % 12); // C5..B5
    const dominant = tonic - 5; // the dominant, a fourth below
    for (let k = Math.ceil(offset / step - 1e-9); k * step < offset + len - 1e-6; k++) {
      const pos = k * step; // quarters from the (nominal) start of the measure
      const accent = pos < 1e-6;
      const onBeat = Math.abs(pos / beat - Math.round(pos / beat)) < 1e-6;
      out.push({
        st: m.t + ((pos - offset) / len) * (t1 - m.t),
        accent,
        level: accent ? 1 : onBeat ? 0.65 : 0.4,
        midi: accent ? tonic : dominant,
      });
    }
  });
  return out;
}

/** The two sounds: a woody, pitched click with a fast decay ("tac" longer and fuller). */
export class MetronomeVoice {
  private cache = new Map<string, AudioBuffer>();
  constructor(private ctx: BaseAudioContext) {}

  private buffer(midi: number, accent: boolean): AudioBuffer {
    const key = `${midi}:${accent}`;
    let b = this.cache.get(key);
    if (b) return b;
    const sr = this.ctx.sampleRate;
    const f = midiToHz(midi);
    const tau = accent ? 0.03 : 0.018;
    const n = Math.round(sr * tau * 7);
    b = this.ctx.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.0015) * Math.exp(-t / tau);
      const tone = Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t / (tau * 0.5));
      // a short knock at the start: the "t" of tic / tac
      const knock = t < 0.004 ? (Math.random() * 2 - 1) * (1 - t / 0.004) * 0.5 : 0;
      d[i] = env * tone + knock;
      peak = Math.max(peak, Math.abs(d[i]));
    }
    for (let i = 0; i < n; i++) d[i] /= peak;
    this.cache.set(key, b);
    return b;
  }

  play(dest: AudioNode, c: Click, when: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer(c.midi, c.accent);
    const g = this.ctx.createGain();
    g.gain.value = (c.accent ? 0.5 : 0.32) * c.level;
    src.connect(g).connect(dest);
    src.start(when);
    return src;
  }
}
