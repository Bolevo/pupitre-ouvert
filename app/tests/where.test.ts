import { afterEach, describe, expect, it } from 'vitest';
import { lang } from '../src/i18n';
import type { Movement, Pack, PackNote } from '../src/pack/types';
import { chtPitch, measureNotes, placeAt, whereText } from '../src/score/where';

afterEach(() => (lang.value = 'fr'));

// three measures in 4/4 at 60 to the quarter (1000 ms each); the tenor: a dotted half and a quarter;
// a half rest, a quarter, two notes together held over the barline; then a rest, an eighth, a rest
const note = (part: string, m: number, t: number, d: number, midi: number, sp?: string): PackNote => ({ id: `n${t}-${midi}`, part, m, t, d, midi, ...(sp ? { sp } : {}) });
const measure = (i: number) => ({ id: `m${i}`, n: String(i + 1), t: i * 4000, q: i * 4, mark: null, tonic: 7, minor: false, fifths: 1, ts: [4, 4] as [number, number] });
const mv: Movement = {
  id: 'mvt1',
  title: 'Kyrie',
  mei: 'mvt1.mei',
  parts: [
    { id: 'S', name: 'Soprano', sourceName: 'Soprano', kind: 'voice', staves: [1] },
    { id: 'T', name: 'Ténor', sourceName: 'Tenor', kind: 'voice', staves: [2] },
    { id: 'P', name: 'Piano', sourceName: 'Piano', kind: 'accomp', staves: [3, 4] },
  ],
  lyricLines: [],
  measures: [measure(0), measure(1), measure(2)],
  notes: [
    note('T', 0, 0, 3000, 55, 'sol'),
    note('T', 0, 3000, 1000, 55, 'sol'),
    note('T', 1, 6000, 1000, 54, 'fas'),
    note('T', 1, 7000, 2000, 57, 'la'),
    note('T', 1, 7000, 2000, 61, 'dos'),
    note('T', 2, 10000, 500, 58, 'sib'),
    note('P', 1, 4000, 1000, 43),
    note('P', 1, 5000, 1000, 50),
  ],
  durationMs: 12000,
  keys: [{ m: 0, name: 'sol majeur' }],
};
const pack: Pack = {
  version: 1,
  id: 'messe-breve',
  title: 'Messe brève',
  composer: 'Anonyme',
  movements: [mv, { ...mv, id: 'mvt2', title: 'Gloria' }],
  pages: [
    { page: 11, img: 'pages/p011.webp', w: 10, h: 10, systems: [{ top: 1, bottom: 9 }], measures: [{ mv: 'mvt1', n: 1, sys: 0, x0: 0, x1: 10, y0: 1, y1: 9 }] },
    { page: 12, img: 'pages/p012.webp', w: 10, h: 10, systems: [{ top: 1, bottom: 9 }], measures: [{ mv: 'mvt2', n: 2, sys: 0, x0: 0, x1: 5, y0: 1, y1: 9 }, { mv: 'mvt1', n: 2, sys: 0, x0: 5, x1: 10, y0: 1, y1: 9 }] },
  ],
};

describe('a note as the transcription writes it', () => {
  it('spelled as the score spells it, c4 being middle C', () => {
    expect(chtPitch({ midi: 60, sp: 'do' })).toBe('c4');
    expect(chtPitch({ midi: 66, sp: 'fas' })).toBe('f#4');
    expect(chtPitch({ midi: 66, sp: 'solb' })).toBe('gb4');
    expect(chtPitch({ midi: 58, sp: 'sib' })).toBe('bb3');
    expect(chtPitch({ midi: 50, sp: 're' })).toBe('d3');
  });
  it('the octave is that of the written note: si dièse under do, do bémol over si; a double sharp', () => {
    expect(chtPitch({ midi: 60, sp: 'sis' })).toBe('b#3');
    expect(chtPitch({ midi: 59, sp: 'dob' })).toBe('cb4');
    expect(chtPitch({ midi: 67, sp: 'fas' })).toBe('f##4');
  });
  it('without its spelling (an older archive): by its sound', () => {
    expect(chtPitch({ midi: 70 })).toBe('bb4');
    expect(chtPitch({ midi: 61 })).toBe('c#4');
    expect(chtPitch({ midi: 69, sp: '?' })).toBe('a4');
  });
});

