// Playback engine: one clock (AudioContext.currentTime), one channel per part (volume, mute,
// solo, instrument, pan), tempo. Score time = ms at 100 % tempo.

import { makeSources, type InstId, type Source, type StopNote } from './instruments';
import { MetronomeVoice, type Click } from './metronome';
import { planNotes, takesOver, type EngineNote, type PlannedNote, type Sounding as Planned } from './plan';
import { planTake, renderSegment, sameRate, type Anchor as TakeAnchor } from './take';
import { holdAt } from './sfont';
import { lowerBound } from '../util/search';

export type { EngineNote } from './plan';

export interface ChannelState {
  vol: number; // 0..1
  mute: boolean;
  solo: boolean;
  /** "Soutien": each note sounds only during its second half (sing first, then check). */
  support?: boolean;
}

/** The user's recorded voice, as the engine plays it: sample i at score time
 *  startSt + i / sr * 1000 * rate (startSt with the manual offset already applied). */
export interface TakeTrack {
  pcm: Int16Array;
  sr: number;
  startSt: number;
  rate: number;
}

export interface PlayOptions {
  onEnd?: () => void;
  /** Hear only this part (at this volume) until score time `until`, then the normal mix. */
  focus?: { part: string; vol: number; until: number };
}

interface Anchor {
  ctx: number; // seconds (AudioContext time)
  st: number; // score ms
  rate: number; // tempo from there on
}

/** A note handed to the audio clock (what restart() needs to join it, and how to stop it). */
interface Sounding extends Planned {
  elapsed: number;
  stop: StopNote;
}

// Notes are handed to the audio clock up to 1 s ahead: a busy or throttled page (phones) can then
// skip several timer ticks without losing a note. Mix changes act on gains, so they stay immediate.
const LOOKAHEAD = 1.0;
// a hidden page gets one timer tick per second at most: plan further ahead so no note is lost
const LOOKAHEAD_HIDDEN = 3.0;
const TICK_MS = 40;
// a start asked for (play, a click on the score): headroom so the first notes are not cut
const START_MARGIN = 0.12;
// a note's release when the next note of its part starts (time constant, s): a quick legato
const HANDOVER_TAU = 0.012;
// the piano: a key struck again damps what was still ringing of the same note (time constant, s)
const RESTRIKE_TAU = 0.03;
// an internal restart (speed, Soutien) joins the notes in progress: the new plan starts as soon as
// the audio thread can receive it (one render callback: baseLatency, 23 ms in desktop Chromium)
const JOIN_MARGIN = 0.03;
// a part changing instrument waits this long at most for the new one's rendering
const SWITCH_WAIT_MS = 4000;
// with nothing to play and no held note for this long, the audio context is suspended (no audio
// thread running: battery); resume() wakes it, within the user's gesture, before any sound
const IDLE_MS = 60_000;
// the decoded recordings of an instrument no part uses any more are released after this long
const UNUSED_MS = 60_000;

export class Engine {
  ctx: AudioContext;
  private master: GainNode;
  private out: GainNode; // the general volume (computers), after the compressor: the mix is the same at any volume
  private fxBus: GainNode;
  private channels = new Map<string, { gain: GainNode; pan: StereoPannerNode; inst: InstId; next?: InstId }>();
  /** Pitches kept rendered per instrument since the movement was set (a part switched back and
   *  forth between instruments finds its pitches still rendered). */
  private kept = new Map<InstId, Set<number>>();
  private state = new Map<string, ChannelState>();
  readonly sources: Record<InstId, Source>;
  private notes: EngineNote[] = [];
  private duration = 0;
  rate = 1;
  private anchors: Anchor[] = [];
  private nextIdx = 0;
  private timer: number | null = null;
  private playing = false;
  private opts: PlayOptions = {};
  private stoppers: Sounding[] = [];
  private endAt: number | null = null;
  private endTimer = 0;
  private parkedAt = 0;
  // metronome: clicks of the movement (null = off), next one to schedule, those already scheduled
  private clicks: Click[] | null = null;
  private nextClick = 0;
  private clickNodes: { when: number; src: AudioBufferSourceNode }[] = [];
  private metro: MetronomeVoice;
  private metroBus: GainNode;
  // the recorded voice (null = none, or not to be heard): segments made just before they are due,
  // through a gate (one per stretch of playback: faded out at a stop or a jump) into its bus
  private take: TakeTrack | null = null;
  private takeNext = 0;
  private takeNodes: { when: number; end: number; src: AudioBufferSourceNode }[] = [];
  private takeGate: GainNode | null = null;
  private takeBus: GainNode;
  /** Called when the system took the audio away while playing (call, other app, iOS
   *  "interrupted"): playback has stopped where it was. */
  onInterrupt?: () => void;
  private holds = 0; // notes held (press and hold) right now
  private idleTimer = 0;
  private sleeping = false; // suspended by us (idle), not by the system
  private unusedSince = new Map<InstId, number>();
  private unusedTimer = 0;

