// Unpacking, checking and storing a work's .zip (pack.json, *.mei, pages/*.webp, fiche.md). Runs in the import
// worker (import.worker.ts): unzipping ~10 MB, decoding the MEI text and parsing pack.json took
// 0.5-0.7 s of main thread on a phone. Also usable in place (tests, no Worker).
import { set } from './db';
import { unzipSync, strFromU8 } from 'fflate';
import { PACK_MAJOR, type Pack } from './types';
import { problems } from './validate';
import { tt } from '../i18n';

export interface WorkSummary {
  id: string;
  title: string;
  composer: string;
}

export interface StoredPack {
  pack: Pack;
  texts: Record<string, string>;
  blobs: Record<string, Blob>;
}

export const summary = (p: Pack): WorkSummary => ({ id: p.id, title: p.title, composer: p.composer ?? '' });

export function check(p: Pack) {
  if (Math.floor(p.version) !== PACK_MAJOR) throw new Error(tt('Version de pack non prise en charge ({version})', { version: p.version }));
}

const MIME: Record<string, string> = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** Reads an archive and checks it (validate.ts). Throws an Error whose message says, in French,
 *  what is wrong with it: one line per thing to correct. The files may be at the root of the zip
 *  (as pipeline/publish.py writes them) or all in one folder (a folder zipped by hand). */
export function unpackZip(zip: Uint8Array): StoredPack {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error(tt('Ce fichier n’est pas une archive .zip lisible.'));
  }
  const names = Object.keys(files).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'));
  const main = names.filter((n) => n === 'pack.json' || n.endsWith('/pack.json')).sort((a, b) => a.length - b.length)[0];
  if (main === undefined) throw new Error(tt('pack.json manquant dans le fichier : ce n’est pas une archive faite pour Pupitre.'));
  const root = main.slice(0, -'pack.json'.length);
  const texts: Record<string, string> = {};
  const blobs: Record<string, Blob> = {};
  for (const full of names) {
    if (!full.startsWith(root)) continue;
    const name = full.slice(root.length);
    const ext = name.split('.').pop()!.toLowerCase();
    if (ext === 'json' || ext === 'mei' || ext === 'md') texts[name] = strFromU8(files[full]);
    else if (MIME[ext]) blobs[name] = new Blob([files[full] as Uint8Array<ArrayBuffer>], { type: MIME[ext] }); // fflate's output is a fresh buffer: no copy needed
  }
  let pack: Pack;
  try {
    pack = JSON.parse(texts['pack.json']) as Pack;
  } catch {
    throw new Error(tt('pack.json est illisible (JSON incorrect).'));
  }
  delete texts['pack.json'];
  const wrong = problems(pack, texts, Object.keys(blobs));
  if (wrong.length) throw new Error(wrong.length === 1 ? wrong[0] : `${tt('L’archive est à corriger :')}\n${wrong.map((w) => `• ${w}`).join('\n')}`);
  return { pack, texts, blobs };
}

/** Unpacks a work and stores it in IndexedDB (with its summary, read when listing the works). */
export async function unpackAndStore(zip: Uint8Array): Promise<WorkSummary> {
  const sp = unpackZip(zip);
  await set(`pack:${sp.pack.id}`, sp);
  const s = summary(sp.pack);
  await set(`packmeta:${sp.pack.id}`, s);
  return s;
}
