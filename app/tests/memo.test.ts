import { describe, expect, it } from 'vitest';
import { cueShown, Drill, effectiveLevel, HELP, isBetter, MAX_LEVEL, MISS, nextLevel, OK, PENDING } from '../src/memo/drill';
import { lineText, norm, parseFiche, sectionNumber, words } from '../src/memo/text';

// two sheets written for these tests, in the manner of a work's fiche.md: a Latin mass in
// several movements (one of them sung by soloists: no movement to play; another begun by a
// soloist), and a Russian poem with its transcription for French readers
const LATIN = `## 1 · Gloria in excelsis Deo

[Jouer ce mouvement](#mv:mvt1)

Allegro, noire = 120. Ré majeur, 4/4, 72 mesures.

**Gloria in excelsis Deo.**\\
*Gloire à Dieu au plus haut des cieux.*

## 3 · Laudamus te

Duo de sopranos, noire = 100. Sol majeur, 2/4.

**Laudamus te, benedicimus te.**\\
*Nous te louons, nous te bénissons.*

## 4 · Gratias agimus tibi

[Jouer ce mouvement](#mv:mvt4)

Adagio, noire = 60. mi mineur, 4/4, 6 mesures.

**Gratias agimus tibi**

## 8 · Domine Deus, Agnus Dei

[Jouer ce mouvement](#mv:mvt8)

Adagio, noire = 42. ré mineur, 4/4, 40 mesures.

Alto solo :

**Domine Deus, Agnus Dei, Filius Patris,**\\
*Seigneur Dieu, Agneau de Dieu, Fils du Père,*

Chœur :

**qui tollis peccata mundi,**\\
*toi qui enlèves les péchés du monde,*

**miserere nobis.**\\
*prends pitié de nous.*

## 12 · Cum Sancto Spiritu

[Jouer ce mouvement](#mv:mvt12)

Allegro, noire = 120. Ré majeur, 4/4, 86 mesures.

**Cum Sancto Spiritu in gloria Dei Patris.**\\
*Avec le Saint-Esprit, dans la gloire de Dieu le Père.*

**Amen.**
`;
const RUSSIAN = `## I · Adagio

[Jouer ce mouvement](#mv:mvt1)

Adagio, noire = 60. fa♯ mineur, 4/4, 182 mesures.

**Иду в неведомый мне путь,**\\
idou v niévièdomyï mnié pout'\\
*Je m'en vais sur un chemin qui m'est inconnu,*

**иду меж страха и надежды;**\\
idou mièj strakha i nadièjdy\\
*je m'en vais entre crainte et espérance ;*

## II · Andante

[Jouer ce mouvement](#mv:mvt2)

Andante, noire = 72. ré♭ majeur, 3/4, 47 mesures.

**Но вечным сном пока я сплю,**\\
no viétchnym snom paka ia spliou\\
*Mais tandis que je dors de l'éternel sommeil,*

## Notes de l'édition

Rien à jouer ni à apprendre ici.

**Ceci n'est pas un texte chanté.**
`;

