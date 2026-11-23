// Application state: one screen, a few signals.
import { computed, effect, signal, untracked } from '@preact/signals';
import { Engine, type ChannelState } from './audio/engine';
import type { InstId } from './audio/instruments';
import { clicksFor, type MetroSub } from './audio/metronome';
import { importWorkZip, loadLibrary, loadWork, removeWork, withWork, type WorkSummary } from './pack/library';
import type { LoadedPack, Movement, Part } from './pack/types';
import { measureIndexAt } from './ui/timing';
import { canHover, lowScreen, onHoverChange, onLayoutChange, onLowScreenChange, phoneLayout } from './ui/media';
import { RATE_MAX, RATE_MIN } from './score/info';
import { cacheEarlySamples } from './offline';
import { NS } from './site';

export const BASE = import.meta.env.BASE_URL;

/** One track of the mixer (persisted per part id: S, A, T, B, P…): the engine's channel settings
 *  (volume, mute, solo, Soutien) and the instrument. */
export interface Track extends ChannelState {
  inst: InstId;
}

interface Prefs {
  work: string | null;
  mv: string | null;
  part: string; // the followed voice (shown in the lane below the pages)
  tracks: Record<string, Track>;
  rate: number;
  laneSize: number; // 0 small, 1 medium, 2 large
  lyrics: string; // lyric line shown in the line: 'auto', a line id ('ru', 'tr'…) or 'all'
  sound?: number; // version of the sound defaults already applied
  endMode?: EndMode; // at the end of a movement: stop, play it again, or go on to the next
  metro?: boolean; // metronome on
  metroSub?: MetroSub; // what it clicks (default: the beats of the time signature)
  // « Enregistrer ma voix » (off by default: no microphone, no panel)
  recOn?: boolean;
  takeOn?: boolean; // the recorded voice is heard (default on)
  takeVol?: number; // its volume, 0..1
  recDevice?: string; // the chosen microphone's deviceId ('' = automatic)
  recOffset?: number; // manual offset of the recorded voice (ms, + = later), this device
  // wide screens (styles.css): the track list unfolded above the controls (unset: see tracksOpen)
  tracksPanel?: boolean;
  volume?: number; // computers: the general volume's slider, 0..1 (the gain is its square)
  sideView?: SideView; // a screen lying down: what is shown between the bars (unset: see sideView)
  firstShown?: string; // the work shown at the arrival that this device has already been shown (FIRST_WORK)
}
export type EndMode = 'stop' | 'loop' | 'next';
export type SideView = 'line' | 'page' | 'both';
const SIDE_VIEWS: readonly unknown[] = ['line', 'page', 'both'];
const DEFAULTS: Prefs = { work: null, mv: null, part: 'T', tracks: {}, rate: 1, laneSize: 1, lyrics: 'auto' };

/** Saved preferences (any version, possibly damaged) brought to the current shape. */
export function migratePrefs(raw: unknown): Prefs {
  const p: Prefs = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? (raw as Partial<Prefs>) : {}) };
  if (typeof p.tracks !== 'object' || !p.tracks) p.tracks = {};
  p.rate = Math.max(RATE_MIN, Math.min(RATE_MAX, Number(p.rate) || 1)); // the speed control's bounds
  p.laneSize = Math.max(0, Math.min(2, Number.isFinite(Number(p.laneSize)) ? Number(p.laneSize) : DEFAULTS.laneSize));
  // new sounds (10/2026): voices left on the old default "oohs" move to the new default choir
  if ((p.sound ?? 1) < 2) {
    for (const t of Object.values(p.tracks)) if ((t.inst as string) === 'oohs') t.inst = 'aahs';
    p.sound = 2;
  }
  // new balance (11/2026): volumes left at the old defaults (choir 0.75, piano 0.7) take the new ones
  if ((p.sound ?? 1) < 3) {
    for (const t of Object.values(p.tracks)) {
      if (t.inst === 'piano' && t.vol === 0.7) t.vol = VOL_ACCOMP;
      else if (t.inst !== 'clarinet' && t.inst !== 'piano' && t.vol === 0.75) t.vol = VOL_VOICE;
    }
    p.sound = 3;
  }
  // instruments removed (11/2026): voice "ou" → choir "ah"; flute and soft voice → clarinet
  if ((p.sound ?? 1) < 4) {
    for (const t of Object.values(p.tracks)) {
      const was = t.inst as string;
      if (was === 'oohs') t.inst = 'aahs';
      else if (was === 'flute' || was === 'synth') t.inst = 'clarinet';
    }
    p.sound = 4;
  }
  delete (p as Partial<Prefs> & { reverb?: unknown }).reverb; // the room acoustics were removed (10/2026)
  if (p.recOffset !== undefined) p.recOffset = clampOffset(p.recOffset);
  if (p.takeVol !== undefined) p.takeVol = Math.max(0, Math.min(1, Number.isFinite(Number(p.takeVol)) ? Number(p.takeVol) : 0.9));
  if (p.recDevice !== undefined && typeof p.recDevice !== 'string') delete p.recDevice;
  delete (p as Partial<Prefs> & { pitchOn?: unknown }).pitchOn; // « Justesse » was removed (11/2026)
  if (p.tracksPanel !== undefined && typeof p.tracksPanel !== 'boolean') delete p.tracksPanel;
  if (p.volume !== undefined) p.volume = Number.isFinite(Number(p.volume)) ? Math.max(0, Math.min(1, Number(p.volume))) : 1;
  if (p.sideView !== undefined && !SIDE_VIEWS.includes(p.sideView)) delete p.sideView;
  return p;
}
/** The recorded voice's manual offset: −800…+800 ms, by 10 ms (a Bluetooth headset's latency
 *  is not always reported, and can reach several hundred ms). */
