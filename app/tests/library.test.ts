import 'fake-indexeddb/auto';
import { strToU8, zipSync } from 'fflate';
import { get, set } from '../src/pack/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importWorkZip, loadLibrary, loadWork, removeWork } from '../src/pack/library';
import { problems } from '../src/pack/validate';

const listWorks = loadLibrary;

// the smallest pack the app opens, as pipeline/publish.py zips it (files at the root of the zip):
// one movement, one voice, one measure, one note, one page
const movement = (over: Record<string, unknown> = {}) => ({
  id: 'mvt1',
  title: 'Kyrie',
  mei: 'mvt1.mei',
  parts: [{ id: 'T', name: 'Ténor', sourceName: 'Tenor', kind: 'voice', staves: [1] }],
  lyricLines: [],
  measures: [{ id: 'm1', n: '1', t: 0, q: 0, mark: null, tonic: 0, minor: false, ts: [4, 4] }],
  notes: [{ id: 'n1', part: 'T', m: 0, t: 0, d: 500, midi: 60 }],
  durationMs: 1000,
  ...over,
});
const pack = (over: Record<string, unknown> = {}) => ({
  version: 1.2,
  id: 'test-work',
  title: 'Messe brève',
  composer: 'Anonyme',
  movements: [movement()],
  pages: [{ page: 1, img: 'pages/p001.webp', w: 10, h: 10, systems: [{ top: 1, bottom: 9 }], measures: [{ mv: 'mvt1', n: 1, sys: 0, x0: 0, x1: 10, y0: 1, y1: 9 }] }],
  ...over,
});
const MEI = '<mei xmlns="http://www.music-encoding.org/ns/mei"><note xml:id="n1"/></mei>';
/** The files of a whole archive. */
const archive = (over: Record<string, unknown> = {}, files: Record<string, string | Uint8Array> = {}) => zip({ 'pack.json': JSON.stringify(pack(over)), 'mvt1.mei': MEI, 'pages/p001.webp': IMG, ...files });
const zip = (files: Record<string, string | Uint8Array>) => {
  const u = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};
const IMG = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]); // "RIFF....WEBP"

