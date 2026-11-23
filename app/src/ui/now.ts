// The measure being played (or where the music is parked), as a signal: the page navigator, the
// line's header (clef, time, key) and the tempo display re-render only when it changes. One timer
// that wakes up at the next barline (no frame loop, see ui/timing.ts › ticker).
import { signal } from '@preact/signals';
import type { Movement } from '../pack/types';
import { movement, playing, position, prefs } from '../state';
import { measureIndexAt, ticker } from './timing';

export interface Now {
  mv: Movement | null;
  i: number; // measure index in mv.measures
}

export const now = signal<Now>({ mv: null, i: 0 });

let stop: (() => void) | null = null;

/** Starts following the music (once; returns the stop function, for tests). */
export function startNow(): () => void {
  if (stop) return stop;
  const s = ticker(() => {
    const mv = movement.value;
    if (!mv) return 200;
    const st = position();
    const i = measureIndexAt(mv, st);
    const cur = now.value;
    if (cur.mv !== mv || cur.i !== i) now.value = { mv, i };
    if (!playing.value) return 120; // parked: a jump (page click, keyboard) is seen within 0.12 s
    const next = mv.measures[i + 1];
    return next ? (next.t - st) / (prefs.value.rate || 1) + 2 : 250;
  });
  stop = () => {
    s();
    stop = null;
  };
  return stop;
}