export const OFFSET_MAX = 800;
export function clampOffset(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, Math.round(n / 10) * 10)) : 0;
}
function readPrefs(): Prefs {
  try {
    return migratePrefs(JSON.parse(localStorage.getItem(NS) ?? '{}'));
  } catch {
    return { ...DEFAULTS };
  }
}
export const prefs = signal<Prefs>(readPrefs());
export function setPrefs(p: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...p };
  schedulePersist();
}

// Preferences are written a moment after the last change (a volume slider fires dozens of
// changes a second: one synchronous localStorage write each was wasted work), and at once when
// the page is hidden or closed.
const PERSIST_MS = 250;
let persistTimer = 0;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(persistNow, PERSIST_MS) as unknown as number;
}
function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = 0;
  try {
    localStorage.setItem(NS, JSON.stringify(prefs.value));
  } catch {
    /* private mode */
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persistNow);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persistNow());
}

/** Default volumes (the slider's value; the gain is its square): the followed voice in front of
 *  the others (+3.6 dB over each of them, the choir and the piano 11/2026: before, +1.1 dB only, and
 *  the clarinet was heard through its brightness), the accompaniment a little below the choir. */
export const VOL_MINE = 0.8;
export const VOL_VOICE = 0.65;
export const VOL_ACCOMP = 0.6;

/** Defaults: the followed voice on clarinet (a clear, distinct line), the other voices on the
 *  choir "ah" lower, the accompaniment on piano. */
export function defaultTrack(part: Part): Track {
  if (part.kind === 'accomp') return { vol: VOL_ACCOMP, mute: false, solo: false, inst: 'piano' };
  return part.id === myPart.value ? { vol: VOL_MINE, mute: false, solo: false, inst: 'clarinet' } : { vol: VOL_VOICE, mute: false, solo: false, inst: 'aahs' };
}

export function trackOf(part: Part): Track {
  return { ...defaultTrack(part), ...prefs.value.tracks[part.id] };
}

export function setTrack(part: Part, patch: Partial<Track>) {
  // solo and mute exclude each other: turning one on turns the other off
  if (patch.solo) patch = { ...patch, mute: false, support: false };
  if (patch.mute) patch = { ...patch, solo: false, support: false };
  if (patch.support) patch = { ...patch, mute: false, solo: false };
  const next = { ...trackOf(part), ...patch };
  setPrefs({ tracks: { ...prefs.value.tracks, [part.id]: next } });
  if (patch.inst && eng) eng.setInstrument(part.id, patch.inst);
  applyMix();
}

/** Every listening setting back to its default (the followed voice, the work and the place stay):
 *  followed voice on clarinet, the others on "ah" lower, piano, the line at its middle size (as on
 *  a new device; the small one until 11/2026), the score's tempo. */