beforeAll(() => {
  // no built-in packs in these tests
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => vi.unstubAllGlobals());

describe('importWorkZip', () => {
  it('stores the pack, its texts and its images; the work is then listed and opened', async () => {
    const s = await importWorkZip(archive({ fiche: 'fiche.md' }, { 'fiche.md': '# Fiche', 'notes.txt': 'ignored' }));
    expect(s).toEqual({ id: 'test-work', title: 'Messe brève', composer: 'Anonyme' });
    expect(await get('packmeta:test-work')).toEqual(s);
    expect(await listWorks()).toContainEqual(s);
    const w = await loadWork('test-work');
    expect(w.source).toBe('imported');
    expect(w.pack.movements[0].title).toBe('Kyrie');
    expect(await w.getFile('mvt1.mei')).toBe(MEI);
    expect(await w.getFile('fiche.md')).toBe('# Fiche'); // the work's sheet travels with it
    expect(await w.getFile('pack.json')).toBe(''); // not kept twice
    expect(await w.getFile('notes.txt')).toBe('');
    expect(w.url('pages/p001.webp')).toMatch(/^blob:/);
    expect(w.url('pages/p001.webp')).toBe(w.url('pages/p001.webp')); // one object URL per image
    expect(w.url('pages/p404.webp')).toBe('');
  });
  it('accepts a Blob (a picked file) as well as bytes', async () => {
    const s = await importWorkZip(new Blob([archive({ id: 'from-blob' })]));
    expect(s.id).toBe('from-blob');
  });
  it('importing again replaces the work, also once opened', async () => {
    await importWorkZip(archive({ id: 'again', title: 'v1' }));
    expect((await loadWork('again')).pack.title).toBe('v1');
    await importWorkZip(archive({ id: 'again', title: 'v2' }));
    expect((await loadWork('again')).pack.title).toBe('v2');
    expect((await listWorks()).filter((w) => w.id === 'again')).toEqual([{ id: 'again', title: 'v2', composer: 'Anonyme' }]);
  });
  it('refuses a zip without pack.json or of another pack version, and stores nothing', async () => {
    await expect(importWorkZip(zip({ 'mvt1.mei': '<mei/>' }))).rejects.toThrow('pack.json manquant');
    await expect(importWorkZip(archive({ id: 'v2-pack', version: 2 }))).rejects.toThrow('Version de pack non prise en charge (2)');
    expect(await get('pack:v2-pack')).toBeUndefined();
    await expect(loadWork('v2-pack')).rejects.toThrow('Œuvre introuvable');
  });
  it('a damaged file is refused', async () => {
    await expect(importWorkZip(new Uint8Array([1, 2, 3, 4]).buffer)).rejects.toThrow('n’est pas une archive .zip lisible');
    await expect(importWorkZip(zip({ 'pack.json': '{"version": 1,' }))).rejects.toThrow('pack.json est illisible');
  });
  it('a folder zipped by hand (everything in one folder of the zip) is read as well', async () => {
    const inside = { 'ma-messe/pack.json': JSON.stringify(pack({ id: 'in-folder', fiche: 'fiche.md' })), 'ma-messe/mvt1.mei': MEI, 'ma-messe/fiche.md': '# Fiche', 'ma-messe/pages/p001.webp': IMG, '__MACOSX/ma-messe/._pack.json': 'x' };
    await importWorkZip(zip(inside));
    const w = await loadWork('in-folder');
    expect(await w.getFile('mvt1.mei')).toBe(MEI);
    expect(w.url('pages/p001.webp')).toMatch(/^blob:/);
  });
  it('an archive the app could not show is refused with what to correct, and nothing is stored', async () => {
    const bad = archive({ id: 'incomplete', movements: [movement({ mei: 'absent.mei' })], pages: [{ page: 7, img: 'pages/p007.webp', w: 10, h: 10, systems: [], measures: [] }] });
    await expect(importWorkZip(bad)).rejects.toThrow(/L’archive est à corriger :\n• Mouvement 1 : le fichier absent\.mei n’est pas dans l’archive\.\n• Page 7 : l’image pages\/p007\.webp n’est pas dans l’archive\./);
    expect(await get('pack:incomplete')).toBeUndefined();
  });
});

describe('problems (what an archive must hold)', () => {
  const texts = { 'mvt1.mei': MEI };
  const images = ['pages/p001.webp'];
  const of = (over: Record<string, unknown>, t: Record<string, string> = texts) => problems(pack(over), t, images);
  it('finds none in a whole pack, with or without pages, composer and sheet', () => {
    expect(of({})).toEqual([]);
    expect(of({ pages: undefined, composer: undefined })).toEqual([]);
    expect(of({ fiche: 'fiche.md' }, { ...texts, 'fiche.md': '' })).toEqual([]);
  });
  it('the work: an id usable as a key, a title, movements', () => {
    expect(problems([], texts, images)).toEqual(['pack.json ne contient pas la description d’une œuvre.']);
    expect(of({ id: 'Requiem de Fauré' })[0]).toContain('« id »');
    expect(of({ id: 'a:b' })[0]).toContain('« id »'); // the id is part of storage keys
    expect(of({ title: '' })[0]).toContain('« title »');
    expect(of({ movements: [] })).toEqual(['« movements » : l’œuvre n’a aucun mouvement.']);
    expect(of({ fiche: 'fiche.md' })).toEqual(['La fiche fiche.md n’est pas dans l’archive.']);
  });
  it('a movement: its MEI file, its parts, its measures, a duration', () => {
    const mv = (over: Record<string, unknown>, t = texts) => of({ movements: [movement(over)] }, t);
    expect(mv({ mei: 'mvt1.mei' }, { 'mvt1.mei': '<score-partwise/>' })).toEqual(['Mouvement 1 : mvt1.mei n’est pas un fichier MEI.']);
    expect(mv({ parts: [] })[0]).toBe('Mouvement 1 : aucune voix ni instrument (« parts »).');
    expect(mv({ parts: [{ id: 'T', name: 'Ténor', kind: 'choir', staves: [1] }] })[0]).toContain('une partie est mal décrite');
    expect(mv({ measures: [] })[0]).toBe('Mouvement 1 : aucune mesure (« measures »).');
    expect(mv({ durationMs: 0 })).toEqual(['Mouvement 1 : « durationMs » (la durée) manque.']);
    expect(of({ movements: [movement(), movement()] })).toEqual(['Mouvement 2 : l’identifiant « mvt1 » sert déjà à un autre mouvement.']);
  });
  it('the notes: a part and a measure of the movement, a note drawn in the MEI', () => {
    const notes = (...n: Record<string, unknown>[]) => of({ movements: [movement({ notes: n })] });
    const n1 = { id: 'n1', part: 'T', m: 0, t: 0, d: 500, midi: 60 };
    expect(notes()).toEqual([]); // a movement of rests
    expect(notes({ ...n1, part: 'B' })).toEqual(['Mouvement 1 : 1 note mal décrite (id, part, m, t, d, midi).']);
    expect(notes({ ...n1, m: 1 }, { ...n1, midi: null })).toEqual(['Mouvement 1 : 2 notes mal décrites (id, part, m, t, d, midi).']);
    expect(notes(n1, { ...n1, id: 'n2' })).toEqual(['Mouvement 1 : 1 note absente de mvt1.mei (pack.json et le fichier MEI ne vont pas ensemble).']);
  });
  it('the pages: an image of the archive, boxes of known movements and systems', () => {
    const page = (over: Record<string, unknown>) => of({ pages: [{ ...pack().pages[0], ...over }] });
    expect(page({ img: 'pages/p002.webp' })).toEqual(['Page 1 : l’image pages/p002.webp n’est pas dans l’archive.']);
    expect(page({ w: 0 })[0]).toContain('page mal décrite');
    expect(page({ measures: [{ mv: 1, n: 1, sys: 0, x0: 0, x1: 10, y0: 1, y1: 9 }] })[0]).toContain('une case de mesure est mal décrite'); // mv: the movement's id, not its number
    expect(page({ measures: [{ mv: 'mvt1', n: 1, sys: 1, x0: 0, x1: 10, y0: 1, y1: 9 }] })[0]).toContain('une case de mesure est mal décrite');
  });
  it('a long list is cut', () => {
    const many = of({ pages: undefined, movements: Array.from({ length: 12 }, (_, i) => movement({ id: `m${i}`, mei: 'absent.mei' })) });
    expect(many).toHaveLength(9);
    expect(many[8]).toBe('… et 4 autres.');
  });
});

describe('removeWork', () => {
  it('removes the work, its recordings and its text progress; other works are kept', async () => {
    await importWorkZip(archive({ id: 'to-remove' }));
    await importWorkZip(archive({ id: 'to-remove-2' }));
    await set('take:to-remove:mvt1', { pcm: 1 });
    await set('take:to-remove-2:mvt1', { pcm: 2 });
    await loadWork('to-remove');
    expect(await removeWork('to-remove')).toBe(false); // no built-in work of that id
    expect(await get('pack:to-remove')).toBeUndefined();
    expect(await get('packmeta:to-remove')).toBeUndefined();
    expect(await get('take:to-remove:mvt1')).toBeUndefined();
    expect(await get('take:to-remove-2:mvt1')).toEqual({ pcm: 2 });
    expect((await listWorks()).map((w) => w.id)).not.toContain('to-remove');
    expect((await listWorks()).map((w) => w.id)).toContain('to-remove-2');
    await expect(loadWork('to-remove')).rejects.toThrow('Œuvre introuvable');
  });
  it('an imported work hides the built-in one of the same id until it is removed', async () => {
    const builtin = pack({ id: 'shipped', title: 'Livrée avec l’app' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(url.endsWith('index.json') ? JSON.stringify({ packs: [{ id: 'shipped', dir: 'shipped', title: builtin.title, composer: '' }] }) : JSON.stringify(builtin))),
    );
    try {
      await importWorkZip(archive({ id: 'shipped', title: 'La mienne' }));
      expect((await listWorks()).filter((w) => w.id === 'shipped')).toHaveLength(1);
      expect((await loadWork('shipped')).source).toBe('imported');
      expect((await loadWork('shipped')).pack.title).toBe('La mienne');
      expect(await removeWork('shipped')).toBe(true);
      expect((await loadWork('shipped')).source).toBe('builtin');
      expect((await loadWork('shipped')).pack.title).toBe('Livrée avec l’app');
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    }
  });
});

