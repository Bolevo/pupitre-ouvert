// « Enregistrer ma voix » (asked for in 10/2026, off by default): record my voice along with the
// music, one take per movement (a new one replaces the old), and hear it back as an extra track in
// time with the score. Nothing here runs, and the microphone is never asked for, while the option
// is off (prefs.recOn).
//
// Rules:
// - ● starts the music from where it is parked (like ▶) with the microphone on; the previous take
//   of the movement is silent meanwhile.
// - Anything that moves or stops the music (■, pause, a measure, « Aller à », ⏮/⏭, réécouter, another
//   movement or work, another tempo, the end of the movement, the system taking the audio) stops
//   the recording and KEEPS what was recorded (it replaces the old take). Less than 1 s: dropped.
// - The microphone is opened at ● and closed as soon as the recording stops.
// - A take is heard only at the tempo it was recorded at.
import { computed, effect, signal, untracked } from '@preact/signals';
import { del, get, keys, set } from './pack/db';
import { capture, inputLatency, listMics, MicError, openMic, stop as stopStream } from './audio/recorder';
import { encodeWav, MIN_TAKE_MS, safeFileName, takeFromFloat, takeFromWav, takeKey, TakeBuilder, type Take, type TakeMeta } from './audio/take';
import { BASE, clampOffset, engine, hasEngine, movement, myPart, onEngine, onMove, parked, pause, play, playing, position, prefs, setPrefs, work } from './state';

/** The current movement's take (without its samples), or null. */
export interface TakeInfo extends TakeMeta {
  workId: string;
  mvId: string;
}
export const take = signal<TakeInfo | null>(null);
let pcm: Int16Array | null = null; // its samples (only the current movement's take is in memory)

/** Recording now (since: performance.now() at its start). */
export const recording = signal<{ since: number } | null>(null);
/** Opening the microphone, or saving / importing a take. */
export const recBusy = signal<'starting' | 'saving' | null>(null);
/** A short message in the panel (an error, a take dropped…). */
export const recMsg = signal<string | null>(null);
/** Peak level of the microphone (0..1) while recording, for the red dot. */
export const recLevel = signal(0);
/** The label of the microphone used last (shown in the panel's menu). */
export const micUsed = signal('');

let msgTimer = 0;
function say(msg: string | null, ms = 7000) {
  window.clearTimeout(msgTimer);
  recMsg.value = msg;
  if (msg) msgTimer = window.setTimeout(() => (recMsg.value = null), ms);
}

// ---------- the option ----------
export function setRecOn(on: boolean) {
  setPrefs({ recOn: on });
}
export function setTakeOn(on: boolean) {
  setPrefs({ takeOn: on });
}
export function setTakeVol(v: number) {
  setPrefs({ takeVol: Math.max(0, Math.min(1, v)) });
}
export function setRecOffset(ms: number) {
  setPrefs({ recOffset: clampOffset(ms) });
}
export function setRecDevice(id: string) {
  setPrefs({ recDevice: id });
}

// ---------- recording ----------
interface Session {
  workId: string;
  mvId: string;
  part: string;
  endSt: number;
  stream: MediaStream | null;
  cap: { stop(): Promise<void> } | null;
  builder: TakeBuilder | null;
  live: (() => void) | null; // waiting for the microphone's first real samples
  off: (() => void)[]; // listeners to remove, wake lock to release
}
let session: Session | null = null;

/** The microphone delivers sound within this (a Bluetooth headset switching profile can take
 *  about a second), or the recording does not start. */
const MIC_READY_MS = 3000;

/** Stops what a session holds: listeners, wake lock, and (unless `keepCapture`: stopped after its
 *  last samples) the capture graph and the microphone. */
function teardown(s: Session, keepCapture = false) {
  for (const f of s.off.splice(0)) f();
  if (keepCapture) return;
  if (s.cap) void s.cap.stop();
  else if (s.stream) stopStream(s.stream);
}

/** While recording: the screen stays on, and a microphone taken away (unplugged, the system), a
 *  page sent to the background or closed stop the recording, keeping what was recorded. */
