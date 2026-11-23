import { describe, expect, it } from 'vitest';
import { resample } from '../src/audio/resample';

const sine = (n: number, hz: number, sr = 48000) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / sr));
const zeroCrossings = (d: Float32Array) => {
  let k = 0;
  for (let i = 1; i < d.length; i++) if (d[i - 1] < 0 !== d[i] < 0) k++;
  return k;
};
const maxDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe('resample', () => {
  it('ratio 1 without a loop is the identity, cut at maxOut', () => {
    const data = sine(4000, 440);
    const r = resample({ id: 1, data, ratio: 1, loopStart: -1, loopEnd: -1, maxOut: 1000 });
    expect(r.loopStart).toBe(-1);
    expect(r.out.length).toBe(1000);
    expect(maxDiff(r.out, data)).toBe(0);
  });

  it('ratio 2 doubles the pitch, ratio 0.5 doubles the length', () => {
    const data = sine(8000, 440);
    const up = resample({ id: 1, data, ratio: 2, loopStart: -1, loopEnd: -1, maxOut: 100000 });
    expect(up.out.length).toBe(4000);
    expect(zeroCrossings(up.out)).toBeGreaterThan(zeroCrossings(data.subarray(0, 4000)) * 1.9);
    const down = resample({ id: 2, data, ratio: 0.5, loopStart: -1, loopEnd: -1, maxOut: 100000 });
    expect(down.out.length).toBe(16000);
    expect(zeroCrossings(down.out.subarray(0, 8000))).toBeLessThan(zeroCrossings(data) * 0.55);
  });

  it('a looped zone gives the attack plus one seamless period', () => {
    const sr = 48000;
    const data = sine(sr, 220, sr); // 1 s; loop over whole periods: 220 Hz -> 218.18 samples... use 240 Hz (200 samples)
    const d2 = sine(sr, 240, sr);
    const ls = 20000;
    const le = ls + 200 * 40; // 40 periods
    const r = resample({ id: 1, data: d2, ratio: 1.2, loopStart: ls, loopEnd: le, maxOut: sr });
    expect(r.loopStart).toBeGreaterThan(0);
    expect(r.loopEnd - r.loopStart).toBeGreaterThanOrEqual(64);
    expect(r.out.length).toBe(r.loopEnd);
    // the sample after the loop's end (its first sample again) continues the waveform
    const a = r.out[r.loopEnd - 2];
    const b = r.out[r.loopEnd - 1];
    const c = r.out[r.loopStart];
    expect(Math.abs(c - b - (b - a))).toBeLessThan(0.05);
    void data;
  });

  it('the worker reads only what sfont.ts sends: a zone cut there gives the same output', () => {
    const data = sine(40000, 440);
    for (const ratio of [0.7, 1, 1.5, 3]) {
      const maxOut = 5000;
      const full = resample({ id: 1, data, ratio, loopStart: -1, loopEnd: -1, maxOut });
      // the region computed in sfont.ts resample()
      const need = Math.min(data.length, Math.ceil(maxOut * ratio + 16 * Math.max(1, ratio) + 16));
      const cut = resample({ id: 2, data: data.slice(0, need), ratio, loopStart: -1, loopEnd: -1, maxOut });
      expect(cut.out.length).toBe(full.out.length);
      expect(maxDiff(cut.out, full.out)).toBe(0);
    }
    const ls = 3000;
    const le = 3000 + 109 * 20; // 109-sample periods at 440 Hz / 48 kHz
    const full = resample({ id: 3, data, ratio: 1.1, loopStart: ls, loopEnd: le, maxOut: 100000 });
    const cut = resample({ id: 4, data: data.slice(0, le), ratio: 1.1, loopStart: ls, loopEnd: le, maxOut: 100000 });
    expect(maxDiff(cut.out, full.out)).toBe(0);
    expect(cut.loopEnd).toBe(full.loopEnd);
  });
});
