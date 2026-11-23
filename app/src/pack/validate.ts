// What an archive must hold for the app to open it (docs/ARCHIVE.md is the full specification;
// pipeline/check_pack.py checks the same things, and more, before the archive leaves its maker).
// An archive that fails here would open on an empty or broken screen: it is refused with the
// list of what to correct, in the singer's language.
import { PACK_MAJOR } from './types';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX = 8; // problems listed; the rest is counted

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The problems of a pack (pack.json parsed, the text files by name, the names of the images).
 *  Empty: the app can open it. */
export function problems(pack: unknown, texts: Record<string, string>, images: Iterable<string>): string[] {
  const out: string[] = [];
  const say = (m: string) => void out.push(m);
  if (!isObj(pack)) return ['pack.json ne contient pas la description d’une œuvre.'];
  if (!isNum(pack.version) || Math.floor(pack.version) !== PACK_MAJOR) return [`Version de pack non prise en charge (${String(pack.version)}) : cette app lit la version ${PACK_MAJOR}.`];
  if (!isStr(pack.id) || !ID.test(pack.id)) say('« id » : un identifiant simple est attendu (lettres, chiffres, tirets), par exemple « faure-requiem ».');
  if (!isStr(pack.title)) say('« title » : le titre de l’œuvre manque.');
  if (pack.composer !== undefined && typeof pack.composer !== 'string') say('« composer » : un texte est attendu.');
  const mvs = pack.movements;
  if (!Array.isArray(mvs) || !mvs.length) return [...out, '« movements » : l’œuvre n’a aucun mouvement.'];

  const mvIds = new Set<string>();
  mvs.forEach((mv: unknown, i) => {
    const where = `Mouvement ${i + 1}`;
    if (!isObj(mv)) return say(`${where} : description illisible.`);
    if (!isStr(mv.id) || !ID.test(mv.id)) say(`${where} : « id » manque ou n’est pas un identifiant simple.`);
    else if (mvIds.has(mv.id)) say(`${where} : l’identifiant « ${mv.id} » sert déjà à un autre mouvement.`);
    else mvIds.add(mv.id);
    if (!isStr(mv.title)) say(`${where} : « title » manque.`);
    const mei = isStr(mv.mei) ? texts[mv.mei] : undefined;
    if (!isStr(mv.mei)) say(`${where} : « mei » (le nom du fichier de la partition) manque.`);
    else if (mei === undefined) say(`${where} : le fichier ${mv.mei} n’est pas dans l’archive.`);
    else if (!/<mei[\s>]/.test(mei)) say(`${where} : ${mv.mei} n’est pas un fichier MEI.`);
    if (!isNum(mv.durationMs) || mv.durationMs <= 0) say(`${where} : « durationMs » (la durée) manque.`);

    const parts = new Set<string>();
    if (!Array.isArray(mv.parts) || !mv.parts.length) say(`${where} : aucune voix ni instrument (« parts »).`);
    else
      for (const p of mv.parts as unknown[]) {
        if (!isObj(p) || !isStr(p.id) || !isStr(p.name) || (p.kind !== 'voice' && p.kind !== 'accomp') || !Array.isArray(p.staves)) {
          say(`${where} : une partie est mal décrite (id, name, kind « voice » ou « accomp », staves).`);
          break;
        }
        if (parts.has(p.id)) say(`${where} : deux parties portent l’identifiant « ${p.id} ».`);
        parts.add(p.id);
      }

    const measures = Array.isArray(mv.measures) ? (mv.measures as unknown[]) : [];
    if (!measures.length) say(`${where} : aucune mesure (« measures »).`);
    else if (!measures.every((m) => isObj(m) && typeof m.n === 'string' && isNum(m.t) && Array.isArray(m.ts) && isNum(m.ts[0]) && isNum(m.ts[1]))) say(`${where} : une mesure est mal décrite (n, t, ts).`);

    if (!Array.isArray(mv.notes)) return say(`${where} : « notes » manque.`);
    if (mv.lyricLines !== undefined && !Array.isArray(mv.lyricLines)) say(`${where} : « lyricLines » doit être une liste.`);
    // every note: a known part, a measure of the movement, a place in the MEI the app draws
    const drawn = mei === undefined || !/<mei[\s>]/.test(mei) ? null : new Set(Array.from(mei.matchAll(/xml:id="([^"]+)"/g), (m) => m[1]));
    let bad = 0;
    let lost = 0;
    for (const n of mv.notes as unknown[]) {
      if (!isObj(n) || !isStr(n.id) || !isStr(n.part) || !parts.has(n.part) || !Number.isInteger(n.m) || (n.m as number) < 0 || (n.m as number) >= measures.length || !isNum(n.t) || !isNum(n.d) || !isNum(n.midi)) bad++;
      else if (drawn && !drawn.has(n.id)) lost++;
    }
    if (bad) say(`${where} : ${bad} note${bad > 1 ? 's' : ''} mal décrite${bad > 1 ? 's' : ''} (id, part, m, t, d, midi).`);
    if (lost) say(`${where} : ${lost} note${lost > 1 ? 's' : ''} absente${lost > 1 ? 's' : ''} de ${String(mv.mei)} (pack.json et le fichier MEI ne vont pas ensemble).`);
  });

  if (pack.pages !== undefined) {
    const have = new Set(images);
    if (!Array.isArray(pack.pages)) say('« pages » doit être une liste.');
    else
      (pack.pages as unknown[]).forEach((pg, i) => {
        const where = `Page ${isObj(pg) && isNum(pg.page) ? pg.page : i + 1}`;
        if (!isObj(pg) || !isStr(pg.img) || !isNum(pg.w) || !isNum(pg.h) || pg.w <= 0 || pg.h <= 0 || !Array.isArray(pg.systems) || !Array.isArray(pg.measures)) return say(`${where} : page mal décrite (img, w, h, systems, measures).`);
        if (!have.has(pg.img)) say(`${where} : l’image ${pg.img} n’est pas dans l’archive.`);
        const n = pg.systems.length;
        if (!(pg.measures as unknown[]).every((m) => isObj(m) && isStr(m.mv) && mvIds.has(m.mv) && isNum(m.n) && Number.isInteger(m.sys) && (m.sys as number) >= 0 && (m.sys as number) < n && [m.x0, m.x1, m.y0, m.y1].every(isNum)))
          say(`${where} : une case de mesure est mal décrite (mv = identifiant d’un mouvement, n, sys, x0, x1, y0, y1).`);
      });
  }
  if (pack.fiche !== undefined && (!isStr(pack.fiche) || texts[pack.fiche] === undefined)) say(`La fiche ${String(pack.fiche)} n’est pas dans l’archive.`);

  return out.length > MAX ? [...out.slice(0, MAX), `… et ${out.length - MAX} autre${out.length - MAX > 1 ? 's' : ''}.`] : out;
}