export function resetSettings() {
  if (prefs.value.rate !== DEFAULTS.rate) stopRecording();
  setPrefs({ tracks: {}, rate: DEFAULTS.rate, laneSize: DEFAULTS.laneSize, lyrics: DEFAULTS.lyrics });
  const mv = movement.value;
  if (eng && mv) {
    for (const p of mv.parts) eng.setInstrument(p.id, defaultTrack(p).inst);
    eng.setRate(DEFAULTS.rate);
  }
  applyMix();
}

/** Follow another part: a voice moves to the clarinet, the other voices to the choir "ah"
 *  (volumes, solo and mute are kept, except that the new followed part is brought up to its
 *  default level if it was lower, and the part left, if still at the followed voice's default
 *  level, goes back to the level of the others). The piano can be followed too: it keeps its piano. */
export function followPart(id: string) {
  const mv = movement.value;
  const before = mv?.parts.find((p) => p.id === myPart.value);
  const mode = before ? myModeOf(trackOf(before)) : 'on';
  setPrefs({ part: id });
  if (!mv) return;
  // "my voice" (heard / alone / support / muted) moves with the followed part; the previous one
  // goes back to normal
  const tracks = { ...prefs.value.tracks };
  for (const p of mv.parts) {
    const mine = p.id === myPart.value;
    const t = { ...trackOf(p) };
    if (p.kind === 'voice') {
      t.inst = mine ? 'clarinet' : 'aahs';
      eng?.setInstrument(p.id, t.inst);
    }
    // the new followed part is heard at least at the default level (it may have been turned down
    // in the mix while it was another part: following it must not leave it hard to hear)
    if (mine && p.id !== before?.id) t.vol = Math.max(t.vol, defaultTrack(p).vol);
    // the part left goes back into the mix, unless its level was chosen
    if (!mine && p.id === before?.id && t.vol === VOL_MINE) t.vol = defaultTrack(p).vol;
    if (mine) Object.assign(t, { mute: mode === 'mute', solo: mode === 'solo', support: mode === 'support' });
    else if (p.id === before?.id) Object.assign(t, { mute: false, solo: false, support: false });
    else t.support = false;
    tracks[p.id] = t;
  }
  setPrefs({ tracks });
  applyMix();
}

/** How my voice is heard: normally, alone (solo), only the second half of each note, or not. */
export type MyMode = 'on' | 'solo' | 'support' | 'mute';
export function myModeOf(t: Track): MyMode {
  return t.mute ? 'mute' : t.solo ? 'solo' : t.support ? 'support' : 'on';
}
export function setMyMode(part: Part, mode: MyMode) {
  const mv = movement.value;
  if (mode === 'solo' && mv) {
    // alone: no other voice stays soloed
    const tracks = { ...prefs.value.tracks };
    for (const p of mv.parts) if (p.id !== part.id && trackOf(p).solo) tracks[p.id] = { ...trackOf(p), solo: false };
    setPrefs({ tracks });
  }
  setTrack(part, { mute: mode === 'mute', solo: mode === 'solo', support: mode === 'support' });
}

/** Back to hearing everything (no solo, no mute); volumes and instruments are kept. */
export function unmuteAll() {
  const mv = movement.value;
  if (!mv) return;
  const tracks = { ...prefs.value.tracks };
  for (const p of mv.parts) tracks[p.id] = { ...trackOf(p), mute: false, solo: false, support: false };
  setPrefs({ tracks });
  applyMix();
}

/** The track list is open. Phones: it takes the line's place while open, and is closed at each
 *  launch. Wide screens: a panel unfolded above the controls, kept as the user left it; until
 *  they fold or unfold it, it is open where it stands beside the pages (tracksRoom). */
export const tracksOpen = signal(false);
let roomHeard = true;
function restoreTracks() {
  roomHeard = true;
  tracksOpen.value = !phoneLayout() && !!prefs.value.tracksPanel;
}
restoreTracks();
onLayoutChange(restoreTracks); // a window made narrow or wide again: each layout has its own state
export function setTracksOpen(open: boolean) {
  tracksOpen.value = open;
  if (!phoneLayout()) setPrefs({ tracksPanel: open });
}
/** Wide screens: whether the unfolded list stands beside the pages or over them (PageView knows).
 *  Heard while the screen settles (the pages' size follows the line's height, known a moment
 *  after the launch), until the first press or key: after that the list never folds or unfolds
 *  by itself (a larger line must not fold it under the pointer). */
