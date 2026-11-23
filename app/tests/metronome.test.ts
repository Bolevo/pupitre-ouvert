import { describe, expect, it } from 'vitest';
import { beatQuarters, clicksFor } from '../src/audio/metronome';
import type { Measure } from '../src/pack/types';

const m = (n: number, t: number, q: number, ts: [number, number], tonic = 2): Measure => ({ id: `m${n}`, n: String(n), t, q, mark: null, tonic, minor: false, ts });

describe('metronome clicks', () => {
  const two44 = [m(1, 0, 0, [4, 4]), m(2, 2000, 4, [4, 4])];
  it('beats of 4/4: tac on beat 1 (tonic), tic on 2-4 (dominant)', () => {
    const c = clicksFor(two44, 4000, 'beat');
    expect(c.map((x) => x.st)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
    expect(c.filter((x) => x.accent).map((x) => x.st)).toEqual([0, 2000]);
    expect(c[0].midi).toBe(74); // D5, tonic of D major
    expect(c[1].midi).toBe(69); // A4, its dominant
  });
  it('first beat only, halves, eighths', () => {
    expect(clicksFor(two44, 4000, 'measure').map((x) => x.st)).toEqual([0, 2000]);
    expect(clicksFor(two44, 4000, 'half').map((x) => x.st)).toEqual([0, 1000, 2000, 3000]);
    const e = clicksFor(two44, 4000, 'eighth');
    expect(e.length).toBe(16);
    expect(e[1].level).toBeLessThan(e[2].level); // off-beats lighter than beats
  });
  it('4/2 beats halves, 6/8 two dotted quarters, 3/4 three', () => {
    expect(beatQuarters([4, 2])).toBe(2);
    expect(beatQuarters([6, 8])).toBe(1.5);
    expect(beatQuarters([3, 4])).toBe(1);
    expect(clicksFor([m(1, 0, 0, [6, 8])], 1200, 'beat').map((x) => x.st)).toEqual([0, 600]);
  });
  it('a pickup measure gets the last beats', () => {
    const c = clicksFor([m(1, 0, 0, [4, 4]), m(2, 500, 1, [4, 4])], 2500, 'beat');
    expect(c.map((x) => [x.st, x.accent])).toEqual([[0, false], [500, true], [1000, false], [1500, false], [2000, false]]);
  });
});
