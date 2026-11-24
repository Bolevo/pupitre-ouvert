// Sound sources: multi-sampled instruments (SoundFont choir "ah" and strings; Salamander piano),
// each pitch rendered once with a high-quality resampler (see sfont.ts); two synthesized ones that
// need no download: the clarinet (reed.ts, also heard while samples load) and the marimba
// (mallet.ts). The note names (solfege.ts) sing over the choir "ah". Removed 11/2026, little used:
// voice "ou", flute, soft synthesized voice.

import { SfInstrument, type ZoneDef } from './sfont';
import { MalletVoice } from './mallet';
import { ReedVoice } from './reed';
import { SolfegeVoice } from './solfege';
import { ttKey } from '../i18n';

export type InstId = 'aahs' | 'solfege' | 'clarinet' | 'marimba' | 'strings' | 'piano';

/** `label`: the instrument's name in French, shown through `tt` (i18n.ts). */
export const INSTRUMENTS: { id: InstId; label: string }[] = [
  { id: 'aahs', label: ttKey('Chœur « ah »') },
  { id: 'solfege', label: ttKey('Nom des notes (do, ré…)') },
  { id: 'clarinet', label: ttKey('Clarinette') },
  { id: 'marimba', label: ttKey('Marimba') },
  { id: 'strings', label: ttKey('Cordes') },
  { id: 'piano', label: ttKey('Piano') },
];

/** Stops a note early: fading out from audio time `at` (default: now), with time constant `tau`
 *  (default: the instrument's own, ~25 ms). */
export type StopNote = (at?: number, tau?: number) => void;

export interface Source {
  /** Start a note; returns its early stop. `elapsed`: seconds of the note already past at `when`
   *  (a note joined in progress starts there, without its attack). */
  play(dest: AudioNode, midi: number, when: number, dur: number, level?: number, elapsed?: number, name?: string, part?: string): StopNote;
  readonly loaded: boolean;
  load(): Promise<void>;
  /** Optional: render these pitches now, synchronously (a few ms each), those that are not ready:
   *  called before playback starts, so that no note is late. */
  ready?(midis: Iterable<number>): void;
  /** Optional: get these pitches ready in advance (rendered once, kept in memory). `names` (the
   *  spelled note names) and `parts`, aligned with `midis`, serve the voice that says the names. */
  prepare?(midis: Iterable<number>, names?: (string | undefined)[], parts?: (string | undefined)[]): Promise<void>;
  /** Optional: keep only these rendered pitches (same arguments as prepare), drop the others. */
  retain?(midis: Iterable<number>, names?: (string | undefined)[], parts?: (string | undefined)[]): void;
  /** Optional: release the decoded recordings (reloaded on demand); false while still rendering. */
  unload?(): boolean;
}

const PC: Record<string, number> = { C: 0, Ds: 3, Eb: 3, Fs: 6, Gb: 6, A: 9 };
const nameMidi = (name: string) => {
  const m = /^([A-G][bs]?)(\d)$/.exec(name)!;
  return 12 * (Number(m[2]) + 1) + PC[m[1]];
};

const PIANO_NAMES = ['A0', ...[1, 2, 3, 4, 5, 6, 7].flatMap((o) => ['C', 'Ds', 'Fs', 'A'].map((n) => `${n}${o}`)), 'C8'];

const VOICE_IDS = ['aahs', 'strings'] as const;

/** Salamander piano: one recording every 3 semitones, each covering its neighbours. */
function pianoZones(): ZoneDef[] {
  const roots = PIANO_NAMES.map((n) => ({ n, m: nameMidi(n) })).sort((a, b) => a.m - b.m);
  return roots.map((r, i) => ({
    file: `${r.n}.mp3`,
    lo: i ? Math.floor((roots[i - 1].m + r.m) / 2) + 1 : 0,
    hi: i < roots.length - 1 ? Math.floor((r.m + roots[i + 1].m) / 2) : 127,
    root: r.m,
    cents: 0,
    sr: 0,
    loopStart: -1,
    loopEnd: -1,
    release: 0.3,
    gain: 0.8,
  }));
}

export function makeSources(ctx: AudioContext, baseUrl: string): Record<InstId, Source> {
  const out: Partial<Record<InstId, Source>> = {
    // piano notes kept 3 s at most (they have long decayed by then): about 0.6 MB per pitch
    piano: new SfInstrument(ctx, `${baseUrl}audio/piano/`, { sustain: false, maxSeconds: 3, zones: pianoZones() }),
    clarinet: new ReedVoice(ctx),
    marimba: new MalletVoice(ctx),
  };
  // the SoundFont zones are normalised to RMS 0.12: brought down to sit with the piano
  for (const id of VOICE_IDS)
    out[id] = new SfInstrument(ctx, `${baseUrl}sf/${id}/`, { sustain: true, maxSeconds: 20, level: 0.45 });
  out.solfege = new SolfegeVoice(ctx, `${baseUrl}sf/solfege/`, out.aahs!);
  return out as Record<InstId, Source>;
}
