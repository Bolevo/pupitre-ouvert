import { describe, expect, it } from 'vitest';
import { clefAt, clefWords, fifthsOf, keyNameAt, pageRanges, shortKeyName, signatureWords, stepTempo, tempoAt } from '../src/score/info';
import type { Movement } from '../src/pack/types';

const measures = [0, 2000, 4000, 6400, 8800].map((t, i) => ({ id: `m${i}`, n: String(i + 1), t, q: i * 4, mark: null, tonic: 2, minor: false, fifths: 2, ts: (i < 3 ? [4, 4] : [4, 2]) as [number, number] }));
const mv = {
  id: 'mvt1',
  measures,
  durationMs: 11200,
  clefs: { '3': [{ m: 0, sign: 'G', line: 2, octave: -1 }], '6': [{ m: 0, sign: 'F', line: 4 }, { m: 3, sign: 'G', line: 2 }] },
  tempos: [{ t: 0, m: 0, bpm: 120, text: 'Allegro' }, { t: 4000, m: 2, bpm: 100 }, { t: 6400, m: 3, bpm: 100, beat: 2 }],
  keys: [{ m: 0, name: 'Ré majeur' }, { m: 4, name: null }],
} as unknown as Movement;

describe('score information at a measure', () => {
  it('clef of a staff, changes included', () => {
    expect(clefAt(mv, 3, 4)).toMatchObject({ sign: 'G', octave: -1 });
    expect(clefAt(mv, 6, 2)?.sign).toBe('F');
    expect(clefAt(mv, 6, 3)?.sign).toBe('G');
    expect(clefAt(mv, 1, 0)).toBeNull();
    expect(clefWords({ m: 0, sign: 'G', line: 2, octave: -1 })).toMatch(/Clé de sol octaviée/);
  });
  it('key signature, and the key name only when known', () => {
    expect(fifthsOf(measures[0])).toBe(2);
    expect(fifthsOf({ tonic: 10, minor: false })).toBe(-2); // old pack: B flat major's signature
    expect(fifthsOf({ tonic: 6, minor: false })).toBe(6);
    expect(signatureWords(-1)).toBe('1 bémol');
    expect(signatureWords(0)).toBe('sans altération');
    expect(keyNameAt(mv, 3)).toBe('Ré majeur');
    expect(keyNameAt(mv, 4)).toBeNull();
    expect(keyNameAt({ ...mv, keys: undefined }, 0)).toBeNull();
    expect(shortKeyName('si mineur')).toBe('si min.');
  });
  it('tempo: the score mark, its beat unit (or the time signature), its word', () => {
    expect(tempoAt(mv, 1)).toEqual({ bpm: 120, beat: 1, text: 'Allegro' });
    expect(tempoAt(mv, 2)).toEqual({ bpm: 100, beat: 1, text: undefined });
    expect(tempoAt(mv, 4)).toEqual({ bpm: 100, beat: 2, text: undefined }); // printed half note
    // old packs (no `m`): measured from the timing; 4/2 beats in half notes
    const old = { ...mv, tempos: [{ t: 0, bpm: 120 }] } as unknown as Movement;
    expect(tempoAt(old, 0)).toEqual({ bpm: 120, beat: 1 });
    expect(tempoAt(old, 3)).toEqual({ bpm: 100, beat: 2 });
  });
  it('tempo steps follow the metronome scale and stop on the score value', () => {
    expect(stepTempo(120, -1, 120)).toBe(116);
    expect(stepTempo(120, 1, 120)).toBe(126);
    expect(stepTempo(116, 1, 120)).toBe(120);
    expect(stepTempo(130, -1, 138)).toBe(126);
    expect(stepTempo(132, 1, 135)).toBe(135); // the score's own value is a stop
    expect(stepTempo(60, -1, 60)).toBe(58);
  });
  it('page ranges', () => {
    expect(pageRanges([4, 5, 6, 9, 20, 21].map((page) => ({ page })))).toBe('4–6, 9, 20–21');
  });
});