describe('sheet text (fiche.md → lines to learn)', () => {
  const viv = parseFiche(LATIN);
  const tan = parseFiche(RUSSIAN);

  it('only the choir movements (the ones with « Jouer ce mouvement »), in order', () => {
    expect(viv.map((s) => s.mv)).toEqual(['mvt1', 'mvt4', 'mvt8', 'mvt12']);
    expect(viv[0].title).toBe('1 · Gloria in excelsis Deo');
    expect(tan.map((s) => s.mv)).toEqual(['mvt1', 'mvt2']);
  });

  it('text and translation; the information line is not text', () => {
    expect(viv[0].lines).toEqual([{ id: 'mvt1:gloriainexcelsisdeo', text: 'Gloria in excelsis Deo.', tr: 'Gloire à Dieu au plus haut des cieux.' }]);
    const gratias = viv.find((s) => s.mv === 'mvt4')!;
    expect(gratias.lines.map((l) => l.text)).toEqual(['Gratias agimus tibi']);
    // the last line of the work has no translation
    expect(viv[viv.length - 1].lines.map((l) => [l.text, l.tr])).toEqual([
      ['Cum Sancto Spiritu in gloria Dei Patris.', 'Avec le Saint-Esprit, dans la gloire de Dieu le Père.'],
      ['Amen.', undefined],
    ]);
  });

  it('solo lines are skipped (n° 8: alto solo, then the choir)', () => {
    const n8 = viv.find((s) => s.mv === 'mvt8')!;
    expect(n8.lines.map((l) => l.text)).toEqual(['qui tollis peccata mundi,', 'miserere nobis.']);
  });

  it('several bold spans on a line are joined', () => {
    const md = '## 8 · X\n\n[Jouer ce mouvement](#mv:m8)\n\n**Domine Deus, Rex coelestis,** · **Domine Fili unigenite,**\\\n*Seigneur Dieu, Roi du ciel,* · *Seigneur, Fils unique,*\n';
    const [s] = parseFiche(md);
    expect(s.lines[0].text).toBe('Domine Deus, Rex coelestis, Domine Fili unigenite,');
    expect(s.lines[0].tr).toBe('Seigneur Dieu, Roi du ciel, Seigneur, Fils unique,');
    expect(words(s.lines[0].text).map((w) => w.key)).toEqual(['domine', 'deus', 'rex', 'coelestis', 'domine', 'fili', 'unigenite']);
  });

  it('a text in another script: the text, its phonetic transcription and the translation', () => {
    expect(tan[0].lines).toHaveLength(2);
    expect(tan[1].lines).toHaveLength(1);
    const l = tan[0].lines[0];
    expect(l.text).toBe('Иду в неведомый мне путь,');
    expect(l.phon).toBe("idou v niévièdomyï mnié pout'");
    expect(l.tr).toBe("Je m'en vais sur un chemin qui m'est inconnu,");
    expect(tan.every((s) => s.lines.every((x) => x.phon && x.tr))).toBe(true);
    expect(words(lineText(l, 'phon')).map((w) => w.key)).toEqual(['idou', 'v', 'nieviedomyi', 'mnie', 'pout']);
    expect(lineText(l, 'text')).toBe(l.text);
    // a section at the end of the sheet without a movement to play: nothing to learn
    expect(tan.map((s) => s.mv)).toEqual(['mvt1', 'mvt2']);
  });

  it('the number of a movement, without its words (the test)', () => {
    expect(viv.map((x, k) => sectionNumber(x.title, k))).toEqual(['1', '4', '8', '12']);
    expect(tan.map((x, k) => sectionNumber(x.title, k))).toEqual(['I', 'II']);
    expect(sectionNumber('Gloria', 4)).toBe('5');
    expect(sectionNumber('n° 3 · Laudamus', 0)).toBe('3');
  });

  it('a repeated line keeps a distinct id', () => {
    const [s] = parseFiche('## A\n[Jouer ce mouvement](#mv:a)\n\n**Amen.**\n\n**Amen.**\n');
    expect(s.lines.map((l) => l.id)).toEqual(['a:amen', 'a:amen#2']);
  });
});

describe('typed letters', () => {
  it('case, accents, ligatures, punctuation and modifier letters are not typed', () => {
    expect(norm('Ésprit,')).toBe('esprit');
    expect(norm('cœur')).toBe('coeur');
    expect(norm('Æterna')).toBe('aeterna');
    expect(norm('poutᶜʰ')).toBe('pout');
    expect(norm('ещё')).toBe('еще');
    expect(norm("t'adorons")).toBe('tadorons');
    expect(norm('tout-puissant.')).toBe('toutpuissant');
    expect(norm('«')).toBe('');
    expect(words('Domine Deus, — Rex · coelestis').map((w) => w.shown)).toEqual(['Domine', 'Deus,', 'Rex', 'coelestis']);
  });
});

