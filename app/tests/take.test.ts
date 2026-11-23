import { describe, expect, it } from 'vitest';
import {
  encodeWav,
  JOIN_FADE_S,
  normalize,
  NORM_MAX_GAIN,
  parseWav,
  planTake,
  renderSegment,
  safeFileName,
  sameRate,
  SEGMENT_S,
  takeEndSt,
  takeFromFloat,
  takeFromWav,
  TakeBuilder,
  type Take,
} from '../src/audio/take';
import { pickMic } from '../src/audio/recorder';

const close = (a: number, b: number, d = 6) => expect(a).toBeCloseTo(b, d);
const ramp = (n: number, v = 0.25) => Float32Array.from({ length: n }, () => v);

describe('TakeBuilder: placing the microphone on the score', () => {
  // context at 48 kHz; the music starts at context time 1 s with score time 10 000 ms, at 100 %
  const anchor = { ctx: 1, st: 10_000, rate: 1 };

  it('drops what comes before the anchor (plus latency), halves the rate, starts at the anchor', () => {
    const b = new TakeBuilder(48000, anchor, 0.1, 60_000);
    // frames 0..48000+4800: all before the anchor + latency (1.1 s = frame 52800)
    b.push(0, ramp(52800));
    expect(b.length).toBe(0);
    b.push(52800, ramp(48000)); // one second, kept
    const t = b.finish(1e9, 1)!;
    expect(t.sr).toBe(24000);
    expect(t.pcm.length).toBe(24000);
    close(t.startSt, 10_000);
    close(t.durMs, 1000);
    expect(t.rate).toBe(1);
  });

  it('a batch across the start keeps only its part after it', () => {
    const b = new TakeBuilder(48000, anchor, 0.1, 60_000);
    b.push(52800 - 1000, ramp(3000));
    expect(b.length).toBe(1000); // 2000 frames kept, halved
  });

  it('averages pairs, across batch boundaries (odd lengths)', () => {
    const b = new TakeBuilder(48000, { ctx: 0, st: 0, rate: 1 }, 0, 60_000);
    b.push(0, Float32Array.from([0.5, 0.1, 0.2]));
    b.push(3, Float32Array.from([0.4, -1, -1]));
    // normalisation off for this check: the peak is already high
    const t = b.finish(1e9)!;
    expect(Array.from(t.pcm)).toEqual([Math.round(0.3 * 32767), Math.round(0.3 * 32767), -32767]);
  });

  it('fills a gap in the frames with silence so that the timing holds', () => {
    const b = new TakeBuilder(48000, { ctx: 0, st: 0, rate: 1 }, 0, 60_000);
    b.push(0, ramp(100, 0.5));
    b.push(300, ramp(100, 0.5));
    const t = b.finish(1e9)!;
    expect(t.pcm.length).toBe(200);
    expect(t.pcm[60]).toBe(0);
    expect(t.pcm[150]).toBeGreaterThan(0);
  });

  it('a first batch arriving late is placed at its own frame (silence before it)', () => {
    const b = new TakeBuilder(48000, { ctx: 0, st: 0, rate: 1 }, 0, 60_000);
    b.push(4800, ramp(4800, 0.5));
    const t = b.finish(1e9)!;
    close(t.startSt, 0);
    expect(t.pcm.length).toBe(4800);
    expect(t.pcm[100]).toBe(0);
  });

  it('follows the tempo: at half speed, a second of singing covers 500 ms of score', () => {
    const b = new TakeBuilder(48000, { ctx: 0, st: 2000, rate: 0.5 }, 0, 60_000);
    b.push(0, ramp(48000));
    const t = b.finish(1e9)!;
    close(t.durMs, 1000);
    close(takeEndSt(t), 2500);
    close(b.scoreOfFrame(48000), 2500);
  });

  it('never goes past the end of the movement, and is cut where the music stopped', () => {
    const b = new TakeBuilder(48000, { ctx: 0, st: 0, rate: 1 }, 0, 1500);
    b.push(0, ramp(48000 * 3));
    expect(b.finish(1e9)!.durMs).toBeCloseTo(1500, 0);
    const c = new TakeBuilder(48000, { ctx: 0, st: 0, rate: 1 }, 0, 60_000);
    c.push(0, ramp(48000 * 3));
    expect(c.finish(1200)!.durMs).toBeCloseTo(1200, 0);
  });

  it('latency: a sample captured at T belongs to the music played at T − latency', () => {
    const b = new TakeBuilder(48000, { ctx: 2, st: 0, rate: 1 }, 0.25, 60_000);
    close(b.scoreOfFrame(48000 * 2.25), 0);
    close(b.scoreOfFrame(48000 * 3.25), 1000);
  });

  it('nothing kept: null', () => {
    const b = new TakeBuilder(48000, anchor, 0.1, 60_000);
    b.push(0, ramp(100));
    expect(b.finish(1e9)).toBeNull();
  });

  it('returns the RMS level of each batch (the meter)', () => {
    const b = new TakeBuilder(48000, { ctx: 0, st: 0, rate: 1 }, 0, 60_000);
    close(b.push(0, Float32Array.from([0.5, -0.5, 0.5, -0.5])), 0.5);
  });
});

