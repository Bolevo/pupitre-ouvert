// Song pack contract (produced by pipeline/build_pack.py). Times are ms at 100 % tempo.
// The pack carries only what the app reads: lyrics, staves, layers, chords and fermatas are in the
// MEI, which the app renders. Packs written before 10/2026 also carry note fields `staff, layer, q,
// dq, syl, fermata, chord` and movement fields `phrases` and an older `tempos` (v1 leftovers, without
// `m`): still accepted (packs already imported into IndexedDB keep them), simply ignored.

export const PACK_MAJOR = 1;

export interface PackNote {
  sp?: string; // French spelled name: 'do', 'fas' (fa sharp), 'sib' (si flat)
  id: string;
  ids?: string[]; // every MEI note drawn that is this sound: a tied chain, the strokes of a tremolo played slower
  moved?: true; // played before the place where its head is drawn (a tremolo at half its written rate)
  part: string;
  m: number; // measure index
  t: number;
  d: number;
  midi: number;
}

export interface Measure {
  id: string;
  n: string; // printed number, as written in the MEI (a string: '12', or e.g. '12a' if ever)
  t: number;
  q: number; // position in quarter notes (metronome)
  mark: string | null;
  tonic: number; // pitch class of the key's tonic (relative minor when `minor`)
  minor: boolean;
  fifths?: number; // key signature: sharps (> 0) or flats (< 0); packs before 11/2026 lack it
  ts: [number, number];
}

/** A clef from measure index `m` on (0 = the start); `octave` -1 = sounds an octave lower (tenor). */
export interface Clef {
  m: number;
  sign: 'G' | 'F' | 'C' | 'percussion';
  line: number;
  octave?: number;
}

/** A tempo from measure index `m` (time `t`, ms): `bpm` in quarter notes per minute (what is
 *  played at 100 %), `beat` the printed metronome unit in quarters when it is not the quarter,
 *  `text` the tempo word (Allegro…). */
export interface Tempo {
  t: number;
  m: number;
  bpm: number;
  beat?: number;
  text?: string;
}

export interface Part {
  id: string;
  name: string;
  sourceName: string;
  kind: 'voice' | 'accomp';
  staves: number[];
  range?: [number, number] | null;
}

export interface LyricLine {
  n: number;
  id: string;
  label: string;
  lang?: string | null;
}

export interface Movement {
  id: string;
  title: string;
  mei: string;
  parts: Part[];
  lyricLines: LyricLine[];
  measures: Measure[];
  notes: PackNote[];
  durationMs: number;
  clefs?: Record<string, Clef[]>; // by score staff number ('1'…'6')
  tempos?: Tempo[];
  /** the key's name from measure index `m` on, when known (work.yaml); null = not known there */
  keys?: { m: number; name: string | null }[];
}

export interface PageMeasure {
  mv: string; // movement id
  n: number; // printed measure number
  sys: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** First measure of a system: where its music starts, after the clef and the signatures
   *  (the playhead starts there instead of x0; tools/page_starts.py). */
  xn?: number;
}

export interface Page {
  page: number; // printed page number
  img: string; // path inside the pack
  w: number;
  h: number;
  /** staves: top / bottom line of each score staff in this system (index i = score staff i + 1),
   *  only when every staff could be found (tools/page_staves.py) */
  systems: { top: number; bottom: number; staves?: { top: number; bottom: number }[] }[];
  measures: PageMeasure[];
}

export interface Pack {
  version: number;
  id: string;
  title: string;
  composer: string;
  notice?: string;
  defaultPart?: string | null;
  movements: Movement[];
  pages?: Page[];
  fiche?: string; // the work's information sheet (Markdown file in the pack)
}

/** A pack plus a way to fetch its files (built-in: URL; imported: IndexedDB). */
export interface LoadedPack {
  pack: Pack;
  source: 'builtin' | 'imported';
  getFile(name: string): Promise<string>;
  url(name: string): string; // for images

}