  constructor(baseUrl: string) {
    // iOS (Safari 16.4+): the page plays like a music app: heard with the silent switch on, and
    // the same session as the media element that receives the headset's buttons (mediaKeys.ts).
    // Without it, the Web Audio was "ambient": muted by the switch (users heard nothing).
    try {
      const s = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (s) s.type = 'playback';
    } catch {
      /* not supported */
    }
    // 'playback': larger audio buffers, no crackles on phones (the cursor compensates the latency)
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    comp.knee.value = 8;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.out = this.ctx.createGain();
    this.master.connect(comp).connect(this.out).connect(this.ctx.destination);
    // no room reverberation (a convolver): the sound stays dry, the cheapest on a phone's CPU
    this.ctx.addEventListener('statechange', () => this.stateChanged());
    this.fxBus = this.ctx.createGain();
    this.fxBus.connect(this.master);
    this.sources = makeSources(this.ctx, baseUrl);
    this.metro = new MetronomeVoice(this.ctx);
    this.metroBus = this.ctx.createGain();
    this.metroBus.connect(this.master);
    this.takeBus = this.ctx.createGain();
    this.takeBus.connect(this.master);
    document.addEventListener('visibilitychange', () => {
      this.lookahead = document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;
      if (this.playing) this.tick();
    });
  }
  private lookahead = typeof document !== 'undefined' && document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;