describe('normalize: a quiet take brought to −3 dBFS, at most ×8, never quieter', () => {
  it('amplifies a quiet take to a peak of about −3 dBFS', () => {
    const p = Int16Array.from([1000, -5000, 500]);
    const g = normalize(p);
    close(g, (0.708 * 32767) / 5000, 3);
    expect(Math.abs(p[1])).toBeGreaterThan(23000);
    expect(Math.abs(p[1])).toBeLessThan(23300);
  });
  it('never more than ×8 (noise stays noise), never quieter, silence untouched', () => {
    const q = Int16Array.from([10, -20]);
    expect(normalize(q)).toBe(NORM_MAX_GAIN);
    expect(q[1]).toBe(-160);
    const loud = Int16Array.from([30000]);
    expect(normalize(loud)).toBe(1);
    expect(loud[0]).toBe(30000);
    expect(normalize(new Int16Array(5))).toBe(1);
  });
});

describe('planTake: segments on the audio clock', () => {
  const sr = 24000;
  const N = sr * SEGMENT_S;
  const base = { len: N * 3 + 1000, sr, base: 10, minWhen: 10, horizon: 11, endCtx: 1000, from: 0 };

  it('plans whole segments that start before the horizon, back to back', () => {
    const a = planTake({ ...base, horizon: 12.5 });
    expect(a.plan.map((s) => s.k)).toEqual([0, 1]);
    close(a.plan[1].when, 12);
    expect(a.plan[1].i0).toBe(N);
    expect(a.plan.every((s) => !s.fade)).toBe(true);
    const b = planTake({ ...base, horizon: 20, from: a.next });
    expect(b.plan.map((s) => s.k)).toEqual([2, 3]);
    expect(b.plan[1].i1).toBe(base.len);
  });

  it('a start in the middle of the take joins the segment at a sample, with a fade', () => {
    const p = planTake({ ...base, minWhen: 13.0001, horizon: 13.5 });
    expect(p.plan).toHaveLength(1);
    const s = p.plan[0];
    expect(s.k).toBe(1);
    expect(s.fade).toBe(true);
    expect(s.i0).toBe(N + Math.ceil(1.0001 * sr));
    close(s.when, 10 + s.i0 / sr);
    expect(s.when).toBeGreaterThanOrEqual(13.0001 - 1e-9);
  });

  it('the take starting later than the anchor waits for its place', () => {
    const p = planTake({ ...base, base: 15, minWhen: 10, horizon: 11 });
    expect(p.plan).toHaveLength(0);
    expect(p.next).toBe(0);
  });

  it('cuts at the end of the movement and skips a remainder of less than 20 ms', () => {
    const p = planTake({ ...base, endCtx: 11, horizon: 100 });
    expect(p.plan).toHaveLength(1);
    expect(p.plan[0].i1).toBe(sr); // one second
    const q = planTake({ ...base, minWhen: 11.995, horizon: 13 }); // 5 ms left in segment 0
    expect(q.plan.map((s) => s.k)).toEqual([1]);
  });
});

describe('renderSegment', () => {
  it('doubles the rate by linear interpolation, reading the next segment’s first sample', () => {
    const pcm = Int16Array.from([0, 16384, 32767, 0]);
    const out = renderSegment(pcm, 24000, 0, 2, 48000, false);
    expect(out.length).toBe(4);
    close(out[1], 8192 / 32768);
    close(out[3], (32767 + 16384) / 2 / 32768, 4); // between sample 1 and sample 2 (next segment)
  });
  it('fades in a joined segment', () => {
    const pcm = new Int16Array(24000).fill(16384);
    const out = renderSegment(pcm, 24000, 0, 24000, 48000, true);
    expect(out[0]).toBe(0);
    expect(out[Math.round(JOIN_FADE_S * 48000)]).toBeCloseTo(0.5, 5);
  });
});

