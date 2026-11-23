// Multi-sampled instruments with every needed pitch rendered once, in a worker, with a
// high-quality resampler, then played back untouched (RAM instead of CPU, no linear-interpolation
// grain). A note whose pitch is not rendered yet is rendered on the spot (a few ms): the recording
// is never played shifted by the browser (its loop seam clicked: heard as small pops on attacks). Voices come from SoundFont zones with their real loop points (app/public/sf/<id>/),
// the piano from the Salamander recordings.
import type { Source, StopNote } from './instruments';
import { resample as resampleNow, type ResampleJob, type ResampleResult } from './resample';

export interface ZoneDef {
  file: string;
  lo: number;
  hi: number;
  root: number;
  cents: number; // the recording sounds at root + cents/100
  sr: number; // native sample rate (loop positions are in native samples)
  loopStart: number; // null or -1 = no loop; the file holds a few ms after loopEnd continuing the loop
  loopEnd: number;
  release: number; // s
  gain: number;
}

interface Zone extends ZoneDef {
  data: Float32Array; // mono, at the context rate
  ls: number; // loop in context samples (-1 = none)
  le: number;
}

interface Note {
  buf: AudioBuffer;
  loop: [number, number] | null; // seconds
  onset: number; // seconds skipped so the note speaks on the beat
  zone: Zone;
}

// a small pool of workers shared by all instruments (phones have several cores), ended after
// WORKERS_IDLE_MS without a job (each holds its own heap) and started again on demand
export const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
const WORKERS_IDLE_MS = 30_000;
const workers: Worker[] = [];
let nextJob = 1;
let rr = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const waiting = new Map<number, (r: ResampleResult | null) => void>();
function idleSoon() {
  clearTimeout(idleTimer);
  if (waiting.size) return;
  idleTimer = setTimeout(() => {
    if (waiting.size) return;
    for (const w of workers) w.terminate();
    workers.length = 0;
  }, WORKERS_IDLE_MS);
}
/** Resolves null when the worker failed (the pitch then stays unrendered: the zone plays shifted). */
export function resample(job: Omit<ResampleJob, 'id'>): Promise<ResampleResult | null> {
  clearTimeout(idleTimer);
  if (!workers.length) {
    for (let i = 0; i < POOL; i++) {
      const w = new Worker(new URL('./resample.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<ResampleResult>) => {
        const cb = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        cb?.(e.data);
        idleSoon();
      };
      w.onerror = (e) => {
        // a worker that fails (script not loaded, out of memory) must not leave jobs waiting forever
        console.warn('resample worker', e.message);
        for (const cb of waiting.values()) cb(null);
        waiting.clear();
        idleSoon();
      };
      workers.push(w);
    }
  }
  const id = nextJob++;
  const w = workers[rr++ % workers.length];
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    // one copy of the part of the zone the worker will read (the whole zone was copied twice
    // before: once by slice(), once by the structured clone), handed over without a second copy
    const { data, ratio, loopStart, loopEnd, maxOut } = job;
    const need = loopStart >= 0 && loopEnd - loopStart >= 64 ? loopEnd : Math.min(data.length, Math.ceil(maxOut * ratio + 16 * Math.max(1, ratio) + 16));
    const part = data.slice(0, need);
    w.postMessage({ id, ratio, loopStart, loopEnd, maxOut, data: part }, [part.buffer]);
  });
}

export class SfInstrument implements Source {
  private zones: Zone[] = [];
  private notes = new Map<number, Note>();
  private pending = new Map<number, Promise<void>>();
  private loading: Promise<void> | null = null;
  private keep: Set<number> | null = null; // the pitches to keep (null: all), see retain()
  loaded = false;

