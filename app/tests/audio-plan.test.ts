import { describe, expect, it } from 'vitest';
import { LATE_OK, planNotes, takesOver, type EngineNote, type PlanInput, type Sounding } from '../src/audio/plan';

const note = (t: number, d: number, part = 'T', midi = 60): EngineNote => ({ t, d, midi, part });
const base = (notes: EngineNote[], over: Partial<PlanInput> = {}): PlanInput => ({
  notes,
  from: 0,
  anchor: { ctx: 10, st: 0 },
  rate: 1,
  now: 9.88, // the anchor is 120 ms ahead (a start)
  upto: 2000,
  end: 60000,
  support: () => false,
  ...over,
});
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('planNotes', () => {
  it('schedules the notes before the horizon on the audio clock, and says where to go on', () => {
    const notes = [note(0, 500), note(500, 500), note(1500, 1000), note(2500, 500)];
    const { next, plan } = planNotes(base(notes));
    expect(next).toBe(3);
    expect(plan.map((p) => p.n)).toEqual(notes.slice(0, 3));
    close(plan[1].when, 10.5);
    close(plan[1].dur, 0.5);
    expect(plan.every((p) => p.elapsed === 0)).toBe(true);
  });

  it('follows the tempo: half speed doubles times and durations', () => {
    const { plan } = planNotes(base([note(500, 500)], { rate: 0.5 }));
    close(plan[0].when, 11);
    close(plan[0].dur, 1);
  });

  it('cuts the notes at the end of the movement and skips what is left as a blip', () => {
    const { plan } = planNotes(base([note(0, 3000), note(1990, 500)], { end: 2000, upto: 2000 }));
    expect(plan).toHaveLength(1);
    close(plan[0].dur, 2);
  });

  it('Soutien: only the second half of each note of that part', () => {
    const notes = [note(0, 1000, 'T'), note(0, 1000, 'B')];
    const { plan } = planNotes(base(notes, { support: (p) => p === 'T' }));
    const t = plan.find((p) => p.n.part === 'T')!;
    const b = plan.find((p) => p.n.part === 'B')!;
    close(t.when, 10.5);
    close(t.dur, 0.5);
    close(b.when, 10);
    close(b.dur, 1);
  });

  it('replaying my voice: its notes are whole until the end of the focus window, then Soutien again', () => {
    const notes = [note(0, 1000, 'T'), note(1000, 1000, 'T')];
    const { plan } = planNotes(base(notes, { support: () => true, focus: { part: 'T', until: 1000 } }));
    close(plan[0].when, 10); // inside the window: whole
    close(plan[1].when, 11.5); // after it: second half
  });

  it('a note started before the start position (tie, held chord) sounds from the start, attacked', () => {
    const { plan } = planNotes(base([note(0, 4000)], { anchor: { ctx: 10, st: 1000 } }));
    close(plan[0].when, 10);
    close(plan[0].dur, 3);
    expect(plan[0].elapsed).toBe(0);
  });

  it('an internal restart joins a note sounding before it where it is (no new attack)', () => {
    const held = note(0, 4000);
    const fresh = note(0, 4000, 'B'); // was silent (e.g. Soutien was hiding its first half)
    const joined = new Map([[held, 1.25]]);
    const { plan } = planNotes(base([held, fresh], { anchor: { ctx: 10, st: 1000 }, now: 9.97, joined }));
    expect(plan.find((p) => p.n === held)!.elapsed).toBeCloseTo(1.25, 6);
    expect(plan.find((p) => p.n === fresh)!.elapsed).toBe(0);
  });

  it('a joined note whose Soutien half has not come yet waits for it (not joined)', () => {
    const n = note(0, 4000);
    const { plan } = planNotes(base([n], { anchor: { ctx: 10, st: 1000 }, now: 9.97, support: () => true, joined: new Map([[n, 1]]) }));
    close(plan[0].when, 11);
    expect(plan[0].elapsed).toBe(0);
  });

  it('a late tick joins a note in progress (elapsed = lateness), from now', () => {
    const { plan } = planNotes(base([note(0, 1000)], { now: 10.1 }));
    close(plan[0].when, 10.105);
    close(plan[0].elapsed, 0.105);
    close(plan[0].dur, 1 - 0.105);
  });

  it('lateness adds to what a joined note had already played', () => {
    const n = note(0, 4000);
    const { plan } = planNotes(base([n], { anchor: { ctx: 10, st: 1000 }, now: 10.05, joined: new Map([[n, 2]]) }));
    close(plan[0].elapsed, 2.055);
  });

  it('skips notes found too late, and short notes found late', () => {
    const late = planNotes(base([note(0, 5000)], { now: 10 + LATE_OK + 0.01 }));
    expect(late.plan).toHaveLength(0);
    expect(late.next).toBe(1); // not tried again
    const short = planNotes(base([note(0, 100)], { now: 10.08 }));
    expect(short.plan).toHaveLength(0);
  });
});

describe('takesOver: which earlier note fades when a new one starts', () => {
  // an earlier note: started at 10 s, 0.5 s long, its release over at 11.2 s
  const before = (part = 'T', midi = 60, dur = 0.5): Sounding => ({ n: note(0, dur * 1000, part, midi), when: 10, dur, end: 10 + dur + 0.7 });

  it('a voice: the note before, ending as the new one starts, hands over (legato)', () => {
    expect(takesOver(before(), note(500, 500, 'T', 62), 10.5, false)).toBe(true);
    expect(takesOver(before(), note(500, 500, 'T', 60), 10.5, false)).toBe(true); // a repeated pitch too
  });
  it('a voice: a note still held (chord, divisi) is left alone', () => {
    expect(takesOver(before('T', 60, 2), note(500, 500, 'T', 64), 10.5, false)).toBe(false);
  });
  it('never across parts, never a note starting together or whose release is over', () => {
    expect(takesOver(before('S'), note(500, 500, 'T', 60), 10.5, false)).toBe(false);
    expect(takesOver(before('P'), note(500, 500, 'T', 60), 10.5, true)).toBe(false);
    expect(takesOver(before(), note(0, 500, 'T', 64), 10, false)).toBe(false); // the other note of a chord
    expect(takesOver(before(), note(2000, 500, 'T', 62), 12, false)).toBe(false);
  });
  it('the piano: only the same key struck again damps its earlier sound', () => {
    expect(takesOver(before('P', 60), note(500, 500, 'P', 60), 10.5, true)).toBe(true);
    expect(takesOver(before('P', 60), note(500, 500, 'P', 64), 10.5, true)).toBe(false); // other notes ring on
    expect(takesOver(before('P', 60, 2), note(500, 500, 'P', 60), 10.5, true)).toBe(true); // even while held
    expect(takesOver(before('P', 60), note(0, 500, 'P', 60), 10, true)).toBe(false); // the same instant: not itself
  });
});
