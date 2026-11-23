// @vitest-environment happy-dom
// « Enregistrer ma voix »: every action that moves or stops the music stops a recording first
// (state.ts calls the hook rec.ts registers); the recording's own start does not. With a fake engine.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedPack, Movement } from '../src/pack/types';

const engines: FakeEngine[] = [];
class FakeEngine {
  ctx = { currentTime: 0, sampleRate: 48000, state: 'running' };
  rate = 1;
  isPlaying = false;
  outputLatency = 0.04;
  onInterrupt?: () => void;
  opts: { onEnd?: () => void } = {};
  constructor() {
    engines.push(this);
  }
  setScore() {}
  setClicks() {}
  setVolume() {}
  setMix() {}
  setInstrument() {}
  setRate(r: number) {
    this.rate = r;
  }
  setTake() {}
  setTakeVolume() {}
  async resume() {}
  play(_st: number, opts: { onEnd?: () => void } = {}) {
    this.opts = opts;
    this.isPlaying = true;
  }
  stop() {
    this.isPlaying = false;
  }
  position() {
    return 5000;
  }
  anchor() {
    return null;
  }
}
vi.mock('../src/audio/engine', () => ({ Engine: FakeEngine }));
vi.mock('../src/offline', () => ({ cacheEarlySamples: () => {} }));

const mv = (id: string): Movement => ({
  id,
  title: id,
  mei: '',
  parts: [{ id: 'T', name: 'Ténor', sourceName: 'T', kind: 'voice', staves: [1], range: [48, 67] } as unknown as Movement['parts'][number]],
  lyricLines: [],
  measures: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ id: `m${i}`, n: String(i + 1), t: i * 2000, q: i * 4, mark: null, tonic: 0, minor: false, ts: [4, 4] as [number, number] })),
  notes: [],
  durationMs: 20000,
});
const fakeWork: LoadedPack = {
  pack: { version: 1, id: 'w', title: 'Œuvre', composer: 'X', movements: [mv('a'), mv('b'), mv('c')] },
  source: 'builtin',
  getFile: async () => '',
  url: () => '',
};

const S = await import('../src/state');
const stops = vi.fn();
S.onMove(stops);
S.work.value = fakeWork;
S.setPrefs({ mv: 'b', rate: 1 });
const e = S.engine() as unknown as FakeEngine;

async function playingNow() {
  await S.play(4000);
  stops.mockClear();
}

describe('stop rules: anything that moves or stops the music stops a recording (kept)', () => {
  beforeEach(async () => {
    S.setPrefs({ mv: 'b', rate: 1, endMode: 'stop' });
    await playingNow();
  });

  it('pause, Space (toggle), ■', () => {
    S.pause();
    expect(stops).toHaveBeenCalled();
    stops.mockClear();
    void S.play();
    stops.mockClear();
    S.toggle();
    expect(stops).toHaveBeenCalled();
  });
  it('a measure on the page, « Aller à », arrows, Home (startFrom / seekParked)', () => {
    S.startFrom(8000);
    expect(stops).toHaveBeenCalled();
    stops.mockClear();
    S.seekParked(0);
    expect(stops).toHaveBeenCalled();
  });
  it('réécouter', async () => {
    await S.replayMine();
    expect(stops).toHaveBeenCalled();
  });
  it('another tempo (but not the same one again)', () => {
    S.setRate(1);
    expect(stops).not.toHaveBeenCalled();
    S.setRate(0.8);
    expect(stops).toHaveBeenCalled();
    stops.mockClear();
    S.resetSettings();
    expect(stops).toHaveBeenCalled();
  });
  it('⏮ and ⏭, another movement, another work', async () => {
    S.previousMovement(); // 5 s in: back to the start of this movement
    expect(stops).toHaveBeenCalled();
    await playingNow();
    S.nextMovement();
    expect(stops).toHaveBeenCalled();
    await playingNow();
    S.openMovement('a');
    expect(stops).toHaveBeenCalled();
    await playingNow();
    S.playMovement('b');
    expect(stops).toHaveBeenCalled();
  });
  it('the end of the movement (also when it loops), the system taking the audio', () => {
    S.setPrefs({ endMode: 'loop' });
    e.opts.onEnd?.();
    expect(stops).toHaveBeenCalled();
    stops.mockClear();
    e.onInterrupt?.();
    expect(stops).toHaveBeenCalled();
  });
  it('a note held in the line pauses the music: stops too', async () => {
    void S.holdNote('n1', 60);
    expect(stops).toHaveBeenCalled();
    S.releaseNote();
  });
  it('the recording’s own start does not stop it; mute, solo, volume do not either', async () => {
    await S.play(3000, true);
    const part = S.movement.value!.parts[0];
    S.setTrack(part, { mute: true });
    S.setTrack(part, { vol: 0.3 });
    S.setMetro(true);
    expect(stops).not.toHaveBeenCalled();
  });
});

describe('the option off: no microphone, nothing recorded', () => {
  it('● does nothing while the option is off', async () => {
    const gum = vi.fn(async () => {
      throw new Error('no');
    });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: gum, enumerateDevices: async () => [] }, configurable: true });
    const R = await import('../src/rec');
    S.setPrefs({ recOn: false });
    await R.startRecording();
    expect(gum).not.toHaveBeenCalled();
    expect(R.recording.value).toBeNull();
    // on: the microphone is asked for (refused here: a message, nothing else changes)
    S.setPrefs({ recOn: true });
    S.pause();
    await R.startRecording();
    expect(gum).toHaveBeenCalled();
    expect(R.recording.value).toBeNull();
    expect(R.recMsg.value).toMatch(/micro/i);
    expect(S.playing.value).toBe(false);
  });
});

describe('prefs', () => {
  it('offset bounded to ±800 ms by 10 ms, volume to 0..1', () => {
    expect(S.migratePrefs({ recOffset: 1234 }).recOffset).toBe(800);
    expect(S.migratePrefs({ recOffset: -37 }).recOffset).toBe(-40);
    expect(S.migratePrefs({ recOffset: 'x' }).recOffset).toBe(0);
    expect(S.migratePrefs({ takeVol: 3 }).takeVol).toBe(1);
    expect(S.migratePrefs({}).recOn).toBeUndefined(); // off by default
  });
});