function watch(s: Session, stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  const id = track?.getSettings().deviceId;
  const ended = () => session === s && endRecording('Le micro s’est arrêté : enregistrement gardé.');
  track?.addEventListener('ended', ended);
  s.off.push(() => track?.removeEventListener('ended', ended));
  const devices = () =>
    void listMics().then((l) => {
      if (session === s && id && l.length && !l.some((m) => m.deviceId === id)) endRecording('Le micro a disparu : enregistrement gardé.');
    });
  navigator.mediaDevices?.addEventListener?.('devicechange', devices);
  s.off.push(() => navigator.mediaDevices?.removeEventListener?.('devicechange', devices));
  const hidden = () => session === s && document.visibilityState === 'hidden' && endRecording('Enregistrement arrêté (Pupitre Ouvert n’était plus à l’écran) : gardé.');
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', hidden);
  s.off.push(() => {
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', hidden);
  });
}

async function wakeLock(s: Session) {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const lock = await nav.wakeLock?.request('screen');
    if (!lock) return;
    if (session !== s) return void lock.release().catch(() => {});
    s.off.push(() => void lock.release().catch(() => {}));
  } catch {
    /* not supported, or refused: the app's own lock (main.tsx) usually holds anyway */
  }
}

const MIC_ERRORS: Record<MicError['kind'], string> = {
  denied: 'Micro refusé : autorisez le micro pour ce site dans le navigateur, puis réessayez.',
  none: 'Aucun micro trouvé.',
  busy: 'Le micro est occupé par une autre application.',
  unsupported: 'Ce navigateur ne permet pas d’enregistrer ici (il faut une page https).',
  silent: 'Le micro ne donne aucun son. Essayez un autre micro (menu ⋯).',
  other: 'Impossible d’ouvrir le micro.',
};

/** ●: opens the microphone, then plays from where the music is parked (or is) and records. */
export async function startRecording() {
  const w = work.value;
  const mv = movement.value;
  if (!prefs.value.recOn || session || recBusy.value || !w || !mv) return;
  const e = engine();
  const woke = e.resume(); // within the gesture (autoplay rules)
  const s: Session = { workId: w.pack.id, mvId: mv.id, part: myPart.value, endSt: mv.durationMs, stream: null, cap: null, builder: null, live: null, off: [] };
  session = s;
  recBusy.value = 'starting';
  say(null);
  applyTake(); // the old take is silent while recording
  try {
    const stream = await openMic(prefs.value.recDevice ?? '');
    s.stream = stream;
    if (session !== s) return stopStream(stream);
    micUsed.value = stream.getAudioTracks()[0]?.label ?? '';
    const ready = new Promise<boolean>((resolve) => {
      s.live = () => resolve(true);
      window.setTimeout(() => resolve(false), MIC_READY_MS);
    });
    const cap = await capture(e.ctx, stream, `${BASE}rec-worklet.js`, (frame, data, live) => onData(s, frame, data, live));
    s.cap = cap;
    if (session !== s) return void cap.stop();
    await woke;
    // the music starts only once the microphone gives sound (no first notes lost while a
    // Bluetooth headset negotiates)
    if (!(await ready)) throw new MicError('silent');
    if (session !== s) return;
    watch(s, stream);
    const from = playing.value ? position() : parked.value;
    await play(from, true);
    const a = e.anchor();
    if (session !== s || !a) {
      if (session === s) endRecording();
      return;
    }
    s.builder = new TakeBuilder(e.ctx.sampleRate, a, inputLatency(stream) + e.outputLatency, s.endSt);
    recording.value = { since: performance.now() };
    void wakeLock(s);
  } catch (err) {
    if (session !== s) return; // stopped meanwhile (pause, a jump…): nothing to say
    session = null;
    teardown(s);
    applyTake();
    say(err instanceof MicError ? MIC_ERRORS[err.kind] : `Enregistrement impossible : ${err instanceof Error ? err.message : err}`, 10000);
  } finally {
    if (recBusy.value === 'starting') recBusy.value = null;
  }
}

let levelAt = 0;
function onData(s: Session, frame: number, data: Float32Array, live: boolean) {
  if (session !== s) return;
  if (live && s.live) {
    s.live();
    s.live = null;
  }
  if (!s.builder) return;
  const rms = s.builder.push(frame, data);
  const t = performance.now();
  if (t - levelAt > 100) {
    // the meter: at most ten updates a second
    levelAt = t;
    recLevel.value = rms;
  }
}

/** ■ (and pause): stops the music, which stops the recording (kept). */
export function stopRecording() {
  pause();
}