export function tracksRoom(beside: boolean) {
  if (roomHeard && !phoneLayout() && prefs.value.tracksPanel === undefined) tracksOpen.value = beside;
}
if (typeof window !== 'undefined') for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => (roomHeard = false), true);

/** The general volume: computers only (a mouse or a trackpad). A phone or a tablet has its volume
 *  keys at hand: no control there, and nothing applied. */
export const hasVolume = signal(canHover());
const outGain = () => (hasVolume.value ? (prefs.value.volume ?? 1) ** 2 : 1);
export function setVolume(v: number) {
  setPrefs({ volume: Math.max(0, Math.min(1, v)) });
  eng?.setVolume(outGain());
}
// the mouse arrives or leaves (a tablet and its keyboard cover): the control comes or goes; the
// level follows the control when it arrives, and stays where it is when it leaves (never louder
// by itself in the middle of the music)
onHoverChange(() => {
  hasVolume.value = canHover();
  if (hasVolume.value) eng?.setVolume(outGain());
});

export const works = signal<WorkSummary[]>([]);
export const booted = signal(false);
export const work = signal<LoadedPack | null>(null);
export const error = signal<string | null>(null);

export const movement = computed<Movement | null>(() => {
  const w = work.value;
  if (!w) return null;
  return w.pack.movements.find((m) => m.id === prefs.value.mv) ?? w.pack.movements[0] ?? null;
});

/** Lyric verses shown in the line (null = all). By default the singable transliteration when there is one. */
export const lyricVerses = computed<number[] | null>(() => {
  const lines = movement.value?.lyricLines ?? [];
  if (lines.length < 2) return null;
  const want = prefs.value.lyrics;
  if (want === 'all') return null;
  const pick = lines.find((l) => l.id === want) ?? lines.find((l) => l.id === 'tr') ?? lines[lines.length - 1];
  return [pick.n];
});

/** The followed part in the current movement: a voice, or the piano. */
export const myPart = computed(() => {
  const mv = movement.value;
  const want = prefs.value.part;
  if (!mv) return want;
  const voices = mv.parts.filter((p) => p.kind === 'voice');
  // a work without that voice: the voice of the same family (S for S1), else the first voice;
  // a work without voices (instruments only): its first part
  return (mv.parts.find((p) => p.id === want) ?? voices.find((p) => p.id[0] === want[0]) ?? voices[0] ?? mv.parts[0])?.id ?? want;
});

/** The work's information sheet is open (over the pages). */
export const ficheOpen = signal(false);

/** A screen lying down (styles.css › phone turned sideways) shows the line of my voice alone, the
 *  printed page alone, or both side by side. The choice is made in the bottom bar and kept. Until
 *  then: the line on a phone, where each of the two would have half of a small screen; both on
 *  a small tablet, where half of the screen is as wide as a phone held upright or wider, and in
 *  a computer's low window (a mouse: as it was before there was a choice). */
const low = signal(lowScreen());
onLowScreenChange(() => (low.value = lowScreen()));
export const sideView = computed<SideView>(() => prefs.value.sideView ?? (low.value && !hasVolume.value ? 'line' : 'both'));
/** Shows that view. The work's sheet, which lies over the pages, is put away: the view chosen
 *  is the one seen. */
export function setSideView(v: SideView) {
  if (v !== sideView.value) setPrefs({ sideView: v });
  ficheOpen.value = false;
}

// ---------- playback ----------
// « Enregistrer ma voix » (rec.ts): anything that moves or stops the music first stops a recording
// in progress (what was recorded is kept). One hook, called from every such path below.
let stopRecordingHook: (() => void) | null = null;
export function onMove(fn: () => void) {
  stopRecordingHook = fn;
}
function stopRecording() {
  stopRecordingHook?.();
}
let engineHook: (() => void) | null = null;
/** Called once the engine exists (the recorded voice is handed to it then). */
export function onEngine(fn: () => void) {
  engineHook = fn;
  if (eng) fn();
}

let eng: Engine | null = null;
export function engine(): Engine {
  if (!eng) {
    const e = (eng = new Engine(BASE));
    // the system took the audio away (a call, another app): stopped where it was, ▶ resumes
    e.onInterrupt = () => {
      stopRecording();
      cancelNext();
      parked.value = e.position();
      playing.value = false;
    };
    e.setVolume(outGain(), true);
    configure();
    engineHook?.();
  }
  return eng;
}
export const hasEngine = () => !!eng;

