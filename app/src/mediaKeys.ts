// The headset's play/pause button (and the media keys of a keyboard, the lock screen's and the
// notification's controls) drive the playback, as in a music app: Media Session API.
//
// Browsers send these buttons only to a page that is playing a media element: Web Audio alone does
// not count (Chrome on Android shows no media session for it). So, while the music plays, a
// hidden <audio> element loops a silent recording made here (10 s of 8-bit silence, no download);
// paused, it keeps the session, so the next press means « play ». The music itself never goes
// through it (no added latency, the audio path is unchanged). The notification's progress bar shows
// the movement (its length, where the music is, at the tempo chosen), not the 10 s loop, and can be
// dragged to move in the movement.
//
// iOS too (11/2026): there a media element may only start inside the user's gesture, so it is
// started by state.play() before its first await (playStartHooks); once started it may be started
// again later. Pupitre then plays like a music app: the silent switch does not mute it (the audio
// session is set to "playback" for the Web Audio as well, see engine.ts).
import { effect } from '@preact/signals';
import { between, movement, nextMovement, parked, playing, playStartHooks, position, prefs, previousMovement, seekParked, toggle, work } from './state';

/** A WAV file of `secs` seconds of silence (8 kHz, 16-bit mono, the most widely read form).
 *  Media sessions are only given for media longer than a few seconds. */
export function silentWav(secs = 10): Blob {
  const sr = 8000;
  const n = sr * secs * 2;
  const b = new ArrayBuffer(44 + n);
  const v = new DataView(b);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); // bytes per second
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits
  str(36, 'data');
  v.setUint32(40, n, true); // the samples: zeros
  return new Blob([b], { type: 'audio/wav' });
}

/** Connects the media keys to the playback. Returns the clean-up. */
export function startMediaKeys(): () => void {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!ms) return () => {};
  const el = new Audio();
  el.src = URL.createObjectURL(silentWav());
  el.loop = true;
  el.preload = 'auto';
  el.setAttribute('aria-hidden', 'true');
  // pauses asked by us whose `pause` event has not come yet (it comes later, maybe after the
  // music started again: a change of movement stops then restarts it)
  let ourPauses = 0;

  const on = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* action not supported by this browser */
    }
  };
  const active = () => playing.value || between.value;
  on('play', () => !active() && toggle());
  on('pause', () => active() && toggle());
  on('stop', () => active() && toggle());
  on('previoustrack', previousMovement); // as the navigator's ⏮: start of the movement, then the one before
  on('nexttrack', nextMovement); // as ⏭
  // dragging the notification's progress bar: there in the movement (playing on if it was playing)
  on('seekto', (d: MediaSessionActionDetails) => {
    if (d.seekTime == null) return;
    seekParked(Math.max(0, d.seekTime * 1000));
    showPosition();
  });

  /** The movement's length and where the music is, in score seconds advancing at the chosen
   *  speed: the browser moves the bar by itself while playing (`playbackState`). */
  const showPosition = () => {
    const mv = movement.value;
    if (!mv || !ms.setPositionState) return;
    const duration = Math.max(0.1, mv.durationMs / 1000);
    const pos = between.value ? duration : Math.max(0, Math.min(duration, position() / 1000));
    try {
      ms.setPositionState({ duration, position: pos, playbackRate: prefs.value.rate || 1 });
    } catch {
      /* invalid state (rare): the bar keeps its last state */
    }
  };
  // a jump while playing (a click on the score, « Aller à », ⏮) restarts the music: the bar is set
  // again just after; a slow refresh corrects any drift (one call, nothing drawn by the page)
  const afterStart = () => setTimeout(showPosition, 200);
  playStartHooks.add(afterStart);
  const refresh = setInterval(() => active() && showPosition(), 5000);

  // the system took the sound away from the page (a call, another app): the music stops too
  const onSysPause = () => {
    if (ourPauses > 0) ourPauses--;
    else if (active()) toggle();
  };
  el.addEventListener('pause', onSysPause);
  // started inside the gesture that starts the music (required on iOS, harmless elsewhere)
  const prime = () => {
    if (el.paused) void el.play().catch(() => {});
  };
  playStartHooks.add(prime);

  const offState = effect(() => {
    const go = active();
    if (go) {
      if (el.paused) void el.play().catch(() => {}); // refused (no gesture yet): the keys wait
    } else if (!el.paused) {
      ourPauses++;
      el.pause();
    }
    ms.playbackState = go ? 'playing' : 'paused';
    void movement.value;
    void parked.value; // moved while paused (the navigator, a click on the score)
    void prefs.value.rate;
    showPosition();
  });
  const offMeta = effect(() => {
    const w = work.value;
    const mv = movement.value;
    if (!w || !mv || typeof MediaMetadata === 'undefined') return;
    const base = import.meta.env.BASE_URL;
    ms.metadata = new MediaMetadata({
      title: mv.title,
      artist: w.pack.composer,
      album: w.pack.title,
      artwork: [{ src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' }],
    });
  });
  return () => {
    offState();
    offMeta();
    playStartHooks.delete(prime);
    playStartHooks.delete(afterStart);
    clearInterval(refresh);
    el.removeEventListener('pause', onSysPause);
    el.pause();
    URL.revokeObjectURL(el.src);
    for (const a of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto'] as MediaSessionAction[]) on(a, null);
  };
}
