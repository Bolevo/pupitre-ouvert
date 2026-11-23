// « Enregistrer ma voix »: one take of the user's voice per movement. The pure part, testable
// without an AudioContext: building a take from the microphone's frames (timing, decimation, caps),
// planning its playback in segments on the audio clock, and the WAV file (export / import).
//
// Timing model. A take is mono 16-bit PCM at `sr` (half the audio context's rate: voice only). Its
// sample i belongs to score time startSt + i / sr * 1000 * rate (ms at 100 % tempo): it was sung
// along with music played at `rate`, and it is heard back only at that same rate.

export interface TakeMeta {
  v: 1;
  sr: number; // samples per second
  startSt: number; // score ms of the first sample (latency compensated at capture)
  rate: number; // playback rate (tempo factor) when it was recorded
  at: number; // Date.now() when it was recorded or imported
  durMs: number; // real duration (ms)
  part?: string; // the followed part when it was recorded (file names)
}

export interface Take extends TakeMeta {
  pcm: Int16Array;
}

/** IndexedDB key of a movement's take. */
export const takeKey = (workId: string, mvId: string) => `take:${workId}:${mvId}`;

/** A take shorter than this is a slip of the finger: not kept (ms). */
export const MIN_TAKE_MS = 1000;

/** Same playback rate (the take can be heard). */
export const sameRate = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** Score ms just after the take's last sample. */
export const takeEndSt = (t: Pick<TakeMeta, 'startSt' | 'durMs' | 'rate'>) => t.startSt + t.durMs * t.rate;

// ---------- capture ----------

export interface Anchor {
  ctx: number; // AudioContext time (s)…
  st: number; // …at which this score time (ms) is played
  rate: number;
}

/** Builds a take from the microphone's frames as the capture worklet sends them (context rate,
 *  `frame` = context frame of the first sample). A sample captured at context time T was sung
 *  along with the music played at T − latency (input + output latency): its score time comes from
 *  the playback anchor. Frames before the anchor (the start margin) or past `endSt` (the end of the
 *  movement) are dropped; the rest is averaged by pairs (half the rate) into 16-bit samples. A gap
 *  in the frames (should not happen) is filled with silence, so that the timing holds. */
export class TakeBuilder {
  readonly sr: number;
  private chunks: Int16Array[] = [];
  private count = 0; // output samples
  private firstFrame: number; // first context frame kept
  private nextFrame: number; // next context frame expected (kept or not)
  private lastFrame: number; // last context frame that may be kept (end of the movement)
  private carry: number | null = null; // a frame waiting for its pair

  constructor(
    private ctxRate: number,
    private anchor: Anchor,
    private latency: number,
    private endSt: number,
  ) {
    this.sr = ctxRate / 2;
    this.firstFrame = Math.ceil((anchor.ctx + latency) * ctxRate - 1e-6);
    this.nextFrame = this.firstFrame;
    this.lastFrame = this.frameOfScore(endSt);
  }

  /** Context frame whose sample belongs to score time st. */
  private frameOfScore(st: number) {
    const a = this.anchor;
    return Math.floor((a.ctx + this.latency + (st - a.st) / 1000 / a.rate) * this.ctxRate + 1e-6);
  }

  /** Score time (ms) of the sample captured at context frame f. */
  scoreOfFrame(f: number) {
    const a = this.anchor;
    return a.st + (f / this.ctxRate - this.latency - a.ctx) * 1000 * a.rate;
  }

  /** Frames from the capture worklet. Returns the RMS level of this batch (0..1), for a meter. */
  push(frame: number, data: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = data.length ? Math.sqrt(sum / data.length) : 0;
    if (frame + data.length <= this.nextFrame) return rms; // before the anchor, or already seen
    if (frame > this.nextFrame) {
      // frames missing (or the first batch came late): silence in their place, the timing holds
      this.take(new Float32Array(Math.min(frame, this.lastFrame + 1) - this.nextFrame));
    }
    const from = Math.max(0, this.nextFrame - frame);
    const to = Math.min(data.length, this.lastFrame + 1 - frame);
    if (to > from) this.take(data.subarray(from, to));
    this.nextFrame = Math.max(this.nextFrame, frame + data.length);
    return rms;
  }

  private take(d: Float32Array) {
    if (!d.length) return;
    let i = 0;
    const n = Math.floor((d.length + (this.carry === null ? 0 : 1)) / 2);
    const out = new Int16Array(n);
    let k = 0;
    if (this.carry !== null) {
      out[k++] = toInt16((this.carry + d[0]) / 2);
      i = 1;
      this.carry = null;
    }
    for (; i + 1 < d.length; i += 2) out[k++] = toInt16((d[i] + d[i + 1]) / 2);
    if (i < d.length) this.carry = d[i];
    this.chunks.push(out);
    this.count += n;
  }

  /** Output samples so far. */
  get length() {
    return this.count;
  }

