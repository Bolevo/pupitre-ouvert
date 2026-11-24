import { describe, expect, it } from 'vitest';
import { migratePrefs, startWorkId } from '../src/state';

describe('migratePrefs', () => {
  it('fills the defaults and tolerates damaged input', () => {
    expect(migratePrefs(null).part).toBe('T');
    expect(migratePrefs('x').rate).toBe(1);
    expect(migratePrefs({ tracks: 'no' }).tracks).toEqual({});
  });
  it('bounds the speed and the line size', () => {
    expect(migratePrefs({ rate: 3 }).rate).toBe(2); // ♩ = 60 can go up to 120
    expect(migratePrefs({ rate: 1.8 }).rate).toBe(1.8);
    expect(migratePrefs({ rate: 0.1 }).rate).toBe(0.4);
    expect(migratePrefs({ rate: 'abc' }).rate).toBe(1);
    expect(migratePrefs({ laneSize: 7 }).laneSize).toBe(2);
  });
  it('moves the old default voice to the new choir once', () => {
    const p = migratePrefs({ tracks: { S: { vol: 0.5, mute: false, solo: false, inst: 'oohs' }, T: { vol: 0.8, mute: false, solo: false, inst: 'clarinet' } } });
    expect(p.tracks.S.inst).toBe('aahs');
    expect(p.tracks.T.inst).toBe('clarinet');
    expect(p.sound).toBe(4);
  });
  it('volumes left at the old defaults take the new balance once (choir 0.75 → 0.65, piano 0.7 → 0.6)', () => {
    const tr = (vol: number, inst: string) => ({ vol, mute: false, solo: false, inst });
    const p = migratePrefs({ sound: 2, tracks: { S: tr(0.75, 'aahs'), A: tr(0.5, 'aahs'), T: tr(0.8, 'clarinet'), P: tr(0.7, 'piano') } });
    expect([p.tracks.S.vol, p.tracks.A.vol, p.tracks.T.vol, p.tracks.P.vol]).toEqual([0.65, 0.5, 0.8, 0.6]);
    expect(p.sound).toBe(4);
    expect(migratePrefs({ sound: 3, tracks: { S: tr(0.75, 'aahs') } }).tracks.S.vol).toBe(0.75); // chosen after: kept
  });
  it('missing fields take their defaults, known ones are kept', () => {
    const p = migratePrefs({ work: 'w', mv: 'mvt2', part: 'A', endMode: 'loop', metro: true, metroSub: 'half' });
    expect(p).toMatchObject({ work: 'w', mv: 'mvt2', part: 'A', endMode: 'loop', metro: true, metroSub: 'half' });
    expect(p).toMatchObject({ rate: 1, laneSize: 1, lyrics: 'auto', tracks: {} });
    expect(migratePrefs({})).toMatchObject({ work: null, mv: null, part: 'T' });
  });
  it('other damaged values', () => {
    expect(migratePrefs(undefined).tracks).toEqual({});
    expect(migratePrefs({ tracks: null }).tracks).toEqual({});
    expect(migratePrefs({ laneSize: -3 }).laneSize).toBe(0);
    expect(migratePrefs({ laneSize: 'big' }).laneSize).toBe(1);
    expect(migratePrefs({ laneSize: '2' }).laneSize).toBe(2);
    expect(migratePrefs({ rate: '0.8' }).rate).toBe(0.8);
    expect(migratePrefs({ rate: 0 }).rate).toBe(1); // 0 is not a speed: back to 100 %
    expect(migratePrefs({ rate: null }).rate).toBe(1);
  });
  it('the sound migration runs once, also for empty settings', () => {
    expect(migratePrefs({}).sound).toBe(4);
    const p = migratePrefs({ tracks: { B: { vol: 1, mute: false, solo: false, inst: 'strings' } } });
    expect(p.tracks.B.inst).toBe('strings');
    expect(p.sound).toBe(4);
  });
  it('the instruments removed in 11/2026 move to the nearest one kept (« ou » → « ah », flute and soft voice → clarinet)', () => {
    const tr = (inst: string) => ({ vol: 0.5, mute: false, solo: false, inst });
    const p = migratePrefs({ sound: 3, tracks: { S: tr('oohs'), A: tr('flute'), T: tr('synth'), B: tr('strings') } });
    expect([p.tracks.S.inst, p.tracks.A.inst, p.tracks.T.inst, p.tracks.B.inst]).toEqual(['aahs', 'clarinet', 'clarinet', 'strings']);
  });
  it('wide screens: the general volume is bounded, the track list folded or not is a yes or a no', () => {
    expect(migratePrefs({}).volume).toBeUndefined(); // never set: full volume
    expect(migratePrefs({ volume: 0.4 }).volume).toBe(0.4);
    expect(migratePrefs({ volume: 7 }).volume).toBe(1);
    expect(migratePrefs({ volume: -1 }).volume).toBe(0);
    expect(migratePrefs({ volume: 'loud' }).volume).toBe(1);
    expect(migratePrefs({}).tracksPanel).toBeUndefined(); // never touched: the screen decides
    expect(migratePrefs({ tracksPanel: false }).tracksPanel).toBe(false);
    expect(migratePrefs({ tracksPanel: 'yes' }).tracksPanel).toBeUndefined();
  });
  it('a phone lying down: the view is the line, the page or both, else not kept', () => {
    expect(migratePrefs({}).sideView).toBeUndefined(); // never chosen: the line
    for (const v of ['line', 'page', 'both']) expect(migratePrefs({ sideView: v }).sideView).toBe(v);
    expect(migratePrefs({ sideView: 'all' }).sideView).toBeUndefined();
    expect(migratePrefs({ sideView: 2 }).sideView).toBeUndefined();
  });
  it('a round trip through JSON changes nothing', () => {
    const p = migratePrefs({ part: 'B', rate: 0.75, tracks: { T: { vol: 0.6, mute: true, solo: false, inst: 'clarinet' } } });
    expect(migratePrefs(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

describe('startWorkId: the work opened at the start', () => {
  const G = 'bruckner-locus-iste';
  const list = [{ id: 'ma-partition' }, { id: G }];
  it('a new device: the example, wherever it is in the list', () => {
    expect(startWorkId(list, null)).toBe(G);
    expect(startWorkId([...list].reverse(), null)).toBe(G);
  });
  it('a device that had another work open before the example became the first: the example, once', () => {
    expect(startWorkId(list, 'ma-partition')).toBe(G);
    expect(startWorkId(list, 'ma-partition', G)).toBe('ma-partition');
  });
  it('once shown: the last work opened, if it is still there', () => {
    expect(startWorkId(list, G, G)).toBe(G);
    expect(startWorkId(list, 'gone', G)).toBe(G);
  });
  it('without the example: the last work, else the first of the list; no work: none', () => {
    expect(startWorkId([{ id: 'a' }, { id: 'b' }], null)).toBe('a');
    expect(startWorkId([{ id: 'a' }, { id: 'b' }], 'b')).toBe('b');
    expect(startWorkId([], 'a')).toBeUndefined();
  });
});