/** Stops a recording (or its start) and keeps what was recorded: it replaces the movement's take. */
function endRecording(msg?: string) {
  const s = session;
  if (!s) return;
  session = null;
  recording.value = null;
  recLevel.value = 0;
  if (recBusy.value === 'starting') recBusy.value = null;
  const b = s.builder;
  const cap = s.cap;
  teardown(s, !!b);
  if (!b || !hasEngine()) {
    // still opening the microphone: nothing recorded
    applyTake();
    return;
  }
  const ctx = engine().ctx;
  // the sample captured now: the take ends there (the movement's end at the latest)
  const capSt = b.scoreOfFrame(Math.floor(ctx.currentTime * ctx.sampleRate));
  recBusy.value = 'saving';
  void (async () => {
    try {
      await cap?.stop(); // the last samples, then the microphone is closed
      const t = b.finish(capSt, Date.now(), s.part);
      if (!t || t.durMs < MIN_TAKE_MS) {
        say('Moins d’une seconde : enregistrement ignoré.');
        return;
      }
      await store(s.workId, s.mvId, t);
      if (msg) say(msg);
    } catch (err) {
      say(`Enregistrement non sauvegardé : ${err instanceof Error ? err.message : err}`, 10000);
    } finally {
      recBusy.value = null;
      applyTake();
    }
  })();
}
onMove(() => endRecording());

// ---------- the stored take ----------
interface Stored extends TakeMeta {
  pcm: ArrayBuffer;
}

async function store(workId: string, mvId: string, t: Take) {
  const pcmCopy = t.pcm.byteOffset === 0 && t.pcm.byteLength === t.pcm.buffer.byteLength ? (t.pcm.buffer as ArrayBuffer) : (t.pcm.slice().buffer as ArrayBuffer);
  const v: Stored = { v: 1, sr: t.sr, startSt: t.startSt, rate: t.rate, at: t.at, durMs: t.durMs, part: t.part, pcm: pcmCopy };
  await set(takeKey(workId, mvId), v);
  // the movement on screen: this is its take now
  if (work.value?.pack.id === workId && movement.value?.id === mvId) {
    loaded = `${workId}\n${mvId}`;
    pcm = t.pcm;
    take.value = { v: 1, sr: t.sr, startSt: t.startSt, rate: t.rate, at: t.at, durMs: t.durMs, part: t.part, workId, mvId };
  }
}

let loaded = ''; // workId\nmvId of the take in memory (or of its absence)
let loading = 0;
async function loadTake(workId: string | undefined, mvId: string | undefined) {
  const key = workId && mvId ? `${workId}\n${mvId}` : '';
  if (key === loaded) return applyTake();
  loaded = key;
  pcm = null;
  take.value = null;
  applyTake();
  if (!key) return;
  const token = ++loading;
  try {
    const v = (await get(takeKey(workId!, mvId!))) as Stored | undefined;
    if (token !== loading || loaded !== key || !v || !(v.pcm instanceof ArrayBuffer) || !(v.sr > 0)) return;
    pcm = new Int16Array(v.pcm);
    take.value = { v: 1, sr: v.sr, startSt: Number(v.startSt) || 0, rate: Number(v.rate) || 1, at: v.at, durMs: (pcm.length / v.sr) * 1000, part: v.part, workId: workId!, mvId: mvId! };
    applyTake();
  } catch {
    /* no IndexedDB (private mode): no take */
  }
}

/** Hear the take from its start (it is turned on if it was off). */
export function listenTake() {
  const t = take.value;
  if (!t) return;
  if (!takeOn.value) setTakeOn(true);
  void play(t.startSt);
}

/** Deletes the current movement's take. */
export async function deleteTake() {
  const t = take.value;
  if (!t || session) return;
  try {
    await del(takeKey(t.workId, t.mvId));
  } catch {
    /* already gone */
  }
  if (take.value?.at === t.at) {
    pcm = null;
    take.value = null;
    applyTake();
  }
  say('Enregistrement supprimé.', 3000);
}

// ---------- export / import ----------
/** Downloads the take as a 16-bit mono WAV, with its place in the score (a `pupi` chunk). */
export function exportTake() {
  const t = take.value;
  const w = work.value;
  const mv = w?.pack.movements.find((m) => m.id === t?.mvId);
  if (!t || !pcm || !w || !mv) return;
  const bytes = encodeWav({ ...t, pcm }, { workId: t.workId, mvId: t.mvId });
  const blob = new Blob([bytes as BlobPart], { type: 'audio/wav' });
  const part = mv.parts.find((p) => p.id === t.part)?.name;
  const name = safeFileName(['Pupitre', shortWorkTitle(w.pack.title), mv.title, part].filter(Boolean).join(' – ')) + '.wav';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 30_000);
}

