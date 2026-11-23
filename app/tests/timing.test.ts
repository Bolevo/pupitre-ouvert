import { describe, expect, it } from 'vitest';
import { markAt, measureIndexAt } from '../src/ui/timing';
import { audibleParts, mixFor } from '../src/state';
import type { Movement } from '../src/pack/types';

const mv = {
  measures: [0, 2000, 4000, 6000].map((t, i) => ({ id: `m${i}`, n: String(i + 1), t, q: i * 4, mark: i === 2 ? 'A' : null, tonic: 9, minor: false, ts: [4, 4] })),
  parts: [
    { id: 'S', name: 'Soprano', kind: 'voice', staves: [1], sourceName: 'S' },
    { id: 'T', name: 'Ténor', kind: 'voice', staves: [3], sourceName: 'T' },
    { id: 'P', name: 'Piano', kind: 'accomp', staves: [5, 6], sourceName: 'P' },
  ],
} as unknown as Movement;

describe('timing', () => {
  it('finds the measure at a time', () => {
    expect(measureIndexAt(mv, 0)).toBe(0);
    expect(measureIndexAt(mv, 1990)).toBe(0);
    expect(measureIndexAt(mv, 2000)).toBe(1);
    expect(measureIndexAt(mv, 99999)).toBe(3);
  });
  it('before the start: the first measure', () => {
    expect(measureIndexAt(mv, -1)).toBe(0);
    expect(measureIndexAt(mv, -5000)).toBe(0);
  });
  it('1 ms of tolerance on the barline (rounded audio clock)', () => {
    expect(measureIndexAt(mv, 1998.9)).toBe(0);
    expect(measureIndexAt(mv, 1999)).toBe(1);
    expect(measureIndexAt(mv, 1999.5)).toBe(1);
    expect(measureIndexAt(mv, 5999)).toBe(3);
  });
  it('the last measure up to the end and beyond', () => {
    expect(measureIndexAt(mv, 6000)).toBe(3);
    expect(measureIndexAt(mv, 7999)).toBe(3);
  });
  it('a movement of one measure', () => {
    expect(measureIndexAt({ ...mv, measures: mv.measures.slice(0, 1) }, 5000)).toBe(0);
  });
  it('finds the last rehearsal mark', () => {
    expect(markAt(mv, 1)).toBe(null);
    expect(markAt(mv, 3)).toBe('A');
  });
});

describe('mixer', () => {
  it('hears everything by default, the piano a little softer', () => {
    expect(audibleParts(mv, {}).sort().join(',')).toBe('P,S,T');
    const m = mixFor(mv, {});
    expect(m.P.vol).toBeLessThan(m.T.vol);
  });
  it('mute removes a part', () => {
    expect(audibleParts(mv, { T: { mute: true } }).sort().join(',')).toBe('P,S');
  });
  it('solo keeps only the soloed parts (several allowed), a muted solo stays silent', () => {
    expect(audibleParts(mv, { T: { solo: true } }).join(',')).toBe('T');
    expect(audibleParts(mv, { T: { solo: true }, P: { solo: true } }).sort().join(',')).toBe('P,T');
    expect(audibleParts(mv, { T: { solo: true, mute: true }, S: { solo: true } }).join(',')).toBe('S');
  });
});
