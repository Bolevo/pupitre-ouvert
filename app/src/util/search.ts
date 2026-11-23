// Binary searches over arrays sorted by a numeric key (times, mostly). One place for the five
// copies the app used to carry.

/** First index i with key(a[i]) >= x (a.length when there is none). */
export function lowerBound<T>(a: readonly T[], x: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(a[mid]) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i with key(a[i]) > x (a.length when there is none). */
export function upperBound<T>(a: readonly T[], x: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(a[mid]) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the last element with key <= x, never below 0 (the first element before any key). */
export const lastAtOrBefore = <T>(a: readonly T[], x: number, key: (v: T) => number) => Math.max(0, upperBound(a, x, key) - 1);

/** Whether one of the `back` last notes started at or before `st` is still sounding at `st`.
 *  `back` bounds the look behind (a long note under many short ones). */
export function soundingAt(notes: readonly { t: number; d: number }[], st: number, back = 24): boolean {
  const upper = upperBound(notes, st, (n) => n.t);
  for (let i = upper - 1, k = 0; i >= 0 && k < back; i--, k++) if (notes[i].t + notes[i].d > st) return true;
  return false;
}
