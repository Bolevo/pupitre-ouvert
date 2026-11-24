// « Copier où j'en suis »: the place in the score as a text to paste to whoever corrects the
// archive (one's AI): the work, the movement, the measure, the printed page, the voice followed,
// and what the archive holds in that measure, written as the transcription writes it
// (docs/CHT_FORMAT.md), so that the place is found at once in its files.
import type { Movement, Pack, PackNote, Part } from '../pack/types';
import { keyLabel, keyNameAt } from './info';
import { measureIndexAt } from '../ui/timing';
import { lang, partLabel, tt } from '../i18n';
import { SITE_URL } from '../site';

const STEP: Record<string, [string, number]> = { do: ['c', 0], re: ['d', 2], ré: ['d', 2], mi: ['e', 4], fa: ['f', 5], sol: ['g', 7], la: ['a', 9], si: ['b', 11] };
const BY_PC = ['c', 'c#', 'd', 'eb', 'e', 'f', 'f#', 'g', 'g#', 'a', 'bb', 'b'];
const ACCIDENTAL: Record<number, string> = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' };

/** A note as the transcription writes it: `f#4`, `bb3` (c4 = middle C). Spelled as the score
 *  spells it when the archive says so (`sp`: 'fas', 'sib'), else by its sound. */
export function chtPitch(n: Pick<PackNote, 'midi' | 'sp'>): string {
  const midi = Math.round(n.midi);
  const step = STEP[n.sp?.match(/^(do|ré|re|mi|fa|sol|la|si)/)?.[1] ?? ''];
  if (step) {
    const alter = ((((midi - step[1]) % 12) + 18) % 12) - 6; // -6..5: how far the sound is from the plain note
    if (alter in ACCIDENTAL) return `${step[0]}${ACCIDENTAL[alter]}${Math.floor((midi - alter) / 12) - 1}`;
  }
  return `${BY_PC[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** A length in quarter notes, as short as it reads: 1, 1.5, 0.25, 0.333. */
const quarters = (q: number) => String(Number((Math.round(q * 48) / 48).toFixed(3)));

/** What a part holds in measure `i`: `c5 (3), b4 (1)`; `r` a rest, `<a3 c#4>` notes struck
 *  together, `~` before a note held from the measure before. */
export function measureNotes(mv: Movement, i: number, part: string): string {
  const m = mv.measures[i];
  const next = mv.measures[i + 1];
  const length = next ? next.q - m.q : (m.ts[0] * 4) / m.ts[1]; // in quarter notes
  const end = next ? next.t : mv.durationMs;
  const perQuarter = (end - m.t) / (length || 1);
  if (!(perQuarter > 0)) return '';
  const mine = mv.notes.filter((n) => n.part === part);
  const held = mine.filter((n) => n.m < i && n.t + n.d > m.t + perQuarter / 48);
  const struck = mine.filter((n) => n.m === i).sort((a, b) => a.t - b.t || a.midi - b.midi);
  const out: string[] = [];
  const say = (group: PackNote[], until: number, tie = '') => {
    const names = group.map(chtPitch);
    out.push(`${tie}${names.length > 1 ? `<${names.join(' ')}>` : names[0]} (${quarters((until - Math.max(group[0].t, m.t)) / perQuarter)})`);
  };
  let at = m.t; // up to where the measure is filled
  if (held.length) {
    const until = Math.max(...held.map((n) => n.t + n.d));
    say(held, until, '~');
    at = Math.min(until, end);
  }
  for (let k = 0; k < struck.length; ) {
    let j = k;
    while (j < struck.length && struck[j].t - struck[k].t < perQuarter / 48) j++;
    const group = struck.slice(k, j);
    if (group[0].t - at > perQuarter / 24) out.push(`r (${quarters((group[0].t - at) / perQuarter)})`);
    const until = Math.max(...group.map((n) => n.t + n.d));
    say(group, until);
    at = Math.max(at, Math.min(until, end));
    k = j;
  }
  if (out.length && end - at > perQuarter / 24) out.push(`r (${quarters((end - at) / perQuarter)})`);
  return out.join(', ');
}

/** Where one is at time `t` (ms) of the movement: the measure (its index, its printed number)
 *  and the printed page that shows it, if the archive has pages. */
export function placeAt(pack: Pack, mv: Movement, t: number): { index: number; n: string; page: number | null } {
  const index = Math.max(0, Math.min(mv.measures.length - 1, measureIndexAt(mv, t)));
  const n = mv.measures[index].n;
  const num = parseInt(n, 10);
  const page = pack.pages?.find((p) => p.measures.some((b) => b.mv === mv.id && b.n === num))?.page ?? null;
  return { index, n, page };
}

/** The text copied: where one is, what the archive holds there, how to have it corrected. */
export function whereText(pack: Pack, mv: Movement, t: number, followed: string): string {
  const { index, n, page } = placeAt(pack, mv, t);
  const m = mv.measures[index];
  const key = keyNameAt(mv, index);
  const name = (p: Part) => partLabel(p.name);
  const mine = mv.parts.find((p) => p.id === followed);
  const lines = [
    tt('Pupitre Ouvert : où j’en suis dans la partition'),
    tt('Œuvre : {title}', { title: pack.composer ? `${pack.title} (${pack.composer})` : pack.title }),
    ...(pack.movements.length > 1 ? [tt('Mouvement : {title}', { title: mv.title })] : []),
    page === null ? tt('Mesure {n}', { n }) : tt('Mesure {n}, page {page} de la partition', { n, page }),
    ...(mine ? [tt('Voix suivie : {name}', { name: name(mine) })] : []),
    key ? tt('Tonalité : {key} ; mesure à {a}/{b}', { key: keyLabel(key), a: m.ts[0], b: m.ts[1] }) : tt('Mesure à {a}/{b}', { a: m.ts[0], b: m.ts[1] }),
    tt('Archive : {id}, mouvement {mv}', { id: pack.id, mv: mv.id }),
    '',
    tt('Ce que l’archive contient à cette mesure, écrit comme dans la transcription (c4 = do central ; entre parenthèses, la durée en noires ; r = silence ; ~ = note tenue depuis la mesure précédente) :'),
  ];
  const colon = lang.value === 'en' ? ':' : ' :';
  for (const p of mv.parts) {
    // the voices note by note; an accompaniment by its number of notes (the text stays short)
    const what = p.kind === 'voice' ? measureNotes(mv, index, p.id) || tt('rien') : tt('{n} notes', { n: mv.notes.filter((x) => x.part === p.id && x.m === index).length });
    lines.push(`${p.id === name(p) ? p.id : `${p.id} (${name(p)})`}${colon} ${what}`);
  }
  lines.push(
    '',
    tt('Pour corriger l’archive : section « Corriger une archive » de {url} (il faut le fichier .zip de l’œuvre).', { url: `${SITE_URL}${lang.value === 'en' ? 'create.html' : 'creer.html'}` }),
    '',
    `${tt('Ce qui ne va pas à cet endroit :')} `,
  );
  return lines.join('\n');
}