describe('what a voice holds in a measure', () => {
  it('its notes with their lengths in quarters', () => {
    expect(measureNotes(mv, 0, 'T')).toBe('g3 (3), g3 (1)');
  });
  it('rests where nothing sounds, notes struck together as a chord', () => {
    expect(measureNotes(mv, 1, 'T')).toBe('r (2), f#3 (1), <a3 c#4> (2)');
  });
  it('a note held from the measure before, and what is left of it', () => {
    expect(measureNotes(mv, 2, 'T')).toBe('~<a3 c#4> (1), r (1), bb3 (0.5), r (1.5)');
  });
  it('a voice that is silent: nothing', () => {
    expect(measureNotes(mv, 0, 'S')).toBe('');
  });
});

describe('where one is', () => {
  it('the measure sounding, its printed number, the page that shows it in this movement', () => {
    expect(placeAt(pack, mv, 0)).toEqual({ index: 0, n: '1', page: 11 });
    expect(placeAt(pack, mv, 4500)).toEqual({ index: 1, n: '2', page: 12 });
    expect(placeAt(pack, mv, 11999)).toEqual({ index: 2, n: '3', page: null }); // no box for it
    expect(placeAt({ ...pack, pages: undefined }, mv, 4500).page).toBeNull();
    expect(placeAt(pack, mv, 99999).index).toBe(2);
  });
  it('the text copied says the work, the place, the voice, the notes of each voice and how to correct', () => {
    expect(whereText(pack, mv, 4500, 'T').split('\n')).toEqual([
      'Pupitre Ouvert : où j’en suis dans la partition',
      'Œuvre : Messe brève (Anonyme)',
      'Mouvement : Kyrie',
      'Mesure 2, page 12 de la partition',
      'Voix suivie : Ténor',
      'Tonalité : sol majeur ; mesure à 4/4',
      'Archive : messe-breve, mouvement mvt1',
      '',
      'Ce que l’archive contient à cette mesure, écrit comme dans la transcription (c4 = do central ; entre parenthèses, la durée en noires ; r = silence ; ~ = note tenue depuis la mesure précédente) :',
      'S (Soprano) : rien',
      'T (Ténor) : r (2), f#3 (1), <a3 c#4> (2)',
      'P (Piano) : 2 notes',
      '',
      'Pour corriger l’archive : section « Corriger une archive » de https://bolevo.github.io/pupitre-ouvert/creer.html (il faut le fichier .zip de l’œuvre).',
      '',
      'Ce qui ne va pas à cet endroit : ',
    ]);
  });
  it('a work of one movement, without pages or key names: the lines that have nothing to say are left out', () => {
    const lone = { ...mv, keys: undefined };
    const text = whereText({ ...pack, composer: '', movements: [lone], pages: undefined }, lone, 0, 'X').split('\n');
    expect(text.slice(0, 5)).toEqual(['Pupitre Ouvert : où j’en suis dans la partition', 'Œuvre : Messe brève', 'Mesure 1', 'Mesure à 4/4', 'Archive : messe-breve, mouvement mvt1']);
  });
  it('in English when the app is', () => {
    lang.value = 'en';
    const text = whereText(pack, mv, 4500, 'T').split('\n');
    expect(text.slice(0, 7)).toEqual(['Pupitre Ouvert: where I am in the score', 'Work: Messe brève (Anonyme)', 'Movement: Kyrie', 'Bar 2, page 12 of the score', 'Voice followed: Tenor', 'Key: G major; time signature 4/4', 'Archive: messe-breve, movement mvt1']);
    expect(text[10]).toBe('T (Tenor): r (2), f#3 (1), <a3 c#4> (2)');
    expect(text[13]).toContain('https://bolevo.github.io/pupitre-ouvert/create.html');
    expect(text.at(-1)).toBe('What is wrong here: ');
  });
});
