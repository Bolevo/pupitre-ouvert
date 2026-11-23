// What the score says at a measure: clef of a staff, key (French name), time signature, tempo.
// Pure functions of the pack (tested in tests/info.test.ts).
import { beatQuarters } from '../audio/metronome';
import type { Clef, Measure, Movement, Page, Tempo } from '../pack/types';
import { lastAtOrBefore } from '../util/search';

// ---------- key ----------
/** The key signature at a measure: sharps (> 0) or flats (< 0). Packs before 11/2026 have no
 *  `fifths`: their tonic was always the major key of the signature. */
export function fifthsOf(m: Pick<Measure, 'tonic' | 'minor' | 'fifths'>): number {
  if (m.fifths !== undefined) return m.fifths;
  const major = m.minor ? (m.tonic + 3) % 12 : m.tonic;
  const f = (((major * 7) % 12) + 12) % 12;
  return f > 6 ? f - 12 : f;
}

/** The key signature in words: « 2 dièses », « 1 bémol », « sans altération ». */
export function signatureWords(fifths: number): string {
  if (!fifths) return 'sans altération';
  const n = Math.abs(fifths);
  return `${n} ${fifths > 0 ? 'dièse' : 'bémol'}${n > 1 ? 's' : ''}`;
}

/** The key's name at measure index i when the pack knows it (« si mineur »), else null: the key
 *  signature alone does not tell a major key from its relative minor. */
export function keyNameAt(mv: Movement, i: number): string | null {
  const list = mv.keys;
  if (!list?.length || i < list[0].m) return null;
  return list[lastAtOrBefore(list, i, (k) => k.m)].name ?? null;
}

/** Short form for a phone: « si min. », « Ré♭ maj. ». */
export const shortKeyName = (name: string) => name.replace(/\bmajeur\b/, 'maj.').replace(/\bmineur\b/, 'min.');

// ---------- clef ----------
/** The clef of score staff `staff` at measure index i (null: not in the pack, before 11/2026). */
export function clefAt(mv: Movement, staff: number, i: number): Clef | null {
  const list = mv.clefs?.[String(staff)];
  if (!list?.length) return null;
  return list[Math.max(0, lastAtOrBefore(list, i, (c) => c.m))];
}

/** The clef in words (title / screen readers). */
export function clefWords(c: Clef): string {
  const base =
    c.sign === 'G'
      ? 'Clé de sol'
      : c.sign === 'F'
        ? c.line === 4
          ? 'Clé de fa'
          : `Clé de fa ${c.line}e ligne`
        : c.sign === 'C'
          ? `Clé d’ut ${c.line === 1 ? '1re' : `${c.line}e`} ligne`
          : 'Clé de percussion';
  if (c.octave === -1) return `${base} octaviée (une octave plus bas)`;
  if (c.octave === 1) return `${base} à l’octave supérieure`;
  return base;
}

// ---------- tempo ----------
export interface ScoreTempo {
  bpm: number; // quarter notes per minute (at 100 %)
  beat: number; // beat unit, in quarters (printed unit, or the time signature's beat)
  text?: string;
}

/** The score's tempo at measure index i. Packs without `tempos` (or with the old shape, before
 *  11/2026): measured from the measures' timing. */
export function tempoAt(mv: Movement, i: number): ScoreTempo {
  const ms = mv.measures;
  const m = ms[Math.max(0, Math.min(ms.length - 1, i))];
  const ts = (m?.ts ?? [4, 4]) as [number, number];
  const list = (mv.tempos ?? []).filter((t: Partial<Tempo>) => typeof t.m === 'number');
  if (list.length) {
    const k = Math.max(0, lastAtOrBefore(list, i, (t) => t.m));
    const t = list[k];
    return { bpm: t.bpm, beat: t.beat ?? beatQuarters(ts), text: t.text ?? textBefore(list, k) };
  }
  // from the timing: the first measure with a duration at or after i
  let bpm = 120;
  for (let k = Math.max(0, i); k < ms.length; k++) {
    const next = ms[k + 1];
    const dt = (next ? next.t : mv.durationMs) - ms[k].t;
    const dq = next ? next.q - ms[k].q : (ms[k].ts[0] * 4) / ms[k].ts[1];
    if (dt > 0 && dq > 0) {
      bpm = Math.round((dq * 60000 * 10) / dt) / 10;
      break;
    }
  }
  return { bpm, beat: beatQuarters(ts) };
}

/** A tempo given again without its word keeps the word of the one before (same tempo name). */
function textBefore(list: Tempo[], k: number): string | undefined {
  for (let j = k; j >= 0; j--) if (list[j].text) return j === k || list[j].bpm === list[k].bpm ? list[j].text : undefined;
  return undefined;
}

/** Metronome values (Maelzel's scale), extended below 40 and above 208. */
const MM = [
  20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 63, 66, 69, 72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112, 116,
  120, 126, 132, 138, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 252, 264, 276, 288, 300,
];

/** The next metronome value up (dir 1) or down (-1) from `cur` (in beats per minute); the score's
 *  own value `base` is always one of the stops, so that one can come back to it exactly. */
export function stepTempo(cur: number, dir: 1 | -1, base: number): number {
  const stops = [...MM, Math.round(base)].sort((a, b) => a - b);
  if (dir > 0) return stops.find((v) => v > cur + 0.5) ?? cur;
  for (let k = stops.length - 1; k >= 0; k--) if (stops[k] < cur - 0.5) return stops[k];
  return cur;
}

export const RATE_MIN = 0.4;
export const RATE_MAX = 2; // a score at ♩ = 60 can be played up to ♩ = 120

// ---------- pages ----------
/** The printed page numbers as ranges: « 4–15, 20–21, 25 ». */
export function pageRanges(pages: Pick<Page, 'page'>[]): string {
  const ns = [...new Set(pages.map((p) => p.page))].sort((a, b) => a - b);
  const out: string[] = [];
  for (let k = 0; k < ns.length; ) {
    let j = k;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(j === k ? `${ns[k]}` : `${ns[k]}–${ns[j]}`);
    k = j + 1;
  }
  return out.join(', ');
}
