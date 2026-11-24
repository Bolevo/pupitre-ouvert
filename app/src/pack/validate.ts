// What an archive must hold for the app to open it (docs/ARCHIVE.md is the full specification;
// pipeline/check_pack.py checks the same things, and more, before the archive leaves its maker).
// An archive that fails here would open on an empty or broken screen: it is refused with the
// list of what to correct, in the singer's language.
import { tt } from '../i18n';
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
  if (!isObj(pack)) return [tt('pack.json ne contient pas la description d’une œuvre.')];
  if (!isNum(pack.version) || Math.floor(pack.version) !== PACK_MAJOR) return [tt('Version de pack non prise en charge ({version}) : cette app lit la version {major}.', { version: String(pack.version), major: PACK_MAJOR })];
  if (!isStr(pack.id) || !ID.test(pack.id)) say(tt('« id » : un identifiant simple est attendu (lettres, chiffres, tirets), par exemple « faure-requiem ».'));
  if (!isStr(pack.title)) say(tt('« title » : le titre de l’œuvre manque.'));
  if (pack.composer !== undefined && typeof pack.composer !== 'string') say(tt('« composer » : un texte est attendu.'));
  const mvs = pack.movements;
  if (!Array.isArray(mvs) || !mvs.length) return [...out, tt('« movements » : l’œuvre n’a aucun mouvement.')];

  const mvIds = new Set<string>();
  mvs.forEach((mv: unknown, i) => {
    const where = tt('Mouvement {n}', { n: i + 1 });
    if (!isObj(mv)) return say(tt('{where} : description illisible.', { where }));
    if (!isStr(mv.id) || !ID.test(mv.id)) say(tt('{where} : « id » manque ou n’est pas un identifiant simple.', { where }));
    else if (mvIds.has(mv.id)) say(tt('{where} : l’identifiant « {id} » sert déjà à un autre mouvement.', { where, id: mv.id }));
    else mvIds.add(mv.id);
    if (!isStr(mv.title)) say(tt('{where} : « title » manque.', { where }));
    const mei = isStr(mv.mei) ? texts[mv.mei] : undefined;
    const isMei = mei !== undefined && /<mei[\s>]/.test(mei);
    if (!isStr(mv.mei)) say(tt('{where} : « mei » (le nom du fichier de la partition) manque.', { where }));
    else if (mei === undefined) say(tt('{where} : le fichier {file} n’est pas dans l’archive.', { where, file: mv.mei }));
    else if (!isMei) say(tt('{where} : {file} n’est pas un fichier MEI.', { where, file: mv.mei }));
    if (!isNum(mv.durationMs) || mv.durationMs <= 0) say(tt('{where} : « durationMs » (la durée) manque.', { where }));

    const parts = new Set<string>();
    if (!Array.isArray(mv.parts) || !mv.parts.length) say(tt('{where} : aucune voix ni instrument (« parts »).', { where }));
    else
      for (const p of mv.parts as unknown[]) {
        if (!isObj(p) || !isStr(p.id) || !isStr(p.name) || (p.kind !== 'voice' && p.kind !== 'accomp') || !Array.isArray(p.staves)) {
          say(tt('{where} : une partie est mal décrite (id, name, kind « voice » ou « accomp », staves).', { where }));
          break;
        }
        if (parts.has(p.id)) say(tt('{where} : deux parties portent l’identifiant « {id} ».', { where, id: p.id }));
        parts.add(p.id);
      }

    const measures = Array.isArray(mv.measures) ? (mv.measures as unknown[]) : [];
    if (!measures.length) say(tt('{where} : aucune mesure (« measures »).', { where }));
    else if (!measures.every((m) => isObj(m) && typeof m.n === 'string' && isNum(m.t) && Array.isArray(m.ts) && isNum(m.ts[0]) && isNum(m.ts[1]))) say(tt('{where} : une mesure est mal décrite (n, t, ts).', { where }));

    if (!Array.isArray(mv.notes)) return say(tt('{where} : « notes » manque.', { where }));
    if (mv.lyricLines !== undefined && !Array.isArray(mv.lyricLines)) say(tt('{where} : « lyricLines » doit être une liste.', { where }));
    // every note: a known part, a measure of the movement, a place in the MEI the app draws
    const drawn = isMei ? new Set(Array.from(mei.matchAll(/xml:id="([^"]+)"/g), (m) => m[1])) : null;
    let bad = 0;
    let lost = 0;
    for (const n of mv.notes as unknown[]) {
      if (!isObj(n) || !isStr(n.id) || !isStr(n.part) || !parts.has(n.part) || !Number.isInteger(n.m) || (n.m as number) < 0 || (n.m as number) >= measures.length || !isNum(n.t) || !isNum(n.d) || !isNum(n.midi)) bad++;
      else if (drawn && !drawn.has(n.id)) lost++;
    }
    if (bad) say(bad > 1 ? tt('{where} : {n} notes mal décrites (id, part, m, t, d, midi).', { where, n: bad }) : tt('{where} : {n} note mal décrite (id, part, m, t, d, midi).', { where, n: bad }));
    if (lost) {
      const file = String(mv.mei);
      say(lost > 1 ? tt('{where} : {n} notes absentes de {file} (pack.json et le fichier MEI ne vont pas ensemble).', { where, n: lost, file }) : tt('{where} : {n} note absente de {file} (pack.json et le fichier MEI ne vont pas ensemble).', { where, n: lost, file }));
    }
  });

  if (pack.pages !== undefined) {
    const have = new Set(images);
    if (!Array.isArray(pack.pages)) say(tt('« pages » doit être une liste.'));
    else
      (pack.pages as unknown[]).forEach((pg, i) => {
        const where = tt('Page {n}', { n: isObj(pg) && isNum(pg.page) ? pg.page : i + 1 });
        if (!isObj(pg) || !isStr(pg.img) || !isNum(pg.w) || !isNum(pg.h) || pg.w <= 0 || pg.h <= 0 || !Array.isArray(pg.systems) || !Array.isArray(pg.measures)) return say(tt('{where} : page mal décrite (img, w, h, systems, measures).', { where }));
        if (!have.has(pg.img)) say(tt('{where} : l’image {file} n’est pas dans l’archive.', { where, file: pg.img }));
        const n = pg.systems.length;
        if (!(pg.measures as unknown[]).every((m) => isObj(m) && isStr(m.mv) && mvIds.has(m.mv) && isNum(m.n) && Number.isInteger(m.sys) && (m.sys as number) >= 0 && (m.sys as number) < n && [m.x0, m.x1, m.y0, m.y1].every(isNum)))
          say(tt('{where} : une case de mesure est mal décrite (mv = identifiant d’un mouvement, n, sys, x0, x1, y0, y1).', { where }));
      });
  }
  if (pack.fiche !== undefined && (!isStr(pack.fiche) || texts[pack.fiche] === undefined)) say(tt('La fiche {file} n’est pas dans l’archive.', { file: String(pack.fiche) }));

  if (out.length <= MAX) return out;
  const more = out.length - MAX;
  return [...out.slice(0, MAX), more > 1 ? tt('… et {n} autres.', { n: more }) : tt('… et {n} autre.', { n: more })];
}