export const playing = signal(false);
/** Parked position (ms) when not playing. */
export const parked = signal(0);

export function position(): number {
  return eng && eng.isPlaying ? eng.position() : parked.value;
}

let configured: Movement | null = null;
function configure() {
  const mv = movement.value;
  if (!eng || !mv) return;
  configured = mv;
  eng.setScore(
    mv.notes.map((n) => ({ t: n.t, d: n.d, midi: n.midi, part: n.part, sp: n.sp })),
    mv.parts.map((p) => ({ id: p.id, inst: trackOf(p).inst, pan: PAN[p.id[0]] ?? 0 })),
    mv.durationMs,
    myPart.value,
  );
  eng.rate = prefs.value.rate;
  applyMetro();
  applyMix();
}

function applyMetro() {
  const mv = movement.value;
  if (!eng || !mv) return;
  const p = prefs.value;
  eng.setClicks(p.metro ? clicksFor(mv.measures, mv.durationMs, p.metroSub ?? 'beat') : null);
}

/** Metronome on / off, and what it clicks; heard at once, the music goes on. */
export function setMetro(on: boolean) {
  setPrefs({ metro: on });
  applyMetro();
}
export function setMetroSub(sub: MetroSub) {
  setPrefs({ metroSub: sub, metro: true });
  applyMetro();
}
// a light stereo spread, as a choir stands: sopranos left, basses right
const PAN: Record<string, number> = { S: -0.3, A: -0.12, T: 0.12, B: 0.3 };

export function mixFor(mv: Movement, tracks: Record<string, Partial<Track>>): Record<string, ChannelState> {
  const out: Record<string, ChannelState> = {};
  for (const p of mv.parts) {
    const t = { ...defaultTrack(p), ...tracks[p.id] };
    // support is a way of hearing MY voice: never active on another one (no hidden state)
    out[p.id] = { vol: t.vol, mute: t.mute, solo: t.solo, support: !!t.support && p.id === myPart.value };
  }
  return out;
}

/** Parts actually heard with the current solo/mute settings. */
export function audibleParts(mv: Movement, tracks: Record<string, Partial<Track>>): string[] {
  const mix = mixFor(mv, tracks);
  const anySolo = Object.values(mix).some((c) => c.solo);
  return mv.parts.filter((p) => (anySolo ? mix[p.id].solo && !mix[p.id].mute : !mix[p.id].mute)).map((p) => p.id);
}

export function applyMix() {
  const mv = movement.value;
  if (!eng || !mv) return;
  eng.setMix(mixFor(mv, prefs.value.tracks));
}

/** Plays from `from` (default: where it is parked). A recording in progress stops first, unless
 *  this is the recording's own start (`recording`). */
/** Run at the very start of play(), still inside the user's gesture (iOS starts media only there). */
export const playStartHooks = new Set<() => void>();

export async function play(from?: number, recording = false) {
  for (const h of playStartHooks) h();
  if (!recording) stopRecording();
  cancelNext();
  const e = engine();
  const mv = movement.value;
  if (!mv) return;
  if (configured !== mv) configure();
  await e.resume();
  let st = from ?? parked.value;
  if (st >= mv.durationMs - 30) st = 0;
  e.play(st, { onEnd: movementEnded });
  playing.value = true;
}

/** The movement has played to its end: stop, play it again, or go on to the next one, after a
 *  short breath (cancelled by any action of the user meanwhile). */
const BREATH_MS = 1200;
let nextTimer = 0;
export const between = signal(false); // the pause between two movements (or two loops)
function cancelNext() {
  window.clearTimeout(nextTimer);
  nextTimer = 0;
  between.value = false;
}
function movementEnded() {
  stopRecording(); // a recording ends with its movement (« Boucle », « Enchaîner » go on without it)
  playing.value = false;
  parked.value = 0;
  const mode = prefs.value.endMode ?? 'stop';
  const w = work.value;
  const mv = movement.value;
  if (mode === 'stop' || !w || !mv) return;
  const list = w.pack.movements;
  const next = mode === 'loop' ? mv : list[list.findIndex((m) => m.id === mv.id) + 1];
  if (!next) return; // the last movement: the work is over
  between.value = true;
  nextTimer = window.setTimeout(() => {
    nextTimer = 0;
    between.value = false;
    if (next.id !== movement.value?.id) setPrefs({ mv: next.id });
    void play(0);
  }, BREATH_MS);
}

