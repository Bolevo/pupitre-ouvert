import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { noteName } from '../src/audio/notes';
import { en } from '../src/i18n-en';
import { helpPage, lang, partLabel, tt } from '../src/i18n';
import { problems } from '../src/pack/validate';
import { clefWords, keyLabel, shortKeyName, signatureWords } from '../src/score/info';

afterEach(() => (lang.value = 'fr'));

/** Every text of the code: the first argument of `tt(…)` and of `ttKey(…)`, a plain string. */
function textsOfTheCode(): Map<string, string> {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.tsx?$/.test(e.name) && !e.name.startsWith('i18n')) {
        const code = readFileSync(`${dir}/${e.name}`, 'utf8');
        for (const m of code.matchAll(/\b(?:tt|ttKey)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g)) found.set(new Function(`return ${m[1]}`)() as string, e.name);
      }
    }
  };
  walk(src);
  return found;
}
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('the English of the app', () => {
  const texts = textsOfTheCode();
  it('every text of the code has its English', () => {
    expect(texts.size).toBeGreaterThan(300);
    expect([...texts.keys()].filter((fr) => !(fr in en))).toEqual([]);
  });
  it('no English text is left without a use', () => {
    expect(Object.keys(en).filter((fr) => !texts.has(fr))).toEqual([]);
  });
  it('an English text takes the same values as its French', () => {
    for (const [fr, english] of Object.entries(en)) expect(holes(english), fr).toEqual(holes(fr));
  });
  it('no English text is empty, none keeps French quotation marks', () => {
    for (const [fr, english] of Object.entries(en)) {
      expect(english.trim(), fr).not.toBe('');
      expect(english, fr).not.toMatch(/[«»]| [:;!]/); // (« ? » alone can be a key of the keyboard)
    }
  });
});

describe('tt', () => {
  it('French is the text itself; English its translation; values are put in', () => {
    expect(tt('Suivre {name}', { name: 'Alto' })).toBe('Suivre Alto');
    lang.value = 'en';
    expect(tt('Suivre {name}', { name: 'Alto' })).toBe('Follow Alto');
    expect(tt('Volume {n} %', { n: 80 })).toBe('Volume 80%');
    expect(tt('un texte sans anglais')).toBe('un texte sans anglais'); // never empty: the French, at worst
  });
  it('the help opened is the one in the language shown', () => {
    expect(helpPage()).toBe('aide.html');
    lang.value = 'en';
    expect(helpPage()).toBe('help.html');
  });
});

describe('what the archives name in French, shown in English', () => {
  it('the voices', () => {
    expect(partLabel('Ténor')).toBe('Ténor');
    lang.value = 'en';
    expect(['Soprano', 'Alto', 'Ténor', 'Basse', 'Ténor 2', 'Basse 1', 'Piano', 'Voix'].map(partLabel)).toEqual(['Soprano', 'Alto', 'Tenor', 'Bass', 'Tenor 2', 'Bass 1', 'Piano', 'Voix']);
  });
  it('the keys', () => {
    expect(keyLabel('si mineur')).toBe('si mineur');
    lang.value = 'en';
    expect(['si mineur', 'Ré♭ majeur', 'fa dièse mineur', 'Mi b majeur', 'Do majeur', 'sol# mineur', 'mode de ré'].map(keyLabel)).toEqual(['B minor', 'D♭ major', 'F♯ minor', 'E♭ major', 'C major', 'G♯ minor', 'mode de ré']);
    expect(shortKeyName(keyLabel('Ré♭ majeur'))).toBe('D♭ maj.');
  });
  it('the notes: the same note is la3 in French, A4 in English', () => {
    expect([69, 60, 61, 58].map(noteName)).toEqual(['la3', 'do3', 'do♯3', 'si♭2']);
    lang.value = 'en';
    expect([69, 60, 61, 58].map(noteName)).toEqual(['A4', 'C4', 'C♯4', 'B♭3']);
  });
  it('signatures and clefs', () => {
    lang.value = 'en';
    expect([0, 1, 3, -1, -5].map(signatureWords)).toEqual(['no sharps or flats', '1 sharp', '3 sharps', '1 flat', '5 flats']);
    expect(clefWords({ m: 0, sign: 'G', line: 2, octave: -1 })).toBe('Treble clef, an octave lower');
    expect(clefWords({ m: 0, sign: 'C', line: 3 })).toBe('C clef on line 3');
  });
  it('what is wrong with an archive', () => {
    lang.value = 'en';
    expect(problems({ version: 1, id: 'x', title: 'T', movements: [] }, {}, [])).toEqual(['“movements”: the work has no movement.']);
    expect(problems({ version: 2 }, {}, [])).toEqual(['Archive version not supported (2): this app reads version 1.']);
  });
});