describe('levels of help (vanishing cues) and spacing', () => {
  it('one level per movement: up from 95 % of the words right, down below 80 %', () => {
    expect(MAX_LEVEL).toBe(3);
    expect(HELP).toHaveLength(MAX_LEVEL + 1);
    expect(nextLevel(0, 35, 35)).toBe(1);
    expect(nextLevel(1, 34, 35)).toBe(2); // 97 %
    expect(nextLevel(3, 35, 35)).toBe(3);
    expect(nextLevel(2, 3, 3)).toBe(3);
    expect(nextLevel(2, 2, 3)).toBe(1); // 67 %: one of three words missed
    expect(nextLevel(2, 30, 35)).toBe(2); // 86 %
    expect(nextLevel(2, 27, 35)).toBe(1); // 77 %
    expect(nextLevel(0, 0, 35)).toBe(0);
  });
  it('cues by level: every word, every other word through the movement, the first of each line, none', () => {
    // two lines of 3 words: places 0..2 and 3..5 in the movement
    const shown = (lvl: number) => [0, 1, 2, 3, 4, 5].map((i) => cueShown(lvl, i, i === 0 || i === 3));
    expect(shown(0).every(Boolean)).toBe(true);
    expect(shown(1)).toEqual([true, false, true, false, true, false]); // regular, across the lines
    expect(shown(2)).toEqual([true, false, false, true, false, false]);
    expect(shown(3).some(Boolean)).toBe(false);
  });
  it('a level not practised for a while drops by one', () => {
    const day = 86_400_000;
    const now = 100 * day;
    expect(effectiveLevel(undefined, now)).toBe(0);
    expect(effectiveLevel({ l: 1, at: now - 0.5 * day }, now)).toBe(1);
    expect(effectiveLevel({ l: 1, at: now - 2 * day }, now)).toBe(0);
    expect(effectiveLevel({ l: 2, at: now - 2 * day }, now)).toBe(2);
    expect(effectiveLevel({ l: 2, at: now - 4 * day }, now)).toBe(1);
    expect(effectiveLevel({ l: 3, at: now - 5 * day }, now)).toBe(3);
    expect(effectiveLevel({ l: 3, at: now - 8 * day }, now)).toBe(2);
    expect(effectiveLevel({ l: 9, at: now }, now)).toBe(3);
  });
  it('best score: more accurate, or as accurate and faster', () => {
    expect(isBetter(0.9, 5000, undefined)).toBe(true);
    expect(isBetter(0.95, 9000, { acc: 0.9, ms: 5000 })).toBe(true);
    expect(isBetter(0.9, 4000, { acc: 0.9, ms: 5000 })).toBe(true);
    expect(isBetter(0.9, 6000, { acc: 0.9, ms: 5000 })).toBe(false);
  });
});