export function setEndMode(m: EndMode) {
  setPrefs({ endMode: m });
}

export function pause() {
  stopRecording();
  cancelNext();
  if (!eng) return;
  if (eng.isPlaying) {
    eng.stop();
    parked.value = eng.position();
  }
  playing.value = false;
}

export function toggle() {
  if (playing.value || between.value) pause();
  else void play();
}

/** Jump to a time; keeps playing if playing, otherwise starts (a click on the score means "from here"). */
export function startFrom(t: number) {
  parked.value = Math.max(0, t);
  void play(parked.value);
}

/** Hear again what was just sung: from the start of the previous measure up to here with the
 *  followed voice alone, then the music goes on with the normal track settings. */
export async function replayMine() {
  stopRecording();
  cancelNext();
  const mv = movement.value;
  if (!mv) return;
  const now = position();
  const i = measureIndexAt(mv, now);
  const from = mv.measures[Math.max(0, i - 1)].t;
  const until = Math.max(now, mv.measures[i].t);
  const e = engine();
  if (configured !== mv) configure();
  await e.resume();
  const part = mv.parts.find((p) => p.id === myPart.value);
  e.play(from, {
    focus: part ? { part: part.id, vol: Math.max(0.75, trackOf(part).vol), until } : undefined,
    onEnd: movementEnded,
  });
  playing.value = true;
}

export function seekParked(t: number) {
  if (playing.value) void play(t);
  else parked.value = Math.max(0, t);
}

/** Playback speed, as a ratio of the score's tempo (RATE_MIN 0.4 to RATE_MAX 2; the tempo control shows it as a
 *  metronome value). */
export function setRate(r: number) {
  r = Math.max(RATE_MIN, Math.min(RATE_MAX, Math.round(r * 10000) / 10000));
  if (r !== prefs.value.rate) stopRecording(); // a take keeps one tempo
  setPrefs({ rate: r });
  if (eng) eng.setRate(r);
}

// ---------- press-and-hold a note ----------
// `resume`/`at`: the music to start again on release (where it was at the first press: pressing
// another note while one is held changes the note, not the place to go back to)
interface Held {
  release: (() => void) | null; // null while the audio wakes
  resume: boolean;
  at: number;
}
let held: Held | null = null;
export const heldNote = signal<{ id: string; midi: number } | null>(null);

export async function holdNote(id: string, midi: number, sp?: string) {
  const prev = held;
  held = null;
  prev?.release?.(); // the previous note stops; the music stays paused
  const e = engine();
  const woke = e.resume(); // within the gesture (autoplay rules)
  const resume = prev ? prev.resume : playing.value;
  if (!prev && resume) pause();
  const h: Held = { release: null, resume, at: prev ? prev.at : parked.value };
  held = h;
  heldNote.value = { id, midi };
  await woke;
  if (held !== h) return; // released (or another note pressed) while the audio was waking
  const part = movement.value?.parts.find((p) => p.id === myPart.value);
  h.release = e.holdNote(midi, part ? trackOf(part).inst : 'aahs', sp, part?.id);
}

export function releaseNote() {
  if (!held) return;
  const h = held;
  held = null;
  heldNote.value = null;
  h.release?.();
  if (h.resume) void play(h.at);
}

// ---------- loading ----------
/** The work shown when one arrives in the app: the example. Every device is shown it once, at
 *  its first visit (and again if this line names another work one day). After that the app
 *  reopens the work and the movement left last time. */
const FIRST_WORK = 'bach-deux-chorals';

/** Which work to open at the start. `shown`: the FIRST_WORK this device has already been shown.
 *  Where FIRST_WORK is not there: the last work opened, else the first of the list. */
export function startWorkId(list: { id: string }[], last: string | null, shown?: string): string | undefined {
  const first = list.find((w) => w.id === FIRST_WORK)?.id;
  if (first && shown !== first) return first;
  if (last && list.some((w) => w.id === last)) return last;
  return first ?? list[0]?.id;
}

/** Opens it; the work left last time at the movement left. */
async function openStartWork() {
  const p = prefs.value;
  const id = startWorkId(works.value, p.work, p.firstShown);
  if (!id) return;
  await openWork(id, id === p.work ? (p.mv ?? undefined) : undefined); // a movement belongs to its work
  if (id === FIRST_WORK && p.firstShown !== id) setPrefs({ firstShown: id });
}

