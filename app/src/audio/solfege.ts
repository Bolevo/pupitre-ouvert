// "Nom des notes": at the start of each note a voice sings its name (do, ré, mi, fa, sol, la, si;
// the accidental is not said) on the note's own pitch, then a choir "ah" holds that pitch for the
// rest of the note. A man's voice for the low parts (tenor, bass), a woman's for soprano and alto;
// any other part (the piano) takes one or the other by the pitch.
// The samples (app/public/sf/solfege, tools/make_solfege.py) are one file per name and semitone
// over each voice's range: nothing is transposed here. Outside the range (the ends of the piano)
// the name is sung one or more octaves away. (Until 11/2026 the name was SPOKEN, in a span of one
// octave per voice, the note folded into it: an octave or two under most of a tenor's notes, with
// a leap of a seventh when the melody crossed the fold.)
// Each (name, voice, pitch) is brought to the context's rate once, then played as is.
import type { Source, StopNote } from './instruments';
import { decodeAt, fetchOk, mono, POOL, resample, stopNote } from './sfont';

type Voice = 'm' | 'f';

interface ZoneDef {
  name: string;
  voice: Voice;
  file: string;
  root: number;
  cents: number;
  sr: number;
  onset: number; // s from the start of the file to the vowel
  gain: number;
}

interface Rendered {
  buf: AudioBuffer;
  onset: number;
  gain: number;
}

// the name said for each pitch class when the score gives none (C sharp = do, B flat = si…)
const BY_PC = ['do', 'do', 're', 'mi', 'mi', 'fa', 'fa', 'sol', 'sol', 'la', 'si', 'si'];
const PLAIN = /^(do|re|mi|fa|sol|la|si)/;
const SPEECH = 0.5; // level of the name (vowel RMS 0.12 -> 0.06, a little above the choir)
// The choir while the name is sung, then it rises to full level. The name is on the same pitch: a
// choir "ah" at full level under it blurs its vowel (do, ré, mi... all turn towards "a"), so the
// choir stays well under until the vowel has been heard.
const UNDER = 0.25;
const UNDER_UNTIL = 0.18; // s after the beat: the name's vowel lasts 0.23 s
const FULL_AT = 0.42;

/** The plain note name ("fas" -> "fa", "sib" -> "si"). */
export function plainName(midi: number, name?: string): string {
  return (name && PLAIN.exec(name)?.[1]) || BY_PC[((Math.round(midi) % 12) + 12) % 12];
}

/** Soprano and alto get the woman's voice, tenor and bass the man's; any other part (the piano)
 *  the woman's from middle C up, the man's below: each sings where it can. */
export function voiceOf(part: string | undefined, midi: number): Voice {
  if (part && /^[SA]/i.test(part)) return 'f';
  if (part && /^[TB]/i.test(part)) return 'm';
  return midi >= 60 ? 'f' : 'm';
}

export class SolfegeVoice implements Source {
  loaded = false;
  private loading: Promise<void> | null = null;
  private zones = new Map<string, ZoneDef[]>(); // `${voice}:${name}`
  private spans: Record<Voice, [number, number]> = { m: [38, 72], f: [52, 84] }; // the manifest's
  private data = new Map<string, Promise<Float32Array>>();
  private notes = new Map<string, Rendered>();
  private pending = new Map<string, Promise<void>>();
  private keep: Set<string> | null = null; // the names to keep (null: all), see retain()

