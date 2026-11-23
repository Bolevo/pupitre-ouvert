import type { Movement } from '../pack/types';
import { lastAtOrBefore } from '../util/search';

/** Index of the measure sounding at time t (ms at 100 %; 1 ms of tolerance on the barline). */
export function measureIndexAt(mv: Movement, t: number): number {
  return lastAtOrBefore(mv.measures, t + 1, (m) => m.t);
}

/** Last rehearsal mark at or before measure i. */
export function markAt(mv: Movement, i: number): string | null {
  for (let k = i; k >= 0; k--) if (mv.measures[k].mark) return mv.measures[k].mark;
  return null;
}

/** Runs `fn` again after the delay it returns (ms, clamped to 4–250). A timer, not
 *  requestAnimationFrame: a frame loop makes the browser update every animation on the main
 *  thread at each frame, even those it could run on its own (the gliding line). */
export function ticker(fn: () => number): () => void {
  let id = 0;
  let alive = true;
  const run = () => {
    if (!alive) return;
    let d = 100;
    try {
      d = fn();
    } finally {
      if (alive) id = window.setTimeout(run, Math.max(4, Math.min(250, d)));
    }
  };
  id = window.setTimeout(run, 0);
  return () => {
    alive = false;
    window.clearTimeout(id);
  };
}