export async function boot() {
  cacheEarlySamples(); // first visit: let the service worker cache the instruments loaded now
  try {
    works.value = await loadLibrary();
    await openStartWork();
    if (work.value) engine(); // start loading the instruments now (the audio itself starts on the first play)
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  }
  booted.value = true;
}

/** Add a work from its .zip archive (docs/ARCHIVE.md); it stays in this browser. */
export async function importZip(file: File) {
  try {
    error.value = null;
    const w = await importWorkZip(file);
    works.value = withWork(works.value, w);
    await openWork(w.id);
    engine();
    keepStorage();
  } catch (e) {
    error.value = `Import impossible. ${e instanceof Error ? e.message : e}`;
  }
}

/** Asks the browser to keep what this site stores (the imported works, the recordings) when the
 *  device runs short of room: without it a browser may clear a site little used. Granted
 *  silently or not at all, according to the browser (an installed app usually is). */
function keepStorage() {
  void navigator.storage?.persist?.().catch(() => false);
}

/** Removes the open work, imported in this browser, with its recordings and the progress in its
 *  text. Then opens another work: the built-in one of the same id if there is one, else the
 *  first of the list. */
export async function removeOpenWork() {
  const w = work.value;
  if (!w || w.source !== 'imported') return;
  pause();
  const id = w.pack.id;
  try {
    const builtin = await removeWork(id);
    if (!builtin) works.value = works.value.filter((x) => x.id !== id);
    work.value = null;
    const next = builtin ? id : works.value[0]?.id;
    if (next) await openWork(next);
    else setPrefs({ work: null, mv: null });
  } catch (e) {
    error.value = `Retrait impossible. ${e instanceof Error ? e.message : e}`;
  }
}

export async function openWork(id: string, mv?: string) {
  pause();
  ficheOpen.value = false;
  const w = await loadWork(id);
  work.value = w;
  const mvId = w.pack.movements.some((m) => m.id === mv) ? mv! : w.pack.movements[0].id;
  setPrefs({ work: id, mv: mvId, part: prefs.value.part || w.pack.defaultPart || 'T' });
  parked.value = 0;
}

export function openMovement(id: string) {
  if (prefs.value.mv === id) return;
  pause();
  setPrefs({ mv: id });
  parked.value = 0;
}

/** Opens movement `id` and plays it: from its start, or, for the movement already open, from
 *  where it is (it goes on if it is playing). The sheet's « Jouer ce mouvement ». */
export function playMovement(id: string) {
  if (prefs.value.mv === id) {
    if (!playing.value) void play();
    return;
  }
  openMovement(id);
  void play(0);
}

/** A score position past which « previous » means « back to the start of this movement ». */
const RESTART_MS = 2000;

/** The navigator's ⏮: back to the start of the movement, or (already there) to the previous
 *  movement. Keeps playing if playing. */
export function previousMovement() {
  const w = work.value;
  const mv = movement.value;
  if (!w || !mv) return;
  const go = playing.value || between.value;
  if (position() > RESTART_MS) {
    stopRecording();
    cancelNext();
    if (go) void play(0);
    else parked.value = 0;
    return;
  }
  const list = w.pack.movements;
  const prev = list[list.findIndex((m) => m.id === mv.id) - 1];
  if (!prev) {
    if (go) void play(0);
    else parked.value = 0;
    return;
  }
  openMovement(prev.id);
  if (go) void play(0);
}

/** The navigator's ⏭: the next movement, from its start. Keeps playing if playing. */
export function nextMovement() {
  const w = work.value;
  const mv = movement.value;
  if (!w || !mv) return;
  const list = w.pack.movements;
  const next = list[list.findIndex((m) => m.id === mv.id) + 1];
  if (!next) return;
  const go = playing.value || between.value;
  openMovement(next.id);
  if (go) void play(0);
}

// reconfigure the engine when the movement changes (following another voice changes nothing audible)
// Only a change of movement may stop the music: everything read while reconfiguring (track
// settings, speed…) is read untracked, so muting, solo, volume or speed never restart anything.
let lastMv: Movement | null = null;
effect(() => {
  const mv = movement.value;
  if (mv === lastMv) return;
  lastMv = mv;
  untracked(() => {
    stopRecording();
    if (eng) {
      eng.stop(false);
      playing.value = false;
      parked.value = 0;
      configure();
    }
  });
});
