// Build step: Verovio's WebAssembly as a file of its own.
//
// The npm package ships its 6.8 MB of WebAssembly inside the JavaScript module, as one long string
// (`verovio/wasm`): the browser has to read 8 MB of script, keep that text (two bytes per
// character), decode it into bytes and only then compile it, at every launch. Taken out into a
// .wasm file, it is compiled while it downloads (WebAssembly.instantiateStreaming), straight from
// the network or the service worker's cache, and the browser can keep the compiled code for the
// next launches. Measured in Chromium: about 20 MB less memory in the Verovio worker; from the
// third launch on, the line of the first movement ready in 1.2 s instead of 1.9 s.
//
// The module is patched as text, at two places that must each be found exactly once. If a later
// Verovio is built differently, the build says so and keeps the module as published (the app works
// as before, only heavier): tests/verovio-wasm.test.ts fails then, to have this file updated.
import type { Plugin } from 'vite';

const HEAD = "function findWasmBinary(){return binaryDecode('";
const LOAD =
  'async function instantiateArrayBuffer(binaryFile,imports){try{var binary=await getWasmBinary(binaryFile);var instance=await WebAssembly.instantiate(binary,imports);return instance}catch(reason){';
// compiled while downloading; a server that does not say « application/wasm » (or an old browser)
// gets the whole file first, as before
const STREAM =
  'async function instantiateArrayBuffer(binaryFile,imports){try{try{return await WebAssembly.instantiateStreaming(fetch(binaryFile),imports)}catch(e){}var binary=await(await fetch(binaryFile)).arrayBuffer();var instance=await WebAssembly.instantiate(binary,imports);return instance}catch(reason){';

/** The module's code with `url` (a JavaScript expression) in place of the embedded binary, and the
 *  binary itself; null when the module is not built as expected. */
export function splitVerovioWasm(code: string, url: string): { code: string; wasm: Uint8Array } | null {
  const i = code.indexOf(HEAD);
  if (i < 0 || code.indexOf(HEAD, i + 1) >= 0 || code.split(LOAD).length !== 2) return null;
  // the end of the string literal: the first quote that is not escaped
  let j = i + HEAD.length;
  for (; j < code.length; j++) {
    const c = code.charCodeAt(j);
    if (c === 92) j++;
    else if (c === 39) break;
  }
  if (code.slice(j, j + 3) !== "')}") return null;
  // the literal as JavaScript reads it, then Emscripten's own decoding (binaryDecode)
  const str = (0, eval)(`'${code.slice(i + HEAD.length, j)}'`) as string;
  const wasm = new Uint8Array(str.length);
  for (let k = 0; k < str.length; k++) {
    const c = str.charCodeAt(k);
    wasm[k] = (~c >> 8) & c;
  }
  if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) return null; // « \0asm »
  const out = `${code.slice(0, i)}function findWasmBinary(){return ${url}}${code.slice(j + 3)}`.replace(LOAD, STREAM);
  return { code: out, wasm };
}

const URL_TOKEN = '__PUPITRE_VEROVIO_WASM_URL__';

/** For the worker bundles of a production build (`worker.plugins`); the dev server keeps the
 *  module as published. */
export function verovioWasm(): Plugin {
  return {
    name: 'pupitre:verovio-wasm',
    apply: 'build',
    transform(code, id) {
      if (!/[\\/]verovio[\\/]dist[\\/]verovio-module\.mjs$/.test(id.split('?')[0])) return null;
      const split = splitVerovioWasm(code, URL_TOKEN);
      if (!split) {
        this.warn('Verovio’s module is not built as expected: its WebAssembly stays inside the script (see vite-verovio-wasm.ts)');
        return null;
      }
      const ref = this.emitFile({ type: 'asset', name: 'verovio.wasm', source: split.wasm });
      return { code: split.code.replace(URL_TOKEN, `import.meta.ROLLUP_FILE_URL_${ref}`), map: null };
    },
  };
}