  /** The general volume (a gain, 0..1). `atOnce`: before any sound; otherwise it glides there. */
  setVolume(gain: number, atOnce = false) {
    if (atOnce) this.out.gain.value = gain;
    else this.out.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** Metronome on (the movement's clicks) or off (null); takes effect at once while playing. */
  setClicks(clicks: Click[] | null) {
    const now = this.ctx.currentTime;
    // clicks planned but not heard yet belong to the old setting
    for (const c of this.clickNodes) if (c.when > now) c.src.stop();
    this.clickNodes = clicks ? this.clickNodes.filter((c) => c.when <= now) : [];
    this.clicks = clicks;
    if (clicks && this.playing) this.nextClick = lowerBound(clicks, this.position(false), byClick);
  }

  /** The recorded voice to play with the music (null: none); takes effect at once while playing. */
  setTake(take: TakeTrack | null) {
    if (take === this.take) return;
    this.take = take;
    if (!this.playing) return;
    const at = this.ctx.currentTime + 0.01;
    this.cutTake(at);
    this.tick();
  }

  /** Volume of the recorded voice (0..1, heard as its square like the parts). */
  setTakeVolume(v: number) {
    const g = this.takeBus.gain;
    holdAt(g, this.ctx.currentTime);
    g.setTargetAtTime(v * v, this.ctx.currentTime, 0.02);
  }

  /** The current playback anchor (the audio time a score time is played at, and the speed);
   *  null when not playing. A recording places its samples with it. */
  anchor(): TakeAnchor | null {
    const a = this.anchors[this.anchors.length - 1];
    return this.playing && a ? { ...a } : null;
  }

  /** Stops the take's segments from `at` on (faded out), and starts a new stretch after it. */
  private cutTake(at: number) {
    const g = this.takeGate;
    this.takeGate = null;
    if (g) {
      holdAt(g.gain, this.ctx.currentTime);
      g.gain.setTargetAtTime(0, Math.max(at, this.ctx.currentTime), 0.004);
      window.setTimeout(() => g.disconnect(), Math.max(0, (at - this.ctx.currentTime) * 1000) + 200);
    }
    for (const n of this.takeNodes) {
      if (n.when >= at) n.src.stop();
      else if (n.end > at) n.src.stop(at + 0.04);
    }
    this.takeNodes = [];
    this.takeNext = 0;
  }

  /** The take's segments due before the horizon (see planTake). Silent at another speed than the
   *  one it was recorded at. */
  private tickTake(a: Anchor, now: number, upto: number) {
    const t = this.take;
    if (!t || !sameRate(t.rate, this.rate)) return;
    this.takeNodes = this.takeNodes.filter((n) => n.end > now);
    const base = a.ctx + (t.startSt - a.st) / 1000 / this.rate;
    const { next, plan } = planTake({
      len: t.pcm.length,
      sr: t.sr,
      base,
      minWhen: Math.max(a.ctx, now + 0.005),
      horizon: a.ctx + (upto - a.st) / 1000 / this.rate,
      endCtx: a.ctx + (this.duration - a.st) / 1000 / this.rate,
      from: this.takeNext,
    });
    this.takeNext = next;
    if (!plan.length) return;
    if (!this.takeGate) {
      this.takeGate = this.ctx.createGain();
      this.takeGate.connect(this.takeBus);
    }
    const rate = this.ctx.sampleRate;
    for (const s of plan) {
      const data = renderSegment(t.pcm, t.sr, s.i0, s.i1, rate, s.fade);
      const buf = this.ctx.createBuffer(1, data.length, rate);
      buf.copyToChannel(data, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.takeGate);
      src.start(s.when);
      this.takeNodes.push({ when: s.when, end: s.when + data.length / rate, src });
    }
  }

  /** The pitches (with names and parts, for the note-naming voice) each instrument plays in this
   *  movement; the followed part first. */
  private needs(first?: string) {
    // one pass over the notes, grouped by part; the followed part comes first (its pitches are
    // rendered first, also when it shares its instrument with other parts)
    const byPart = new Map<string, EngineNote[]>();
    for (const n of this.notes) {
      let l = byPart.get(n.part);
      if (!l) byPart.set(n.part, (l = []));
      l.push(n);
    }
    const ids = [...this.channels.keys()].sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
    const by = new Map<InstId, Needs>();
    for (const id of ids) {
      const ch = this.channels.get(id)!;
      // the instrument playing now and, during a change, the one coming (both must stay ready)
      for (const inst of ch.next && ch.next !== ch.inst ? [ch.inst, ch.next] : [ch.inst]) {
        let list = by.get(inst);
        if (!list) by.set(inst, (list = { midis: [], names: [], parts: [] }));
        for (const n of byPart.get(id) ?? []) {
          list.midis.push(Math.round(n.midi));
          list.names.push(n.sp);
          list.parts.push(n.part);
        }
      }
    }
    return by;
  }

  /** Render, ahead of playback, the pitches each part will need (most urgent: the followed part),
   *  and release those no part needs any more. */
  private prepareAll(first?: string) {
    this.kept.clear(); // a new movement: only its pitches
    const by = this.needs(first);
    for (const [inst, l] of by) void this.sources[inst].prepare?.(l.midis, l.names, l.parts);
    this.retain(by);
  }

  /** Memory: each instrument keeps only the pitches of the current movement on the instruments
   *  chosen now (a note still sounding keeps its own buffer); the recordings of an instrument no
   *  part uses are released after UNUSED_MS (reloaded, from the cache, if it is chosen again). */
  private retain(by: Map<InstId, Needs>, add = false) {
    // the note-naming voice holds each pitch with the choir "ah": those pitches stay too
    const sol = by.get('solfege');
    const aahs = sol ? [...(by.get('aahs')?.midis ?? []), ...sol.midis] : by.get('aahs')?.midis;
    const used = new Set<InstId>([...this.channels.values()].flatMap((c) => (c.next ? [c.inst, c.next] : [c.inst])));
    if (used.has('solfege')) used.add('aahs');
    const now = performance.now();
    for (const id of Object.keys(this.sources) as InstId[]) {
      const l = by.get(id);
      let midis = id === 'aahs' ? (aahs ?? []) : (l?.midis ?? []);
      // `add` (a part changing instrument within the movement): what was kept stays kept, so
      // switching voices back and forth never drops and renders the same pitches again
      let k = this.kept.get(id);
      if (!add || !k) this.kept.set(id, (k = new Set()));
      for (const m of midis) k.add(m);
      if (add && id !== 'solfege') midis = [...k]; // (the note-naming voice keys its renders by name too)
      this.sources[id].retain?.(midis, l?.names, l?.parts);
      if (used.has(id)) this.unusedSince.delete(id);
      else if (!this.unusedSince.has(id)) this.unusedSince.set(id, now);
    }
    this.scheduleUnload();
  }

  private scheduleUnload() {
    window.clearTimeout(this.unusedTimer);
    this.unusedTimer = 0;
    if (!this.unusedSince.size) return;
    const first = Math.min(...this.unusedSince.values());
    this.unusedTimer = window.setTimeout(() => {
      const now = performance.now();
      for (const [id, since] of this.unusedSince) {
        if (now - since < UNUSED_MS - 10) continue;
        // still rendering: tried again a little later
        if (this.sources[id].unload?.() === false) this.unusedSince.set(id, now - UNUSED_MS + 5000);
        else this.unusedSince.delete(id);
      }
      this.scheduleUnload();
    }, Math.max(0, first + UNUSED_MS - performance.now()));
  }

  /** Wakes the audio context (also after its idle sleep). Called synchronously within the user's
   *  gesture (autoplay rules: ctx.resume() must be called inside the gesture handler). */
  async resume() {
    this.busy();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.ctx.state === 'running') this.sleeping = false;
    this.idleSoon(); // nothing started after all: asleep again later
  }

  /** Internal starts (next movement, loop): wake the context if it sleeps (normally it does not,
   *  the music stopped a moment ago). */
  private wake() {
    this.busy();
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  private busy() {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = 0;
  }

  private idleSoon() {
    this.busy();
    if (this.playing || this.holds) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = 0;
      if (this.playing || this.holds || this.ctx.state !== 'running') return;
      this.sleeping = true;
      void this.ctx.suspend().catch(() => {});
    }, IDLE_MS);
  }

