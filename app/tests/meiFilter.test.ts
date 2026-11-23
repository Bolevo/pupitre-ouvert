// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { airySyllables, filterMei } from '../src/score/meiFilter';

const MEI = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
 <music><body><mdiv><score>
  <scoreDef><staffGrp symbol="bracket"><label>Choir</label>
    <staffDef n="1" lines="5"/><staffDef n="2" lines="5"/><staffDef n="3" lines="5"/>
  </staffGrp></scoreDef>
  <section><measure n="1" xml:id="m1">
    <staff n="1"><layer n="1"><note xml:id="a" pname="c" oct="4" dur="4"><verse n="1"><syl>la</syl></verse><verse n="2"><syl>ля</syl></verse></note></layer></staff>
    <staff n="2"><layer n="1"><note xml:id="b" pname="e" oct="4" dur="4"/></layer></staff>
    <staff n="3"><layer n="1"><note xml:id="c" pname="g" oct="3" dur="4"/></layer></staff>
    <tempo staff="1" tstamp="1">Adagio</tempo>
    <reh staff="1" tstamp="1">A</reh>
    <dynam staff="1 2" tstamp="1">p</dynam>
    <tie startid="#a" endid="#b"/>
    <slur startid="#b" endid="#c"/>
  </measure></section>
 </score></mdiv></body></music></mei>`;

const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const tags = (d: Document, t: string) => Array.from(d.getElementsByTagName(t));

describe('filterMei', () => {
  it('keeps only the chosen staves, their ids unchanged', () => {
    const d = parse(filterMei(MEI, [2], null));
    expect(tags(d, 'staffDef').map((e) => e.getAttribute('n'))).toEqual(['2']);
    expect(tags(d, 'staff').map((e) => e.getAttribute('n'))).toEqual(['2']);
    expect(tags(d, 'note').map((e) => e.getAttribute('xml:id'))).toEqual(['b']);
  });
  it('moves the rehearsal marks to the first kept staff, drops other staff-bound events', () => {
    const d = parse(filterMei(MEI, [2], null));
    expect(tags(d, 'reh')[0].getAttribute('staff')).toBe('2');
    expect(tags(d, 'dynam')[0].getAttribute('staff')).toBe('2'); // "1 2" reduced to the kept one
    expect(tags(d, 'tie')).toHaveLength(0); // points at a removed note
    expect(tags(d, 'slur')).toHaveLength(0);
  });
  it('a single staff left loses its bracket', () => {
    const d = parse(filterMei(MEI, [3], null));
    const grp = tags(d, 'staffGrp')[0];
    expect(grp.getAttribute('symbol')).toBeNull();
    expect(tags(d, 'label')).toHaveLength(0);
    const two = parse(filterMei(MEI, [1, 2], null));
    expect(tags(two, 'staffGrp')[0].getAttribute('symbol')).toBe('bracket');
  });
  it('takes the score’s tempo mark away: the line does not show it, and hidden it would keep its row', () => {
    expect(tags(parse(filterMei(MEI, [1], null)), 'tempo')).toHaveLength(0); // on the staff shown
    expect(tags(parse(filterMei(MEI, [2], null)), 'tempo')).toHaveLength(0); // on another staff
    expect(tags(parse(filterMei(MEI, null, [1])), 'tempo')).toHaveLength(0);
  });
  it('keeps only the chosen verses; a single lyric line is the first row, whatever its number was', () => {
    const d = parse(filterMei(MEI, null, [2]));
    expect(tags(d, 'verse').map((e) => [e.getAttribute('n'), e.textContent])).toEqual([['1', 'ля']]);
    const first = parse(filterMei(MEI, null, [1]));
    expect(tags(first, 'verse').map((e) => [e.getAttribute('n'), e.textContent])).toEqual([['1', 'la']]);
    // both lines shown: each keeps its row
    const both = parse(filterMei(MEI, [1], [1, 2]));
    expect(tags(both, 'verse').map((e) => [e.getAttribute('n'), e.textContent])).toEqual([['1', 'la'], ['2', 'ля']]);
    expect(filterMei(MEI, null, null)).toBe(MEI);
  });
  it('drops the verses’ labels (Verovio would draw each as a <title> under its syllable)', () => {
    const labelled = MEI.replace('<verse n="2">', '<verse n="2" label="translit">');
    const d = parse(filterMei(labelled, [1], null));
    expect(tags(d, 'verse').map((e) => e.getAttribute('label'))).toEqual([null, null]);
    expect(tags(d, 'verse').map((e) => e.getAttribute('n'))).toEqual(['1', '2']);
  });
});

describe('airySyllables', () => {
  it('pads the hyphen between syllables with no-break spaces', () => {
    expect(airySyllables('<syl wordpos="i" con="d">la</syl>')).toBe('<syl wordpos="i" con="d">la </syl>');
    expect(airySyllables('<syl wordpos="m" con="d">la</syl>')).toBe('<syl wordpos="m" con="d"> la </syl>');
    expect(airySyllables('<syl wordpos="t">la</syl>')).toBe('<syl wordpos="t"> la</syl>');
    expect(airySyllables('<syl>la</syl>')).toBe('<syl>la</syl>');
    expect(airySyllables('<syl wordpos="m" con="d"> </syl>')).toBe('<syl wordpos="m" con="d"> </syl>');
  });
});
