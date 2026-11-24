/// <reference lib="webworker" />
// Imports a work's .zip off the main thread: unzip, decode, parse, store in IndexedDB (see unpack.ts).
import { isLang, lang } from '../i18n';
import { unpackAndStore } from './unpack';

self.onmessage = async (e: MessageEvent<{ zip: ArrayBuffer; lang?: string }>) => {
  if (isLang(e.data.lang)) lang.value = e.data.lang; // what is wrong with an archive is said in the page's language
  try {
    postMessage({ ok: true, summary: await unpackAndStore(new Uint8Array(e.data.zip)) });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