  /** The context left 'running' while playing, and not because of our own idle sleep: the system
   *  took the audio (a call, another app, iOS "interrupted"). Stop cleanly where we are; ▶ resumes. */
  private stateChanged() {
    if (this.ctx.state === 'running') {
      this.sleeping = false;
      return;
    }
    if (this.sleeping || !this.playing) return;
    this.stop();
    this.onInterrupt?.();
  }

  /** Output latency (s), so that the visual cursor follows what is heard. */
  get outputLatency() {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    // some browsers (Android) do not report the output latency: assume a typical 40 ms
    const out = c.outputLatency && c.outputLatency > 0 ? c.outputLatency : 0.04;
    return out + (c.baseLatency || 0);
  }

  setScore(notes: EngineNote[], parts: { id: string; inst: InstId; pan: number }[], durationMs: number, focusPart?: string) {
    this.stop();
    this.notes = [...notes].sort((a, b) => a.t - b.t);
    this.duration = durationMs;
    this.parkedAt = 0;
    for (const ch of this.channels.values()) ch.pan.disconnect();
    this.channels.clear();
    for (const p of parts) {
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = p.pan;
      gain.connect(pan);
      pan.connect(this.master);
      this.channels.set(p.id, { gain, pan, inst: p.inst });
      void this.sources[p.inst].load().catch(() => {});
      if (!this.state.has(p.id)) this.state.set(p.id, { vol: 0.8, mute: false, solo: false });
    }
    this.applyMix();
    this.prepareAll(focusPart);
  }

