import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { unpackZip } from '../src/pack/unpack';
import { withWork } from '../src/pack/library';

// the smallest pack the app opens (tests/library.test.ts checks what makes one acceptable)
const note = { id: 'n1', part: 'T', m: 0, t: 0, d: 500, midi: 60 };
const movement = { id: 'mvt1', title: 'Kyrie', mei: 'mvt1.mei', parts: [{ id: 'T', name: 'Ténor', sourceName: 'Tenor', kind: 'voice', staves: [1] }], lyricLines: [], measures: [{ id: 'm1', n: '1', t: 0, q: 0, mark: null, tonic: 0, minor: false, ts: [4, 4] }], notes: [note], durationMs: 1000 };
const pack = (version = 1) => ({ version, id: 'w', title: 'Titre', composer: 'Compositeur', movements: [movement] });
const MEI = '<mei><note xml:id="n1">é</note></mei>';

describe('unpackZip', () => {
  it('splits a pack zip into pack, texts and images', () => {
    const zip = zipSync({
      'pack.json': strToU8(JSON.stringify(pack())),
      'mvt1.mei': strToU8(MEI),
      'pages/p001.webp': new Uint8Array([1, 2, 3]),
      'pages/p002.JPG': new Uint8Array([1, 2]),
      'notes.txt': strToU8('ignored'),
    });
    const sp = unpackZip(zip);
    expect(sp.pack.title).toBe('Titre');
    expect(sp.texts).toEqual({ 'mvt1.mei': MEI }); // pack.json itself is not kept as text
    expect(Object.keys(sp.blobs)).toEqual(['pages/p001.webp', 'pages/p002.JPG']);
    expect(sp.blobs['pages/p001.webp'].type).toBe('image/webp');
    expect(sp.blobs['pages/p001.webp'].size).toBe(3);
    expect(sp.blobs['pages/p002.JPG'].type).toBe('image/jpeg');
  });

  it('accepts packs carrying fields the app no longer reads (older packs)', () => {
    const old = { ...pack(1.2), movements: [{ ...movement, tempos: [], phrases: {}, notes: [{ ...note, staff: 1, layer: 1, q: 0, dq: 1, syl: {} }] }] };
    expect(unpackZip(zipSync({ 'pack.json': strToU8(JSON.stringify(old)), 'mvt1.mei': strToU8(MEI) })).pack.id).toBe('w');
  });

  it('refuses an unknown major version and a zip without pack.json', () => {
    expect(() => unpackZip(zipSync({ 'pack.json': strToU8(JSON.stringify(pack(2))) }))).toThrow(/Version de pack/);
    expect(() => unpackZip(zipSync({ 'mvt1.mei': strToU8('<mei/>') }))).toThrow(/pack.json manquant/);
  });
});

describe('withWork', () => {
  const a = { id: 'a', title: 'A', composer: '' };
  const b = { id: 'b', title: 'B', composer: '' };
  it('appends a new work, replaces an updated one in place', () => {
    expect(withWork([a], b)).toEqual([a, b]);
    expect(withWork([a, b], { ...a, title: 'A2' })).toEqual([{ ...a, title: 'A2' }, b]);
    expect([a, b].reduce(withWork, [] as (typeof a)[])).toEqual([a, b]);
  });
});