describe('WAV with the pupi chunk', () => {
  const take: Take = { v: 1, sr: 24000, startSt: 12345.5, rate: 0.75, at: 1761500000000, durMs: 0, part: 'T', pcm: Int16Array.from([0, 1, -1, 32767, -32768, 123]) };

  it('round trip: the same samples and the same place in the score', () => {
    const bytes = encodeWav(take, { workId: 'taneyev', mvId: 'mvt2' });
    const back = takeFromWav(bytes)!;
    expect(Array.from(back.take.pcm)).toEqual(Array.from(take.pcm));
    expect(back.take).toMatchObject({ sr: 24000, startSt: 12345.5, rate: 0.75, at: 1761500000000, part: 'T' });
    expect(back.tag).toMatchObject({ workId: 'taneyev', mvId: 'mvt2' });
    close(back.take.durMs, (6 / 24000) * 1000);
  });

  it('is a plain 16-bit mono PCM WAV for other programs', () => {
    const w = parseWav(encodeWav(take, { workId: 'w', mvId: 'm' }))!;
    expect(w).toMatchObject({ format: 1, channels: 1, bits: 16, sr: 24000 });
    expect(w.data.length).toBe(12);
  });

  it('an odd-length tag is padded, the chunks still read', () => {
    const t = { ...take, part: 'TT' };
    for (const id of ['a', 'ab']) expect(takeFromWav(encodeWav(t, { workId: id, mvId: 'm' }))?.tag.workId).toBe(id);
  });

  it('a WAV without our chunk, or not a WAV, is left to the browser', () => {
    const bytes = encodeWav(take, { workId: 'w', mvId: 'm' });
    const s = new TextDecoder('latin1').decode(bytes);
    const i = s.indexOf('pupi');
    const other = bytes.slice();
    other.set([120, 120, 120, 120], i); // renamed chunk: unknown, skipped
    expect(parseWav(other)?.tag).toBeNull();
    expect(takeFromWav(other)).toBeNull();
    expect(takeFromWav(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('other helpers', () => {
  it('takeFromFloat cuts at the movement', () => {
    const t = takeFromFloat(new Float32Array(48000), 24000, 0, 1, 1000);
    expect(t.pcm.length).toBe(24000);
    expect(t.durMs).toBe(1000);
  });
  it('sameRate tolerates rounding only', () => {
    expect(sameRate(0.75, 0.7500001)).toBe(true);
    expect(sameRate(0.75, 0.8)).toBe(false);
  });
  it('safe file names', () => {
    expect(safeFileName('Pupitre – II. Andante: «x» / y?.wav')).toBe('Pupitre – II. Andante «x» y .wav');
  });
});

describe('pickMic: the device’s own microphone keeps a Bluetooth headset in high quality', () => {
  const dev = (deviceId: string, label: string) => ({ deviceId, label });
  it('Android: Speakerphone rather than the headset or Default', () => {
    const l = [dev('default', 'Default'), dev('bt', 'Bluetooth headset'), dev('ear', 'Headset earpiece'), dev('sp', 'Speakerphone'), dev('shokz', 'OpenRun Pro by Shokz')];
    expect(pickMic(l, '')).toBe('sp');
  });
  it('the chosen one while it is there, otherwise automatic', () => {
    const l = [dev('a', 'Microphone (Realtek)'), dev('b', 'USB mic')];
    expect(pickMic(l, 'b')).toBe('b');
    expect(pickMic(l, 'gone')).toBe('a');
  });
  it('no labels yet (first use) or only headsets: the system’s default', () => {
    expect(pickMic([dev('x', ''), dev('y', '')], '')).toBeUndefined();
    expect(pickMic([dev('bt', 'AirPods Pro'), dev('h', 'Hands-Free BT')], '')).toBeUndefined();
  });
  it('iPhone', () => {
    expect(pickMic([dev('bt', 'Shokz OpenRun'), dev('i', 'iPhone Microphone')], '')).toBe('i');
  });
});
