import { describe, expect, it } from 'vitest';
import { voiceBand } from '../src/ui/PageView';

// six staves of 40 px, 60 px apart (S A T B + piano)
const sys = { top: 100, bottom: 700, staves: [0, 1, 2, 3, 4, 5].map((i) => ({ top: 100 + i * 100, bottom: 140 + i * 100 })) };

describe('followed voice band on the page', () => {
  it('covers the staff and its lyrics, not the neighbours', () => {
    const b = voiceBand(sys, [3])!; // tenor: staff 300..340
    expect(b.y0).toBeLessThan(300);
    expect(b.y0).toBeGreaterThan(240); // previous staff ends at 240
    expect(b.y1).toBeGreaterThan(340);
    expect(b.y1).toBeLessThan(400); // next staff starts at 400
  });
  it('piano: both staves', () => {
    const b = voiceBand(sys, [5, 6])!;
    expect(b.y0).toBeLessThan(500);
    expect(b.y1).toBeGreaterThan(640);
  });
  it('first staff: the band starts above it by most of a staff height (no staff above)', () => {
    const b = voiceBand(sys, [1])!; // staff 100..140, next at 200
    expect(b.y0).toBeCloseTo(100 - 0.6 * 40);
    expect(b.y1).toBeGreaterThan(140);
    expect(b.y1).toBeLessThan(200);
  });
  it('last staff: the band goes below it for the lyrics (no staff below)', () => {
    const b = voiceBand(sys, [6])!; // staff 600..640, previous ends at 540
    expect(b.y0).toBeGreaterThan(540);
    expect(b.y0).toBeLessThan(600);
    expect(b.y1).toBeCloseTo(640 + 1.1 * 40);
  });
  it('piano at the bottom of the system: both staves, lyrics room below, the bass not covered', () => {
    const b = voiceBand(sys, [6, 5])!; // order does not matter
    expect(b.y0).toBeGreaterThan(440); // the bass staff ends at 440
    expect(b.y0).toBeLessThan(500);
    expect(b.y1).toBeCloseTo(640 + 1.1 * 40);
  });
  it('staves packed tight: the band still covers a little below the staff', () => {
    const tight = { top: 0, bottom: 100, staves: [{ top: 0, bottom: 40 }, { top: 42, bottom: 82 }] };
    const b = voiceBand(tight, [1])!;
    expect(b.y1).toBeCloseTo(40 + 0.3 * 40);
  });
  it('unknown staves: no band', () => {
    expect(voiceBand(undefined, [1])).toBeNull();
    expect(voiceBand(sys, [])).toBeNull();
    expect(voiceBand(sys, [0])).toBeNull();
    expect(voiceBand({ top: 0, bottom: 10 }, [3])).toBeNull();
    expect(voiceBand({ ...sys, staves: sys.staves.slice(0, 4) }, [5, 6])).toBeNull();
  });
});