  constructor(
    private ctx: BaseAudioContext,
    private url: string,
    private choir: Source, // holds the pitch
  ) {}

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const [m] = await Promise.all([(await fetchOk(`${this.url}manifest.json`)).json(), this.choir.load()]);
        if (m.spans) this.spans = m.spans;
        for (const z of m.zones as ZoneDef[]) {
          const k = `${z.voice}:${z.name}`;
          const list = this.zones.get(k) ?? [];
          list.push(z);
          this.zones.set(k, list);
        }
        this.loaded = true;
      })().catch((e) => {
        this.loading = null; // retried on the next call (see SfInstrument.load)
        console.warn('instrument', this.url, e);
        throw e;
      });
    }
    return this.loading;
  }

  /** The pitch the name is sung at: the note's own, or (outside the voice's span) the note moved
   *  by octaves into it. */
  private spoken(midi: number, v: Voice): number {
    const [lo, hi] = this.spans[v];
    let m = Math.round(midi);
    while (m > hi) m -= 12;
    while (m < lo) m += 12;
    return m;
  }

  private key(midi: number, name: string | undefined, v: Voice) {
    const n = plainName(midi, name);
    const m = this.spoken(midi, v);
    return { n, m, k: `${v}:${n}:${m}` };
  }

  private samples(z: ZoneDef): Promise<Float32Array> {
    let p = this.data.get(z.file);
    if (!p) {
      p = (async () => {
        const bytes = await (await fetchOk(this.url + z.file)).arrayBuffer();
        return mono(await decodeAt(this.ctx, bytes, z.sr));
      })().catch((e) => {
        this.data.delete(z.file); // retried on the next call
        throw e;
      });
      this.data.set(z.file, p);
    }
    return p;
  }

  async prepare(midis: Iterable<number>, names?: (string | undefined)[], parts?: (string | undefined)[]) {
    try {
      await this.load();
    } catch {
      return; // the choir alone (or the synthetic voice) until the next attempt
    }
    const ms = [...midis];
    void this.choir.prepare?.(ms);
    const todo: [string, Voice, string, number][] = [];
    const seen = new Set<string>();
    ms.forEach((midi, i) => {
      const v = voiceOf(parts?.[i], midi);
      const { n, m, k } = this.key(midi, names?.[i], v);
      if (!seen.has(k) && !this.notes.has(k) && !this.pending.has(k) && (!this.keep || this.keep.has(k))) {
        seen.add(k);
        todo.push([k, v, n, m]);
      }
    });
    for (let i = 0; i < todo.length; i += POOL) {
      await Promise.all(
        todo.slice(i, i + POOL).map(([k, v, n, m]) => {
          const p = this.render(k, v, n, m).finally(() => this.pending.delete(k));
          this.pending.set(k, p);
          return p;
        }),
      );
    }
  }

  /** Keeps only the names needed by these notes (same arguments as prepare); the choir that holds
   *  the pitches is kept by the engine. */
  retain(midis: Iterable<number>, names?: (string | undefined)[], parts?: (string | undefined)[]) {
    const keep = (this.keep = new Set<string>());
    [...midis].forEach((midi, i) => keep.add(this.key(midi, names?.[i], voiceOf(parts?.[i], midi)).k));
    for (const k of this.notes.keys()) if (!keep.has(k)) this.notes.delete(k);
  }

  /** Releases the decoded syllables (fetched and decoded again on demand). */
  unload(): boolean {
    if (this.pending.size) return false;
    this.notes.clear();
    this.data.clear();
    return true;
  }

  private async render(key: string, v: Voice, name: string, midi: number) {
    let z: ZoneDef | null = null;
    for (const c of this.zones.get(`${v}:${name}`) ?? []) if (!z || Math.abs(c.root - midi) < Math.abs(z.root - midi)) z = c;
    if (!z) return;
    const data = await this.samples(z);
    const sr = this.ctx.sampleRate;
    const ratio = Math.pow(2, (midi - z.root - z.cents / 100) / 12) * (z.sr / sr);
    const r = await resample({ data, ratio, loopStart: -1, loopEnd: -1, maxOut: Math.round(2 * sr) });
    if (!r || (this.keep && !this.keep.has(key))) return; // dropped meanwhile
    const buf = this.ctx.createBuffer(1, r.out.length, sr);
    buf.copyToChannel(r.out as Float32Array<ArrayBuffer>, 0);
    this.notes.set(key, { buf, onset: (z.onset * z.sr) / sr / ratio, gain: z.gain });
  }

  play(dest: AudioNode, midi: number, when: number, dur: number, level = 1, elapsed = 0, name?: string, part?: string): StopNote {
    const ctx = this.ctx;
    const stops: StopNote[] = [];
    const r = this.notes.get(this.key(midi, name, voiceOf(part, midi)).k);
    // the choir holds the pitch: well under while the name is sung
    const under = ctx.createGain();
    under.connect(dest);
    const said = r && elapsed < 0.05; // a note joined in progress: its name was sung already
    if (said) {
      under.gain.setValueAtTime(UNDER, when);
      under.gain.setValueAtTime(UNDER, when + UNDER_UNTIL);
      under.gain.linearRampToValueAtTime(1, when + FULL_AT);
    }
    stops.push(this.choir.play(under, midi, when, dur, level, elapsed));
    if (!r) {
      this.keep?.add(this.key(midi, name, voiceOf(part, midi)).k); // played: wanted (until the next retain)
      void this.prepare([midi], [name], [part]);
    }
    if (said) {
      // the name: its vowel on the beat (the consonant just before, when there is time)
      let start = when - r.onset;
      let offset = 0;
      const earliest = ctx.currentTime + 0.005;
      if (start < earliest) {
        offset = earliest - start;
        start = earliest;
      }
      const src = ctx.createBufferSource();
      src.buffer = r.buf;
      const g = ctx.createGain();
      g.gain.value = 0; // never the default 1 before the first event
      const peak = r.gain * SPEECH * level;
      g.gain.setValueAtTime(peak, start);
      // a short note: the name stops with it (but is never cut before its vowel is heard)
      const cut = Math.max(when + dur, when + 0.16);
      const natural = start + r.buf.duration - offset;
      if (cut < natural) {
        g.gain.setValueAtTime(peak, cut);
        g.gain.linearRampToValueAtTime(0, cut + 0.05);
      }
      src.connect(g).connect(dest);
      src.start(start, offset);
      src.stop(Math.min(natural, cut + 0.06) + 0.01);
      stops.push((at?: number, tau = 0.02) => stopNote(ctx, start, g.gain, [src], tau, at));
    }
    return (at?: number, tau?: number) => stops.forEach((s) => s(at, tau));
  }
}
