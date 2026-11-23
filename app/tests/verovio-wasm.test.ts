// The build takes Verovio's WebAssembly out of its script (vite-verovio-wasm.ts) by patching the
// published module as text. This test runs that patch on the module actually installed: after an
// update of Verovio built differently, it fails here instead of silently shipping the heavy script.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitVerovioWasm } from '../vite-verovio-wasm';

describe('Verovio’s WebAssembly as a separate file', () => {
  const src = readFileSync(new URL('../node_modules/verovio/dist/verovio-module.mjs', import.meta.url), 'utf8');
  const split = splitVerovioWasm(src, 'WASM_URL');

  it('finds the embedded binary: a valid WebAssembly module', () => {
    expect(split).not.toBeNull();
    expect(split!.wasm.length).toBeGreaterThan(1_000_000);
    expect(WebAssembly.validate(split!.wasm as Uint8Array<ArrayBuffer>)).toBe(true);
  });
  it('the script no longer carries it, loads the file instead, compiled while it downloads', () => {
    const code = split!.code;
    expect(code.length).toBeLessThan(200_000);
    expect(code).toContain('function findWasmBinary(){return WASM_URL}');
    expect(code).toContain('WebAssembly.instantiateStreaming(fetch(binaryFile),imports)');
    expect(code).not.toContain('binaryDecode(\'');
  });
  it('a module built differently is left alone', () => {
    expect(splitVerovioWasm('export default async function createVerovioModule(){}', 'WASM_URL')).toBeNull();
  });
});