  /** The take, cut at score time `capSt` (where the music was stopped); null if nothing was kept. */
  finish(capSt: number, at = Date.now(), part?: string): Take | null {
    const startSt = this.scoreOfFrame(this.firstFrame);
    const max = Math.max(0, Math.floor(((Math.min(capSt, this.endSt) - startSt) / 1000 / this.anchor.rate) * this.sr + 1e-6));
    const n = Math.min(this.count, max);
    if (n <= 0) return null;
    const pcm = new Int16Array(n);
    let k = 0;
    for (const c of this.chunks) {
      if (k >= n) break;
      const part = c.length > n - k ? c.subarray(0, n - k) : c;
      pcm.set(part, k);
      k += part.length;
    }
    this.chunks = [];
    normalize(pcm);
    return { v: 1, sr: this.sr, startSt, rate: this.anchor.rate, at, durMs: (n / this.sr) * 1000, part, pcm };
  }
}

/** Target peak of a recorded take (−3 dBFS) and the most it is ever amplified (pure noise must
 *  not come up): the microphone's automatic gain is off (singing), so a quiet take is brought to a
 *  sensible level once, when it is saved. Never made quieter. Returns the gain applied. */
export const NORM_PEAK = 0.708;
export const NORM_MAX_GAIN = 8;
export function normalize(pcm: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]);
    if (v > peak) peak = v;
  }
  if (!peak) return 1;
  const g = Math.min(NORM_MAX_GAIN, (NORM_PEAK * 32767) / peak);
  if (g <= 1.01) return 1;
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(pcm[i] * g);
  return g;
}

function toInt16(v: number) {
  return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
}

// ---------- playback ----------

/** Length of a playback segment (s): one AudioBufferSourceNode each, made just before it is due. */
export const SEGMENT_S = 2;
/** Fade-in (s) of a segment joined in the middle of the take (a start, a jump, a late tick). */
export const JOIN_FADE_S = 0.005;

export interface TakeSegment {
  k: number; // segment index
  i0: number; // first sample (take rate)
  i1: number; // after the last sample
  when: number; // AudioContext time of sample i0
  fade: boolean; // joined in the middle: fade in
}

export interface TakePlanInput {
  len: number; // samples in the take
  sr: number;
  base: number; // AudioContext time of sample 0 (may be in the past)
  minWhen: number; // nothing may start before this (the anchor, now + a margin)
  horizon: number; // plan the segments that start before this AudioContext time
  endCtx: number; // the end of the movement: nothing after it
  from: number; // first segment index not planned yet
}

/** The take's segments to hand to the audio clock now; `next` is where the following call goes on.
 *  A segment whose start is already past (the start of playback, a jump, a late tick) is joined
 *  from minWhen, at a sample boundary, with a short fade-in; whole segments follow each other
 *  exactly (sample i at base + i / sr). */
export function planTake(p: TakePlanInput): { next: number; plan: TakeSegment[] } {
  const N = Math.round(p.sr * SEGMENT_S);
  const iEnd = Math.min(p.len, Math.max(0, Math.floor((p.endCtx - p.base) * p.sr + 1e-6)));
  const plan: TakeSegment[] = [];
  let k = p.from;
  for (; k * N < iEnd; k++) {
    const s0 = k * N;
    const s1 = Math.min(s0 + N, iEnd);
    const start = p.base + s0 / p.sr;
    if (start >= p.horizon) break;
    if (start >= p.minWhen - 1e-9) {
      plan.push({ k, i0: s0, i1: s1, when: start, fade: false });
      continue;
    }
    // already started: join it at the first sample not before minWhen
    const i0 = Math.max(s0, Math.ceil((p.minWhen - p.base) * p.sr - 1e-6));
    if (s1 - i0 < p.sr * 0.02) continue; // less than 20 ms left: skip it
    plan.push({ k, i0, i1: s1, when: p.base + i0 / p.sr, fade: true });
  }
  return { next: k, plan };
}

/** Samples i0..i1 of the take as float audio at the context's rate (linear interpolation; the
 *  sample after i1 is read so that consecutive segments join without a step), with a short
 *  fade-in when asked. */
export function renderSegment(pcm: Int16Array, sr: number, i0: number, i1: number, outRate: number, fade: boolean): Float32Array<ArrayBuffer> {
  const ratio = outRate / sr;
  const m = Math.max(1, Math.round((i1 - i0) * ratio));
  const out = new Float32Array(m);
  const step = 1 / ratio;
  for (let j = 0; j < m; j++) {
    const x = i0 + j * step;
    const a = Math.floor(x);
    const f = x - a;
    const v0 = a < pcm.length ? pcm[a] : 0;
    const v1 = a + 1 < pcm.length ? pcm[a + 1] : 0;
    out[j] = (v0 + (v1 - v0) * f) / 32768;
  }
  if (fade) {
    const n = Math.min(m, Math.round(JOIN_FADE_S * outRate));
    for (let j = 0; j < n; j++) out[j] *= j / n;
  }
  return out;
}

