// Which notes to hand to the audio clock, and when: the pure part of the engine's scheduler
// (engine.ts tick()), testable without an AudioContext.

export interface EngineNote {
  t: number;
  d: number;
  midi: number;
  part: string;
  sp?: string; // spelled French name ('fas' = fa sharp), for the note-naming voice
}

/** A note handed to the audio clock. */
export interface PlannedNote {
  n: EngineNote;
  when: number; // AudioContext time of its start
  dur: number; // seconds it sounds from `when` (before its release)
  /** Seconds of the note already past at `when`: a note joined in progress starts there, without
   *  its attack (a late timer tick, or a note kept sounding through an internal restart). */
  elapsed: number;
}

export interface PlanInput {
  notes: readonly EngineNote[]; // sorted by t
  from: number; // index of the first note not planned yet
  anchor: { ctx: number; st: number }; // the audio time `ctx` plays the score time `st` (ms)
  rate: number; // tempo factor
  now: number; // AudioContext time now
  upto: number; // score ms: plan the notes that start before this (horizon, capped at the end)
  end: number; // score ms: end of the movement (notes are cut there)
  /** "Soutien" on this part: each note sounds only during its second half. */
  support: (part: string) => boolean;
  /** "Replay my voice": this part alone until `until`; its notes are heard whole meanwhile. */
  focus?: { part: string; until: number };
  /** Notes sounding when the plan restarted (speed or Soutien changed while playing), with the
   *  seconds of each already heard at anchor.ctx: they go on from there instead of attacking again. */
  joined?: ReadonlyMap<EngineNote, number>;
}

/** A note found late by less than this is still played, joined in progress (s). */
export const LATE_OK = 0.35;

/** Notes from `from` that start before `upto`; `next` is where the following call goes on. Notes
 *  that started before the anchor and still sound (ties, held chords) are played from the anchor;
 *  notes too short or found too late to be more than a blip are skipped. */
export function planNotes(p: PlanInput): { next: number; plan: PlannedNote[] } {
  const { notes, anchor: a, rate, now, end, focus } = p;
  const plan: PlannedNote[] = [];
  let i = p.from;
  for (; i < notes.length && notes[i].t < p.upto; i++) {
    const n = notes[i];
    // Soutien: only the second half of the note (not while "replay my voice" plays it alone)
    const half = p.support(n.part) && !(focus && focus.part === n.part && n.t < focus.until);
    const nt = half ? n.t + n.d / 2 : n.t;
    const startSt = Math.max(nt, a.st);
    const when = a.ctx + (startSt - a.st) / 1000 / rate;
    const durSt = Math.min(n.t + n.d, end) - startSt;
    if (durSt <= 10) continue;
    const dur = durSt / 1000 / rate;
    const late = Math.max(0, now + 0.005 - when);
    if (late > Math.min(LATE_OK, dur - 0.03)) continue; // too late: it would only be a blip
    // a note that should already sound at the anchor and was sounding before the restart goes on
    // where it is; one that was not (Soutien just turned off in its first half) starts now
    const heard = nt <= a.st ? (p.joined?.get(n) ?? 0) : 0;
    plan.push({ n, when: Math.max(when, a.ctx, now + 0.005), dur: dur - late, elapsed: heard + late });
  }
  return { next: i, plan };
}

/** A note handed to the audio clock earlier: its start, its length before its release, and the
 *  time its release is over. */
export interface Sounding {
  n: EngineNote;
  when: number;
  dur: number;
  end: number;
}

/** Whether the note `n`, starting at `when`, takes over from `s` (which then fades out quickly).
 *  One line, one sound: the note before in the same part, ending as this one starts, hands over
 *  instead of ringing on in its release under the new attack (two copies of a sound add up then
 *  cancel: heard as a "blop" on every attack, worse on a repeated pitch); notes still held (a
 *  chord, divisi) are left alone. On the piano (`piano`) notes ring on naturally, and only the
 *  same key struck again damps its earlier sound, as the hammer does on a string still ringing:
 *  in a tremolo or repeated chords the copies of one note do not pile up. */
export function takesOver(s: Sounding, n: EngineNote, when: number, piano: boolean): boolean {
  if (s.n.part !== n.part || s.when >= when - 0.005 || s.end <= when) return false;
  return piano ? s.n.midi === n.midi : s.when + s.dur <= when + 0.02;
}