function shortWorkTitle(t: string) {
  return t.split(/[,(:]/)[0].trim();
}

/** Replaces the current movement's take with an audio file: a WAV exported by Pupitre goes back
 *  exactly where it was; any other file starts at the movement's start, at the current tempo. */
export async function importTake(file: File) {
  const w = work.value;
  const mv = movement.value;
  if (!w || !mv || session || recBusy.value) return;
  recBusy.value = 'saving';
  say(null);
  try {
    const bytes = await file.arrayBuffer();
    const ours = takeFromWav(bytes);
    let t: Take;
    let note = '';
    if (ours) {
      t = ours.take;
      if (ours.tag.workId !== w.pack.id || ours.tag.mvId !== mv.id) note = ' Il venait d’un autre mouvement : placé tel quel.';
    } else {
      const ctx = engine().ctx;
      let audio: AudioBuffer;
      try {
        audio = await ctx.decodeAudioData(bytes.slice(0));
      } catch {
        say('Fichier audio illisible.');
        return;
      }
      const rate = prefs.value.rate;
      const maxMs = mv.durationMs / rate;
      const sr = ctx.sampleRate / 2;
      const frames = Math.max(1, Math.ceil((Math.min(audio.duration * 1000, maxMs) / 1000) * sr));
      // mono and resampled by the browser (an offline context at the take's rate)
      const off = new OfflineAudioContext(1, frames, sr);
      const src = off.createBufferSource();
      src.buffer = audio;
      src.connect(off.destination);
      src.start();
      const out = await off.startRendering();
      t = takeFromFloat(out.getChannelData(0), sr, 0, rate, maxMs);
      t.part = myPart.value;
    }
    // never longer than the movement
    const room = Math.floor(((mv.durationMs - t.startSt) / 1000 / t.rate) * t.sr);
    if (room <= 0 || t.startSt < 0) {
      say('Cet enregistrement est en dehors de ce mouvement.');
      return;
    }
    if (t.pcm.length > room) {
      t.pcm = t.pcm.slice(0, room);
      t.durMs = (room / t.sr) * 1000;
    }
    if (t.durMs < MIN_TAKE_MS) {
      say('Fichier trop court (moins d’une seconde).');
      return;
    }
    await store(w.pack.id, mv.id, t);
    say(`Enregistrement importé.${note}`, note ? 9000 : 3000);
  } catch (err) {
    say(`Import impossible : ${err instanceof Error ? err.message : err}`, 10000);
  } finally {
    recBusy.value = null;
    applied = null;
    applyTake();
  }
}

// ---------- what the engine plays ----------
// (last in the file: these effects run at once, and read everything declared above)
const recOn = computed(() => !!prefs.value.recOn);
// what the engine plays: the take (with the manual offset), unless off, recording, or none
const takeOn = computed(() => prefs.value.takeOn !== false);
const takeVol = computed(() => prefs.value.takeVol ?? 0.9);
const offset = computed(() => prefs.value.recOffset ?? 0);
let applied: { at: number; startSt: number; on: boolean } | null = null;
function applyTake() {
  if (!hasEngine()) return;
  const e = engine();
  const t = take.value;
  const on = !!(recOn.value && takeOn.value && !session && t && pcm);
  const startSt = t ? t.startSt + offset.value * t.rate : 0;
  if (applied && applied.on === on && (!on || (applied.at === t!.at && applied.startSt === startSt))) return;
  applied = { at: t?.at ?? 0, startSt, on };
  e.setTake(on ? { pcm: pcm!, sr: t!.sr, startSt, rate: t!.rate } : null);
}
// the take of the movement on screen, while the option is on (released otherwise)
effect(() => {
  const on = recOn.value;
  const w = work.value?.pack.id;
  const mv = movement.value?.id;
  untracked(() => {
    if (!on && session) endRecording();
    void loadTake(on ? w : undefined, on ? mv : undefined);
  });
});
effect(() => {
  void takeOn.value;
  void offset.value;
  untracked(applyTake);
});
effect(() => {
  const v = takeVol.value;
  if (hasEngine()) untracked(() => engine().setTakeVolume(v));
});
onEngine(() => {
  engine().setTakeVolume(takeVol.value);
  applied = null;
  applyTake();
});

// « Justesse » (pitch analysis of the take) was removed (11/2026): drop its stored analyses, once
void (async () => {
  try {
    for (const k of await keys()) if (typeof k === 'string' && k.startsWith('pitch:')) await del(k);
  } catch {
    /* no storage: nothing to drop */
  }
})();