  /** Change a part's instrument. Its notes go on with the old instrument until the new one has
   *  rendered this part's pitches (at most SWITCH_WAIT_MS): a note played before its rendering
   *  would use the raw recording, whose loop clicks (heard when changing the followed voice while
   *  playing). Notes already sounding finish with the old one. */
  setInstrument(part: string, inst: InstId) {
    const ch = this.channels.get(part);
    if (!ch) return;
    if (ch.inst === inst) {
      ch.next = undefined; // switched back before the change was done
      return;
    }
    if (ch.next === inst) return;
    ch.next = inst;
    const src = this.sources[inst];
    void src.load().catch(() => {});
    this.retain(this.needs(), true); // the new pitches are wanted from now on (nothing dropped)
    const mine = this.notes.filter((n) => n.part === part);
    const ready = src.prepare?.(
      mine.map((n) => Math.round(n.midi)),
      mine.map((n) => n.sp),
      mine.map((n) => n.part),
    ) ?? Promise.resolve();
    const done = () => {
      if (ch.next !== inst || this.channels.get(part) !== ch) return; // changed again meanwhile
      ch.inst = inst;
      ch.next = undefined;
      this.retain(this.needs(), true);
    };
    void Promise.race([ready.catch(() => {}), new Promise((r) => window.setTimeout(r, SWITCH_WAIT_MS))]).then(done);
  }

  setMix(mix: Record<string, ChannelState>) {
    let supportChanged = false;
    for (const [k, v] of Object.entries(mix)) {
      if (!!this.state.get(k)?.support !== !!v.support) supportChanged = true;
      this.state.set(k, { ...v });
    }
    this.applyMix();
    // notes already handed to the audio clock were planned with the old setting: replan them
    if (supportChanged) this.restart();
  }

