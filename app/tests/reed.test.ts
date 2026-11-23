import { describe, expect, it } from 'vitest';
import { reedHarmonics } from '../src/audio/reed';

const db = (x: number) => 20 * Math.log10(x);

describe('synthesized clarinet spectrum', () => {
  it('RMS 1 at every pitch, nothing above 6 kHz', () => {
    for (const f0 of [98, 147, 220, 330, 440, 660, 1000]) {
      const a = reedHarmonics(f0);
      let s = 0;
      for (let k = 1; k < a.length; k++) s += a[k] * a[k];
      expect(Math.sqrt(s / 2)).toBeCloseTo(1, 6);
      expect((a.length - 1) * f0).toBeLessThanOrEqual(6000);
    }
  });
  it('the hollow low register: odd harmonics strong, even ones weak below 1.5 kHz', () => {
    const a = reedHarmonics(147); // D3, a tenor's low note
    expect(db(a[3] / a[1])).toBeCloseTo(-6.3, 1);
    expect(db(a[2] / a[1])).toBeLessThan(-25);
    expect(db(a[4] / a[1])).toBeLessThan(-30);
    expect(a[5]).toBeGreaterThan(a[4]);
  });
  it('present up to 2.5 kHz (heard through the choir), soft above (not harsh in earbuds)', () => {
    const a = reedHarmonics(294); // D4
    expect(db(a[7] / a[3])).toBeGreaterThan(-6); // 2.06 kHz: the presence
    expect(db(a[15] / a[7])).toBeLessThan(-15); // 4.4 kHz: steeply down
  });
});

describe('marimba', () => {
  it('a clear strike that rings and fades: peak 1 at once, no click, longer low than high', async () => {
    const { renderMallet, malletDecay } = await import('../src/audio/mallet');
    const sr = 44100;
    const d = renderMallet(196, sr);
    let peak = 0;
    let at = 0;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) [peak, at] = [Math.abs(d[i]), i];
    expect(peak).toBeCloseTo(1, 5);
    expect(at / sr).toBeLessThan(0.01); // heard at once
    expect(Math.abs(d[0])).toBe(0); // starts from silence
    expect(Math.abs(d[d.length - 1])).toBeLessThan(1e-4); // ends in silence
    const rms = (a: number, b: number) => Math.sqrt(d.subarray(a, b).reduce((s, x) => s + x * x, 0) / (b - a));
    expect(rms(Math.round(1.5 * sr), Math.round(1.6 * sr)) / rms(0, Math.round(0.1 * sr))).toBeLessThan(0.1); // it fades
    expect(malletDecay(82)).toBeGreaterThan(malletDecay(440));
  });
});

describe('the clarinet\'s level does not depend on the browser normalizing waves', () => {
  it('wavePeak: the peak of a known waveform', async () => {
    const { wavePeak } = await import('../src/audio/reed');
    // sin(x) + sin(3x)/3: peak ≈ 0.943 (not 1 + 1/3: the maxima do not coincide)
    const re = new Float32Array(4);
    const im = Float32Array.from([0, 1, 0, 1 / 3]);
    expect(wavePeak(re, im)).toBeCloseTo(0.9428, 3);
    expect(wavePeak(Float32Array.from([0, 0.5]), new Float32Array(2))).toBeCloseTo(0.5, 6);
  });
});
