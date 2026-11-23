// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { followPart, hasEngine, migratePrefs, mixFor, myModeOf, myPart, prefs, setMyMode, setTrack, trackOf, work, type Track } from '../src/state';
import type { LoadedPack, Movement, Part } from '../src/pack/types';

const part = (id: string, kind: Part['kind'] = 'voice'): Part => ({ id, name: id, sourceName: id, kind, staves: [1] });
const mv = { id: 'mvt1', parts: [part('S'), part('A'), part('T'), part('B'), part('P', 'accomp')] } as unknown as Movement;
const P = Object.fromEntries(mv.parts.map((p) => [p.id, p])) as Record<string, Part>;

/** Fresh preferences (default voice: T) and a loaded work with the movement above; no engine. */
function reset(tracks: Record<string, Partial<Track>> = {}) {
  prefs.value = { ...migratePrefs({}), tracks: tracks as Record<string, Track> };
  work.value = { pack: { version: 1, id: 'w', title: 'W', composer: 'C', movements: [mv] }, source: 'builtin', getFile: async () => '', url: () => '' } as LoadedPack;
}
const t = (id: string) => trackOf(P[id]);
const stored = (id: string) => prefs.value.tracks[id];

describe('mixFor', () => {
  beforeEach(() => reset());
  it('support is a way of hearing MY voice only (default part: T)', () => {
    const mix = mixFor(mv, { T: { support: true }, A: { support: true } });
    expect(mix.T.support).toBe(true);
    expect(mix.A.support).toBe(false);
  });
  it('defaults: everything heard, nothing soloed', () => {
    const mix = mixFor(mv, {});
    for (const id of ['S', 'A', 'T', 'B', 'P']) {
      expect(mix[id].mute).toBe(false);
      expect(mix[id].solo).toBe(false);
    }
    expect(mix.P.vol).toBeCloseTo(0.6);
    expect(mix.T.vol).toBeCloseTo(0.8);
    expect(mix.A.vol).toBeCloseTo(0.65); // the followed voice in front of the others
  });
});

describe('setTrack', () => {
  beforeEach(() => reset());
  it('runs without an audio engine (state only)', () => {
    expect(hasEngine()).toBe(false);
  });
  it('the first change stores the whole track, defaults included', () => {
    setTrack(P.S, { vol: 0.4 });
    expect(stored('S')).toEqual({ vol: 0.4, mute: false, solo: false, inst: 'aahs' });
    setTrack(P.T, { vol: 0.5 });
    expect(stored('T').inst).toBe('clarinet'); // the followed voice
    setTrack(P.P, { mute: true });
    expect(stored('P')).toMatchObject({ vol: 0.6, inst: 'piano', mute: true });
    expect(stored('A')).toBeUndefined(); // the others untouched
  });
  it('solo turns mute and support off', () => {
    reset({ T: { mute: true, support: true } });
    setTrack(P.T, { solo: true });
    expect(t('T')).toMatchObject({ solo: true, mute: false, support: false });
  });
  it('mute turns solo and support off', () => {
    reset({ T: { solo: true, support: true } });
    setTrack(P.T, { mute: true });
    expect(t('T')).toMatchObject({ solo: false, mute: true, support: false });
  });
  it('support turns solo and mute off', () => {
    reset({ T: { solo: true, mute: true } });
    setTrack(P.T, { support: true });
    expect(t('T')).toMatchObject({ solo: false, mute: false, support: true });
  });
  it('turning something off leaves the rest as it was', () => {
    reset({ S: { mute: true, vol: 0.3, inst: 'marimba' } });
    setTrack(P.S, { solo: false });
    expect(t('S')).toMatchObject({ mute: true, solo: false, vol: 0.3, inst: 'marimba' });
    setTrack(P.S, { inst: 'strings' });
    expect(t('S')).toMatchObject({ mute: true, vol: 0.3, inst: 'strings' });
  });
  it('several solos may coexist (solo on one part does not touch the others)', () => {
    setTrack(P.S, { solo: true });
    setTrack(P.A, { solo: true });
    expect(t('S').solo && t('A').solo).toBe(true);
  });
});