  /** While playing: plan everything again (new speed, Soutien changed), same options, without a
   *  break: the new plan starts JOIN_MARGIN from now where the music is then; the notes sounding
   *  at that moment fade out as their new copies fade in, from the point already heard (no new
   *  attack); notes already in their release end by themselves. */
  private restart(rate = this.rate) {
    if (!this.playing) {
      this.rate = rate;
      return;
    }
    const start = this.ctx.currentTime + JOIN_MARGIN;
    const prev = this.anchors[this.anchors.length - 1];
    const st = this.scoreAt(start);
    const joined = new Map<EngineNote, number>();
    const keep: Sounding[] = [];
    for (const s of this.stoppers) {
      if (s.when + s.dur <= start) {
        keep.push(s); // already releasing
        continue;
      }
      if (s.when <= start) joined.set(s.n, s.elapsed + (start - s.when));
      s.stop(start);
    }
    this.stoppers = keep;
    for (const c of this.clickNodes) if (c.when >= start) c.src.stop();
    this.clickNodes = this.clickNodes.filter((c) => c.when < start);
    this.cutTake(start);
    if (this.timer !== null) window.clearInterval(this.timer);
    window.clearTimeout(this.endTimer);
    this.endTimer = 0;
    this.endAt = null;
    this.rate = rate;
    // the previous anchor stays for the cursor until `start` (position() of what is heard)
    this.anchors = [prev, { ctx: start, st, rate }];
    this.nextIdx = this.startIndex(st);
    if (this.clicks) this.nextClick = lowerBound(this.clicks, st, byClick);
    const focus = this.opts.focus;
    if (focus) {
      if (st < focus.until) this.applyFocus(focus, start, st);
      else this.opts = { ...this.opts, focus: undefined }; // already back to the normal mix
    }
    this.tick(joined);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private mixGain(id: string): number {
    const anySolo = [...this.state.entries()].some(([k, s]) => s.solo && this.channels.has(k));
    const s = this.state.get(id) ?? { vol: 0.8, mute: false, solo: false };
    const audible = anySolo ? s.solo && !s.mute : !s.mute;
    return audible ? s.vol * s.vol : 0;
  }

  private applyMix() {
    const now = this.ctx.currentTime;
    for (const [id, ch] of this.channels) {
      holdAt(ch.gain.gain, now); // from the level heard now, even in the middle of a change
      ch.gain.gain.setTargetAtTime(this.mixGain(id), now, 0.02);
    }
  }

  /** Followed part alone until a given time, then the normal mix (scheduled on the audio clock). */
  private applyFocus(focus: NonNullable<PlayOptions['focus']>, start: number, fromSt: number) {
    const now = this.ctx.currentTime;
    const switchAt = start + Math.max(0, focus.until - fromSt) / 1000 / this.rate;
    for (const [id, ch] of this.channels) {
      const g = ch.gain.gain;
      holdAt(g, now);
      g.setTargetAtTime(id === focus.part ? focus.vol * focus.vol : 0, now, 0.01);
      g.setTargetAtTime(this.mixGain(id), switchAt, 0.03);
    }
  }

  get isPlaying() {
    return this.playing;
  }

  /** Current score time (ms) of what is being HEARD now. */
  position(heard = true): number {
    if (!this.anchors.length) return this.parkedAt;
    return this.scoreAt(this.ctx.currentTime - (heard ? this.outputLatency : 0));
  }

  /** Score time (ms) played at audio time t (before the first anchor: its score time). */
  private scoreAt(t: number): number {
    const as = this.anchors;
    let k = as.length - 1;
    while (k > 0 && t < as[k].ctx) k--;
    const a = as[k];
    if (t < a.ctx) return a.st;
    return a.st + (t - a.ctx) * 1000 * a.rate;
  }

  /** New speed; while playing, the music goes on at once at the new speed (see restart()). */
  setRate(r: number) {
    this.restart(r);
  }

  play(fromSt: number, opts: PlayOptions = {}) {
    this.stop();
    this.wake();
    this.opts = opts;
    fromSt = Math.max(0, fromSt);
    this.readyFrom(fromSt);
    const start = this.ctx.currentTime + START_MARGIN;
    this.anchors = [{ ctx: start, st: fromSt, rate: this.rate }];
    if (opts.focus) this.applyFocus(opts.focus, start, fromSt);
    this.nextIdx = this.startIndex(fromSt);
    if (this.clicks) this.nextClick = lowerBound(this.clicks, fromSt - 1, byClick);
    this.playing = true;
    this.endAt = null;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  /** The pitches of the first notes (the first plan, a little more) rendered before the start, so
   *  that none of them is rendered late, on the spot (normally all are prepared already). */
  private readyFrom(st: number) {
    const upto = st + (this.lookahead + 0.5) * 1000 * this.rate;
    const byInst = new Map<InstId, number[]>();
    for (let i = this.startIndex(st); i < this.notes.length && this.notes[i].t < upto; i++) {
      const n = this.notes[i];
      const ch = this.channels.get(n.part);
      if (!ch || n.t + n.d <= st) continue;
      const list = byInst.get(ch.inst) ?? [];
      list.push(n.midi);
      byInst.set(ch.inst, list);
    }
    for (const [inst, ms] of byInst) this.source(inst).ready?.(ms);
  }

  /** First note to schedule from st: includes earlier notes still sounding (ties, held chords). */
  private startIndex(st: number) {
    let i = lowerBound(this.notes, st, byNote);
    while (i > 0 && this.notes[i - 1].t > st - 12000) i--;
    return i; // notes already over are skipped by planNotes()
  }

  private tick(joined?: ReadonlyMap<EngineNote, number>) {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.stoppers = this.stoppers.filter((s) => s.end > now);
    const a = this.anchors[this.anchors.length - 1];
    const stHorizon = a.st + (now + this.lookahead - a.ctx) * 1000 * this.rate;
    const end = this.duration;
    const upto = Math.min(stHorizon, end);
    const { next, plan } = planNotes({
      notes: this.notes,
      from: this.nextIdx,
      anchor: a,
      rate: this.rate,
      now,
      upto,
      end,
      support: (part) => !!this.state.get(part)?.support,
      focus: this.opts.focus,
      joined,
    });
    this.nextIdx = next;
    for (const p of plan) this.scheduleNote(p);
    if (this.clicks) {
      this.clickNodes = this.clickNodes.filter((c) => c.when > now - 0.5);
      while (this.nextClick < this.clicks.length && this.clicks[this.nextClick].st < upto) {
        const c = this.clicks[this.nextClick++];
        const when = a.ctx + (c.st - a.st) / 1000 / this.rate;
        if (when < now + 0.005) continue; // missed: a late click is worse than none
        this.clickNodes.push({ when, src: this.metro.play(this.metroBus, c, when) });
      }
    }
    if (this.take) this.tickTake(a, now, upto);
    if (stHorizon >= end && this.endAt === null) {
      const endCtx = a.ctx + (end - a.st) / 1000 / this.rate;
      this.endAt = endCtx;
      const cb = this.opts.onEnd;
      // a wall-clock timer: if the audio clock stopped meanwhile (context suspended or
      // interrupted), the end has not been heard yet, so wait for it again
      const fire = () => {
        if (!this.playing || this.endAt !== endCtx) return;
        const left = endCtx - this.ctx.currentTime + this.outputLatency;
        if (left > 0.02) {
          this.endTimer = window.setTimeout(fire, left * 1000);
          return;
        }
        this.stop(false);
        this.parkedAt = end;
        cb?.();
      };
      this.endTimer = window.setTimeout(fire, Math.max(0, (endCtx - now + this.outputLatency) * 1000));
    }
  }

  private source(inst: InstId): Source {
    const s = this.sources[inst];
    return s.loaded ? s : this.sources.clarinet; // while samples load (synthesized: always ready)
  }

  private scheduleNote({ n, when, dur, elapsed }: PlannedNote) {
    const ch = this.channels.get(n.part);
    if (!ch) return;
    // the note this one takes over from fades out quickly (see takesOver): a legato between the
    // notes of a voice; on the piano, a key struck again (up to 46 sounds at once in the tremolos
    // of Taneyev II, 34 with this: less for the audio thread to mix; the pack now plays these
    // tremolos at half their written rate as well, pipeline/build_pack.py `_slow_tremolos`)
    const piano = ch.inst === 'piano';
    const tau = piano ? RESTRIKE_TAU : HANDOVER_TAU;
    for (const s of this.stoppers) {
      if (!takesOver(s, n, when, piano)) continue;
      // a key struck again while a longer note of it was held (two voices of the piano part on
      // one note): the key stays down as long as that note was written
      if (piano) dur = Math.max(dur, s.when + s.dur - when);
      s.stop(when, tau);
      s.end = Math.min(s.end, when + tau * 6); // gone by then: not faded a second time
    }
    const stop = this.source(ch.inst).play(ch.gain, n.midi, when, dur, 1, elapsed, n.sp, n.part);
    this.stoppers.push({ n, when, dur, elapsed, end: when + dur + 0.7, stop });
  }

  stop(keepPosition = true) {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    window.clearTimeout(this.endTimer);
    this.endTimer = 0;
    if (this.playing && keepPosition && this.anchors.length) this.parkedAt = Math.max(0, Math.min(this.position(true), this.duration));
    this.playing = false;
    this.anchors = [];
    for (const s of this.stoppers) s.stop();
    this.stoppers = [];
    const t = this.ctx.currentTime;
    for (const c of this.clickNodes) if (c.when > t) c.src.stop();
    this.clickNodes = [];
    this.cutTake(t);
    if (this.opts.focus) {
      this.opts = { ...this.opts, focus: undefined };
      this.applyMix();
    }
    this.idleSoon();
  }

  /** Sustained reference note (press-and-hold), outside the mix; returns its release. */
  holdNote(midi: number, inst: InstId, name?: string, part?: string): () => void {
    this.wake();
    this.holds++;
    const src = this.source(inst);
    void this.sources[inst].load().catch(() => {});
    const stop = src.play(this.fxBus, midi, this.ctx.currentTime + 0.01, 600, 0.9, 0, name, part);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      stop();
      this.holds--;
      this.idleSoon();
    };
  }
}

type Needs = { midis: number[]; names: (string | undefined)[]; parts: string[] };

const byNote = (n: EngineNote) => n.t;
const byClick = (c: Click) => c.st;
