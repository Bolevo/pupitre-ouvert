// Work library: built-in packs (served with the app) + packs imported from zip files.
import { del, get, set, keys } from './db';
import { check, summary, unpackAndStore, type StoredPack, type WorkSummary } from './unpack';
import type { LoadedPack, Pack } from './types';
import { takeKey } from '../audio/take';
import { forgetProgress } from '../memo/store';
import { lang, tt } from '../i18n';

export type { WorkSummary };

const BASE = import.meta.env.BASE_URL;
const cache = new Map<string, LoadedPack>();
const builtinDirs = new Map<string, string>();

/** What packs/index.json lists (pipeline/publish.py). */
interface PackIndex {
  packs?: { id: string; dir: string; title?: string; composer?: string }[];
}

/** The works that can be opened: built-in (served with the app), then imported in this browser.
 *  Read once (packs/index.json + IndexedDB): no pack is downloaded or deserialised. */
export async function loadLibrary(): Promise<WorkSummary[]> {
  const out: WorkSummary[] = [];
  try {
    const idx = (await (await fetch(`${BASE}packs/index.json`, { cache: 'no-cache' })).json()) as PackIndex;
    for (const p of idx.packs ?? []) {
      builtinDirs.set(p.id, p.dir);
      if (p.title !== undefined) {
        out.push({ id: p.id, title: p.title, composer: p.composer ?? '' });
        continue;
      }
      try {
        // index.json written before title/composer were listed in it: read the pack itself
        out.push(summary((await loadWork(p.id)).pack));
      } catch (e) {
        console.warn('pack', p.dir, e);
      }
    }
  } catch (e) {
    console.warn('no built-in packs', e);
  }
  for (const k of await keys()) {
    if (typeof k === 'string' && k.startsWith('pack:')) {
      // the summary is stored beside the pack: listing the works does not deserialise every
      // stored pack (its MEI files and page images) on each start
      const id = k.slice('pack:'.length);
      let s = (await get(`packmeta:${id}`)) as WorkSummary | undefined;
      if (!s) {
        const sp = (await get(k)) as StoredPack | undefined;
        if (!sp) continue;
        s = summary(sp.pack);
        await set(`packmeta:${id}`, s);
      }
      if (!out.some((o) => o.id === s!.id)) out.push(s);
    }
  }
  return out;
}

/** `works` with `w` added, or replacing the entry with the same id (same place in the list). */
export function withWork(works: WorkSummary[], w: WorkSummary): WorkSummary[] {
  const i = works.findIndex((o) => o.id === w.id);
  return i < 0 ? [...works, w] : works.map((o, k) => (k === i ? w : o));
}

export async function loadWork(id: string): Promise<LoadedPack> {
  const c = cache.get(id);
  if (c) return c;
  // an imported work comes before a built-in one of the same id: what one has just added is
  // what one sees (the example rebuilt and imported, say); removed, the built-in one is back
  const sp = (await get(`pack:${id}`)) as StoredPack | undefined;
  const dir = builtinDirs.get(id);
  let lp: LoadedPack;
  if (!sp) {
    if (!dir) throw new Error(tt('Œuvre introuvable : {id}', { id }));
    const url = `${BASE}packs/${dir}/`;
    const pack = (await (await fetch(`${url}pack.json`)).json()) as Pack;
    check(pack);
    lp = { pack, source: 'builtin', getFile: async (n) => (await fetch(url + n)).text(), url: (n) => url + n };
  } else {
    const urls = new Map<string, string>();
    lp = {
      pack: sp.pack,
      source: 'imported',
      getFile: async (n) => sp.texts[n] ?? '',
      url: (n) => {
        if (!urls.has(n) && sp.blobs[n]) urls.set(n, URL.createObjectURL(sp.blobs[n]));
        return urls.get(n) ?? '';
      },
    };
  }
  cache.set(id, lp);
  return lp;
}

/** Import a .zip produced by the pipeline (pack.json, *.mei, pages/*.webp) into IndexedDB.
 *  The work is done in a worker (import.worker.ts): unzipping and parsing ~10 MB froze the page
 *  for 0.5-0.7 s on a phone. Without workers (tests) or if the worker cannot start, in place. */
export async function importWorkZip(file: Blob | ArrayBuffer): Promise<WorkSummary> {
  const zip = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  let s: WorkSummary;
  if (typeof Worker === 'undefined') s = await unpackAndStore(new Uint8Array(zip));
  else {
    const r = await inWorker(zip);
    s = r === 'no-worker' ? await unpackAndStore(new Uint8Array(zip)) : r;
  }
  cache.delete(s.id);
  return s;
}

function inWorker(zip: ArrayBuffer): Promise<WorkSummary | 'no-worker'> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ ok: boolean; summary?: WorkSummary; error?: string }>) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.summary!);
      else reject(new Error(e.data.error));
    };
    // the worker could not run (script not loaded, module workers unsupported): the caller
    // imports in place. This is why the zip is copied to the worker, not transferred.
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      console.warn('import worker', e.message);
      resolve('no-worker');
    };
    w.postMessage({ zip, lang: lang.value });
  });
}

/** Removes an imported work from this browser, with what was kept about it: the recordings of
 *  one's voice (rec.ts) and the progress in learning the text (memo/store.ts). Returns whether a
 *  built-in work of the same id remains. */
export async function removeWork(id: string): Promise<boolean> {
  for (const k of await keys()) {
    if (typeof k === 'string' && (k === `pack:${id}` || k === `packmeta:${id}` || k.startsWith(takeKey(id, '')))) await del(k);
  }
  forgetProgress(id);
  cache.delete(id);
  return builtinDirs.has(id);
}