  constructor(
    private ctx: BaseAudioContext,
    private url: string,
    private opts: { sustain: boolean; maxSeconds: number; zones?: ZoneDef[]; level?: number },
  ) {}

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const defs: ZoneDef[] = this.opts.zones ?? (await (await fetchOk(`${this.url}manifest.json`)).json()).zones;
        const sr = this.ctx.sampleRate;
        this.zones = await Promise.all(
          defs.map(async (z) => {
            const bytes = await (await fetchOk(this.url + z.file)).arrayBuffer();
            // decode at the recording's own rate: loop points stay sample-exact; the resampler
            // converts the rate and the pitch in one go
            const native = z.sr > 0 ? z.sr : sr;
            const ab = await decodeAt(this.ctx, bytes, native);
            let data = mono(ab);
            // an unsustained sound is never read past maxSeconds (+ the resampler's margin): the
            // rest of the recording (piano: 7 s decoded, 3 s used) is dropped
            if (!this.opts.sustain) {
              const keep = Math.ceil(this.opts.maxSeconds * 1.25 * ab.sampleRate);
              if (keep < data.length) {
                data = data.slice(0, keep);
                fadeTail(data, Math.round(0.25 * ab.sampleRate)); // the raw copy must not end with a click
              }
            }
            const k = ab.sampleRate / native; // 1 unless the browser refused the native rate
            const looped = this.opts.sustain && z.loopStart != null && z.loopEnd != null && z.loopStart >= 0 && z.loopEnd > z.loopStart;
            return {
              ...z,
              sr: ab.sampleRate,
              data,
              ls: looped ? Math.round(z.loopStart * k) : -1,
              le: looped ? Math.round(z.loopEnd * k) : -1,
            };
          }),
        );
        this.zones.sort((a, b) => a.lo - b.lo);
        this.loaded = true;
      })().catch((e) => {
        // a failed download (first visit offline, flaky network) is retried on the next call,
        // instead of leaving the instrument on the synthetic voice for the whole session
        this.loading = null;
        console.warn('instrument', this.url, e);
        throw e;
      });
    }
    return this.loading;
  }

  private zoneFor(midi: number): Zone {
    let best = this.zones[0];
    for (const z of this.zones) {
      if (midi >= z.lo && midi <= z.hi) return z;
      if (Math.abs(z.root - midi) < Math.abs(best.root - midi)) best = z;
    }
    return best;
  }

  /** Render these pitches in the background (the notes of a movement), nearest first. */
  async prepare(midis: Iterable<number>, _names?: (string | undefined)[]) {
    try {
      await this.load();
    } catch {
      return; // the sound stays synthetic until the next attempt
    }
    const todo = [...new Set(midis)].filter((m) => !this.notes.has(m) && !this.pending.has(m));
    // a few at a time (one per worker), in order: the first notes of the piece are ready first
    for (let i = 0; i < todo.length && this.loaded; i += POOL) {
      const batch = todo.slice(i, i + POOL).filter((m) => !this.notes.has(m) && !this.pending.has(m) && this.wanted(m));
      await Promise.all(
        batch.map((m) => {
          const p = this.render(m).finally(() => this.pending.delete(m));
          this.pending.set(m, p);
          return p;
        }),
      );
    }
  }

  /** Renders now (on this thread) the pitches not rendered yet. */
  ready(midis: Iterable<number>) {
    if (!this.zones.length) return;
    for (const m of new Set(midis)) if (!this.notes.has(m)) this.renderNow(m);
  }

  /** Keeps only these rendered pitches (those of the movement, on this instrument): the others are
   *  dropped (a note still sounding holds its own buffer). */
  retain(midis: Iterable<number>) {
    const keep = (this.keep = new Set([...midis].map((m) => Math.round(m))));
    for (const m of this.notes.keys()) if (!keep.has(m)) this.notes.delete(m);
  }

  // renders still queued or running for pitches dropped meanwhile are not kept
  private wanted = (m: number) => !this.keep || this.keep.has(m);

  /** Releases the decoded recordings (the instrument is not used any more); load() again later. */
  unload(): boolean {
    if (this.pending.size) return false;
    if (!this.loaded) return !this.loading; // still downloading: tried again later
    this.zones = [];
    this.notes.clear();
    this.loaded = false;
    this.loading = null;
    return true;
  }

  /** The resampling job of a pitch: the pitch shift times the rate conversion, in source samples
   *  per output sample. */
  private job(midi: number) {
    const z = this.zoneFor(midi);
    const ratio = Math.pow(2, (midi - z.root - z.cents / 100) / 12) * (z.sr / this.ctx.sampleRate);
    const maxOut = Math.round(this.opts.maxSeconds * this.ctx.sampleRate);
    return { z, job: { data: z.data, ratio, loopStart: z.ls, loopEnd: z.le, maxOut } };
  }

  private async render(midi: number) {
    if (!this.zones.length) return; // unloaded meanwhile
    const { z, job } = this.job(midi);
    const r = await resample(job);
    if (!r || !this.wanted(midi) || !this.zones.length || this.notes.has(midi)) return;
    this.keepRendered(midi, z, r);
  }

  /** The same rendering, at once (a note needed before its turn in the workers). */
  private renderNow(midi: number): Note {
    const { z, job } = this.job(midi);
    return this.keepRendered(midi, z, resampleNow({ id: 0, ...job }));
  }

  private keepRendered(midi: number, z: Zone, r: ResampleResult): Note {
    if (r.loopStart < 0) fadeTail(r.out, Math.round(0.25 * this.ctx.sampleRate));
    const buf = this.ctx.createBuffer(1, r.out.length, this.ctx.sampleRate);
    buf.copyToChannel(r.out as Float32Array<ArrayBuffer>, 0);
    const sr = this.ctx.sampleRate;
    const note: Note = {
      buf,
      loop: r.loopStart >= 0 ? [r.loopStart / sr, r.loopEnd / sr] : null,
      onset: onsetOf(r.out, sr, this.opts.sustain),
      zone: z,
    };
    this.notes.set(midi, note);
    return note;
  }

  play(dest: AudioNode, midi: number, when: number, dur: number, level = 1, elapsed = 0): StopNote {
    if (!this.zones.length) return () => {};
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    let note = this.notes.get(midi);
    if (!note) {
      // not rendered yet (rare: it was not among the pitches prepared): rendered now
      this.keep?.add(Math.round(midi)); // played: wanted (until the next retain)
      note = this.renderNow(midi);
    }
    src.buffer = note.buf;
    if (note.loop) {
      src.loop = true;
      src.loopStart = note.loop[0];
      src.loopEnd = note.loop[1];
    }
    const g = ctx.createGain();
    g.gain.value = 0; // never the default 1 before the first event (a one-sample pop at the start)
    const peak = note.zone.gain * (this.opts.level ?? 1) * level;
    const release = Math.min(0.45, Math.max(0.12, note.zone.release || 0.2));
    // a note joined well into its course (restart, late tick) fades in over 30 ms: the length of the
    // crossfade with the copy it replaces (fading out with a 25 ms time constant)
    const attack = elapsed >= 0.03 ? 0.03 : this.opts.sustain ? 0.012 : 0.002;
    const end = when + Math.max(0.06, dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setValueAtTime(peak, end);
    g.gain.setTargetAtTime(0, end, release / 3);
    src.connect(g).connect(dest);
    const offset = note.onset + elapsed;
    src.start(when, Math.min(offset, note.loop ? note.loop[0] : Math.max(0, note.buf.duration - 0.05)));
    src.stop(end + release * 1.6);
    return (at?: number, tau = 0.025) => stopNote(ctx, when, g.gain, [src], tau, at);
  }
}