// ---------- WAV ----------

/** What the `pupi` chunk of an exported WAV holds: enough to put the take back in its place. */
export interface WavTag {
  v: 1;
  app: 'pupitre';
  workId: string;
  mvId: string;
  startSt: number;
  rate: number;
  sr: number;
  at: number;
  part?: string;
}

/** 16-bit mono PCM WAV with a `pupi` chunk (JSON) holding the take's place in the score. */
export function encodeWav(take: Take, tag: Omit<WavTag, 'v' | 'app' | 'startSt' | 'rate' | 'sr' | 'at' | 'part'>): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({ v: 1, app: 'pupitre', ...tag, startSt: take.startSt, rate: take.rate, sr: take.sr, at: take.at, part: take.part } satisfies WavTag),
  );
  const tagLen = json.length + (json.length & 1); // chunks are padded to an even length
  const dataLen = take.pcm.length * 2;
  const size = 12 + 8 + 16 + 8 + tagLen + 8 + dataLen;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let o = 0;
  const str = (s: string) => {
    for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
    o += 4;
  };
  const u32 = (v: number) => {
    dv.setUint32(o, v, true);
    o += 4;
  };
  const u16 = (v: number) => {
    dv.setUint16(o, v, true);
    o += 2;
  };
  str('RIFF');
  u32(size - 8);
  str('WAVE');
  str('fmt ');
  u32(16);
  u16(1); // PCM
  u16(1); // mono
  u32(take.sr);
  u32(take.sr * 2);
  u16(2);
  u16(16);
  str('pupi');
  u32(json.length);
  buf.set(json, o);
  o += tagLen;
  str('data');
  u32(dataLen);
  for (let i = 0; i < take.pcm.length; i++, o += 2) dv.setInt16(o, take.pcm[i], true);
  return buf;
}

export interface ParsedWav {
  sr: number;
  channels: number;
  bits: number;
  format: number;
  data: Uint8Array; // the data chunk
  tag: WavTag | null;
}

/** Reads a WAV's chunks (null if it is not a RIFF/WAVE file). */
export function parseWav(bytes: ArrayBuffer | Uint8Array): ParsedWav | null {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u.length < 12) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const id = (o: number) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (id(0) !== 'RIFF' || id(8) !== 'WAVE') return null;
  let o = 12;
  let fmt: Omit<ParsedWav, 'data' | 'tag'> | null = null;
  let data: Uint8Array | null = null;
  let tag: WavTag | null = null;
  while (o + 8 <= u.length) {
    const cid = id(o);
    const len = dv.getUint32(o + 4, true);
    const body = o + 8;
    const end = Math.min(u.length, body + len);
    if (cid === 'fmt ' && len >= 16) {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (cid === 'data') {
      data = u.subarray(body, end);
    } else if (cid === 'pupi') {
      try {
        const t = JSON.parse(new TextDecoder().decode(u.subarray(body, end))) as WavTag;
        if (t && t.app === 'pupitre' && t.v === 1) tag = t;
      } catch {
        /* a damaged tag: an ordinary audio file */
      }
    }
    o = body + len + (len & 1);
  }
  if (!fmt || !data) return null;
  return { ...fmt, data, tag };
}

/** A WAV written by encodeWav() (16-bit mono PCM with our tag): the take exactly as it was;
 *  null for any other file (decoded by the browser instead). */
export function takeFromWav(bytes: ArrayBuffer | Uint8Array): { take: Take; tag: WavTag } | null {
  const w = parseWav(bytes);
  if (!w || !w.tag || w.format !== 1 || w.channels !== 1 || w.bits !== 16 || w.sr !== w.tag.sr) return null;
  const n = Math.floor(w.data.length / 2);
  const dv = new DataView(w.data.buffer, w.data.byteOffset, n * 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(i * 2, true);
  const t = w.tag;
  return {
    take: { v: 1, sr: w.sr, startSt: Number(t.startSt) || 0, rate: Number(t.rate) || 1, at: Number(t.at) || Date.now(), durMs: (n / w.sr) * 1000, part: t.part, pcm },
    tag: t,
  };
}

/** Float audio (any rate, already mono, already resampled to `sr`) to a take starting at
 *  `startSt`, recorded at `rate`, cut at `maxMs` (real ms). */
export function takeFromFloat(data: Float32Array, sr: number, startSt: number, rate: number, maxMs: number, at = Date.now()): Take {
  const n = Math.min(data.length, Math.floor((maxMs / 1000) * sr));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = toInt16(data[i]);
  return { v: 1, sr, startSt, rate, at, durMs: (n / sr) * 1000, pcm };
}

/** A file name without the characters file systems refuse. */
export function safeFileName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}