describe('setMyMode', () => {
  beforeEach(() => reset());
  it('alone: no other part stays soloed, the piano included', () => {
    reset({ S: { solo: true }, P: { solo: true }, B: { mute: true } });
    setMyMode(P.T, 'solo');
    expect(t('T')).toMatchObject({ solo: true, mute: false, support: false });
    expect(t('S').solo).toBe(false);
    expect(t('P').solo).toBe(false); // current behaviour: the accompaniment's solo goes too
    expect(t('B').mute).toBe(true); // mutes are kept
  });
  it('the other modes leave the other parts alone', () => {
    reset({ S: { solo: true } });
    setMyMode(P.T, 'mute');
    expect(t('T')).toMatchObject({ mute: true, solo: false, support: false });
    expect(t('S').solo).toBe(true);
    setMyMode(P.T, 'support');
    expect(t('T')).toMatchObject({ mute: false, solo: false, support: true });
    expect(t('S').solo).toBe(true);
  });
  it('heard normally: no solo, no mute, no support; volume and instrument kept', () => {
    reset({ T: { solo: true, vol: 0.5, inst: 'marimba' } });
    setMyMode(P.T, 'on');
    expect(t('T')).toMatchObject({ mute: false, solo: false, support: false, vol: 0.5, inst: 'marimba' });
    expect(myModeOf(t('T'))).toBe('on');
  });
  it('myModeOf reads the track (mute wins over solo, solo over support)', () => {
    const base = { vol: 1, inst: 'aahs' as const };
    expect(myModeOf({ ...base, mute: true, solo: true, support: true })).toBe('mute');
    expect(myModeOf({ ...base, mute: false, solo: true, support: true })).toBe('solo');
    expect(myModeOf({ ...base, mute: false, solo: false, support: true })).toBe('support');
    expect(myModeOf({ ...base, mute: false, solo: false })).toBe('on');
  });
});

describe('followPart', () => {
  beforeEach(() => reset());
  it('the new voice on clarinet, the other voices on "ah", the piano untouched; volumes kept', () => {
    reset({ T: { vol: 0.5 }, S: { vol: 0.3, inst: 'marimba' }, P: { vol: 0.6 } });
    followPart('A');
    expect(prefs.value.part).toBe('A');
    expect(myPart.value).toBe('A');
    expect(t('A')).toMatchObject({ inst: 'clarinet', vol: 0.8 }); // never set: the followed voice's default
    expect(t('T')).toMatchObject({ inst: 'aahs', vol: 0.5 });
    expect(t('S')).toMatchObject({ inst: 'aahs', vol: 0.3 });
    expect(t('P')).toMatchObject({ inst: 'piano', vol: 0.6 });
  });
  it('the new followed voice turned down in the mix comes back up to its default level (not down)', () => {
    reset({ A: { vol: 0.1 }, B: { vol: 1 } });
    followPart('A');
    expect(t('A').vol).toBe(0.8);
    followPart('B');
    expect(t('B').vol).toBe(1); // louder than the default: kept
    expect(t('A').vol).toBe(0.65); // the part left, still at the followed level, back into the choir
    reset({ A: { vol: 0.9 } });
    followPart('A');
    followPart('B');
    expect(t('A').vol).toBe(0.9); // a level chosen: kept
  });
  it('volumes never set take the default of their new role', () => {
    followPart('A');
    expect(t('A').vol).toBe(0.8);
    expect(t('T').vol).toBe(0.65);
  });
  for (const mode of ['support', 'solo', 'mute'] as const) {
    it(`"my voice" ${mode} moves to the new voice, the old one goes back to normal`, () => {
      reset({ T: { mute: mode === 'mute', solo: mode === 'solo', support: mode === 'support', vol: 0.5 } });
      followPart('A');
      expect(myModeOf(t('A'))).toBe(mode);
      expect(myModeOf(t('T'))).toBe('on');
      expect(t('T').vol).toBe(0.5);
    });
  }
  it('the other voices keep their solo and mute, lose a hidden support', () => {
    reset({ S: { solo: true }, B: { mute: true, support: true } });
    followPart('A');
    expect(t('S').solo).toBe(true);
    expect(t('B')).toMatchObject({ mute: true, support: false });
    expect(myModeOf(t('A'))).toBe('on'); // T was heard normally
  });
  it('the piano can be followed: it keeps its piano, every voice goes to "ah"', () => {
    reset({ T: { solo: true }, P: { vol: 0.6 } });
    followPart('P');
    expect(myPart.value).toBe('P');
    expect(t('P')).toMatchObject({ inst: 'piano', vol: 0.6, solo: true }); // "my voice" alone moves to the piano, kept at least at its default level
    for (const id of ['S', 'A', 'T', 'B']) expect(t(id).inst).toBe('aahs');
    expect(myModeOf(t('T'))).toBe('on');
    expect(mixFor(mv, prefs.value.tracks).P.support).toBe(false);
    setMyMode(P.P, 'support');
    expect(mixFor(mv, prefs.value.tracks).P.support).toBe(true); // the support mode applies to it
    followPart('T');
    expect(t('T').inst).toBe('clarinet');
    expect(t('P')).toMatchObject({ inst: 'piano', support: false });
  });
  it('without a loaded work only the followed voice changes', () => {
    work.value = null;
    followPart('B');
    expect(prefs.value.part).toBe('B');
    expect(prefs.value.tracks).toEqual({});
  });
});