/** Stops a scheduled note without a click, fading out from `at` (default now; later: a crossfade
 *  with the copy that replaces it): a note that would not have started by then is silenced and
 *  dropped (the gain of a source before its first automation event is 1: letting it start, even to
 *  fade out, gives a short burst); a sounding note fades from its level at `at` (also mid-attack). */
export function stopNote(ctx: BaseAudioContext, when: number, gain: AudioParam, srcs: AudioScheduledSourceNode[], tau = 0.025, at?: number) {
  const now = ctx.currentTime;
  const t = Math.max(now, at ?? now);
  try {
    if (t <= when) {
      gain.cancelScheduledValues(0);
      gain.setValueAtTime(0, now);
      for (const s of srcs) s.stop();
      return;
    }
    holdAt(gain, t);
    gain.setTargetAtTime(0, t, tau);
    for (const s of srcs) s.stop(t + tau * 6);
  } catch {
    /* already stopped */
  }
}

/** Freezes a parameter at the value it has at t, dropping what was scheduled after (Firefox has no
 *  cancelAndHoldAtTime: the current value is re-posted). */
export function holdAt(p: AudioParam, t: number) {
  const q = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (q.cancelAndHoldAtTime) q.cancelAndHoldAtTime(t);
  else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

export async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// one offline context per sample rate, reused for every decode at that rate (decodeAudioData does
// not depend on the context's rendering); the main context decodes its own rate
const decoders = new Map<number, OfflineAudioContext>();
/** Decodes at the recording's own rate when the browser allows it, else at the context's. */
export async function decodeAt(ctx: BaseAudioContext, bytes: ArrayBuffer, sr: number): Promise<AudioBuffer> {
  if (sr !== ctx.sampleRate) {
    try {
      let d = decoders.get(sr);
      if (!d) decoders.set(sr, (d = new OfflineAudioContext(1, 1, sr)));
      return await d.decodeAudioData(bytes);
    } catch {
      /* rate refused (Safari) or decode failed at that rate: the context's own rate */
    }
  }
  return ctx.decodeAudioData(bytes);
}

export function mono(ab: AudioBuffer): Float32Array {
  if (ab.numberOfChannels === 1) return ab.getChannelData(0).slice();
  const a = ab.getChannelData(0);
  const b = ab.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = 0.5 * (a[i] + b[i]);
  return out;
}

function fadeTail(d: Float32Array, n: number) {
  const s = Math.max(0, d.length - n);
  for (let i = s; i < d.length; i++) d[i] *= (d.length - i) / (d.length - s);
}

/** Where the note speaks (half its level): starting there puts the audible attack on the beat. */
function onsetOf(d: Float32Array, sr: number, sustain: boolean): number {
  const win = Math.round(sr * 0.005);
  const n = Math.min(d.length, Math.round(sr * 0.8));
  const env: number[] = [];
  let mx = 0;
  for (let i = 0; i + win <= n; i += win) {
    let a = 0;
    for (let j = i; j < i + win; j++) a += d[j] * d[j];
    const r = Math.sqrt(a / win);
    env.push(r);
    mx = Math.max(mx, r);
  }
  if (!mx) return 0;
  const k = env.findIndex((r) => r >= mx * (sustain ? 0.5 : 0.3));
  return Math.max(0, Math.min(sustain ? 0.15 : 0.03, (k * win) / sr - 0.006));
}
