/// <reference lib="webworker" />
// Imports a work's .zip off the main thread: unzip, decode, parse, store in IndexedDB (see unpack.ts).
import { unpackAndStore } from './unpack';

self.onmessage = async (e: MessageEvent<{ zip: ArrayBuffer }>) => {
  try {
    postMessage({ ok: true, summary: await unpackAndStore(new Uint8Array(e.data.zip)) });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