describe('a run through the text', () => {
  const line = (id: string, s: string) => ({ id, words: words(s) });
  let t = 0;
  const clock = () => (t += 1000);

  it('« Initiales »: one key per word; a wrong key, then a second one reveals the word', () => {
    const d = new Drill([line('a', 'Gratias agimus tibi'), line('b', 'Amen.')], 'initials', clock);
    expect(d.input('G')).toEqual({ kind: 'ok', lineDone: false, end: false });
    expect(d.input('x')).toEqual({ kind: 'wrong' });
    expect(d.input('-')).toEqual({ kind: 'none' });
    expect(d.input('y').kind).toBe('miss'); // second wrong key: agimus is shown
    expect(d.input('t')).toEqual({ kind: 'ok', lineDone: true, end: false });
    expect(d.missesOf(0)).toBe(1);
    expect(Array.from(d.marks[0])).toEqual([OK, MISS, OK]);
    expect(d.input('?')).toEqual({ kind: 'miss', lineDone: true, end: true });
    expect(d.done).toBe(true);
    expect(d.ok).toBe(2);
    expect(d.miss).toBe(2);
    expect(d.accuracy).toBe(0.5);
    expect(d.elapsed).toBeGreaterThan(0);
    expect(d.input('a')).toEqual({ kind: 'none' });
  });

  it('« Initiales »: accents and case do not matter; right at the second try restarts the streak', () => {
    const d = new Drill([line('a', 'Ésprit Eau eau')], 'initials');
    expect(d.input('e').kind).toBe('ok');
    expect(d.streak).toBe(1);
    expect(d.input('É').kind).toBe('ok');
    expect(d.streak).toBe(2);
    expect(d.input('z').kind).toBe('wrong');
    expect(d.input('E').kind).toBe('ok');
    expect(d.streak).toBe(0);
    expect(d.bestStreak).toBe(2);
    expect(d.missesOf(0)).toBe(0);
  });

  it('« Mots »: the word is taken as soon as it is complete; Backspace; a space only validates letters typed', () => {
    const d = new Drill([line('a', "qui tollis peccata-mundi, t'adorons")], 'words');
    for (const c of 'qu') expect(d.input(c).kind).toBe('typed');
    expect(d.input('i')).toEqual({ kind: 'ok', lineDone: false, end: false });
    expect(d.input(' ')).toEqual({ kind: 'none' }); // the habit of a space after a word
    expect(d.input('t').kind).toBe('typed');
    expect(d.input('a').kind).toBe('wrong'); // shown in red, kept
    expect(d.typed).toBe('ta');
    expect(d.input('o').kind).toBe('wrong'); // not taken: the wrong letter first
    expect(d.typed).toBe('ta');
    expect(d.typedRight).toBe(false);
    expect(d.backspace().kind).toBe('typed');
    for (const c of 'olli') d.input(c);
    expect(d.input('s').kind).toBe('ok');
    expect(d.streak).toBe(0); // a typo corrected: not an error, the streak restarts
    for (const c of 'peccata') d.input(c);
    expect(d.input('-').kind).toBe('none');
    for (const c of 'mund') d.input(c);
    expect(d.input('i').kind).toBe('ok');
    expect(d.input('t').kind).toBe('typed');
    expect(d.input(' ').kind).toBe('miss'); // validated too early
    expect(d.done).toBe(true);
    expect(Array.from(d.marks[0])).toEqual([OK, OK, OK, MISS]);
  });

  it('a mode switch goes on from the start of the line: words typed and missed stay, no record', () => {
    const lines = [line('a', 'Gloria in excelsis'), line('b', 'Amen')];
    const a = new Drill(lines, 'initials', clock);
    a.input('g');
    a.input('?'); // « in » missed
    a.input('e');
    a.input('x'); // a wrong key on « Amen »
    const b = new Drill(lines, 'words', clock, a);
    expect(b.mode).toBe('words');
    expect(b.li).toBe(1);
    expect(b.wi).toBe(0);
    expect(Array.from(b.marks[0])).toEqual([OK, MISS, OK]); // the miss is not lost
    expect([b.ok, b.miss, b.position]).toEqual([2, 1, 3]);
    expect(b.fromStart).toBe(false);
    for (const c of 'amen') b.input(c);
    expect(b.done).toBe(true);
    expect(b.accuracy).toBe(0.75);
    // switching before any word typed: still a whole run
    expect(new Drill(lines, 'words', clock, new Drill(lines, 'initials', clock)).fromStart).toBe(true);
  });

  it('jumping to a line: back (typed again) or ahead (skipped), after the end too; never a record', () => {
    const lines = [line('a', 'Gratias agimus'), line('b', 'tibi'), line('c', 'Amen')];
    const d = new Drill(lines, 'initials', clock);
    d.input('g');
    d.input('x');
    d.input('y'); // agimus missed
    d.input('t');
    expect([d.li, d.ok, d.miss]).toEqual([2, 2, 1]);
    d.jumpTo(0); // the first line again: its marks and those after it are cleared
    expect([d.li, d.wi, d.ok, d.miss, d.streak]).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(d.marks[1])).toEqual([PENDING]);
    expect(d.fromStart).toBe(false);
    d.jumpTo(2); // ahead: lines a and b stay pending (not counted)
    expect(d.input('a')).toEqual({ kind: 'ok', lineDone: true, end: true });
    expect([d.ok, d.miss, d.count]).toEqual([1, 0, 1]);
    d.jumpTo(1); // after the end: the run goes on
    expect(d.done).toBe(false);
    expect(d.input('t').kind).toBe('ok');
    expect(d.input('a')).toEqual({ kind: 'ok', lineDone: true, end: true });
    expect(d.count).toBe(2);
    d.jumpTo(99); // out of range: the last line
    expect(d.li).toBe(2);
  });
});
