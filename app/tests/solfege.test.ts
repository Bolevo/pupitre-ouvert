// « Nom des notes »: which name is sung for a note, by which voice, and the files there are to
// sing it on the note's own pitch (app/public/sf/solfege, made by tools/make_solfege.py).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { plainName, voiceOf } from '../src/audio/solfege';

const DIR = fileURLToPath(new URL('../public/sf/solfege/', import.meta.url));
interface Zone {
  name: string;
  voice: 'm' | 'f';
  file: string;
  root: number;
  cents: number;
  sr: number;
  onset: number;
  gain: number;
}
const manifest = JSON.parse(readFileSync(`${DIR}manifest.json`, 'utf8')) as { spans: Record<'m' | 'f', [number, number]>; zones: Zone[] };
const PITCH_CLASS: Record<string, number> = { do: 0, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 };

describe('the name sung', () => {
  it('the written name without its accidental; by the pitch when the score gives none', () => {
    expect(plainName(66, 'fas')).toBe('fa');
    expect(plainName(70, 'sib')).toBe('si');
    expect(plainName(60, 'sis')).toBe('si'); // B sharp sounds C and is called si
    expect(plainName(67, 'sol')).toBe('sol');
    expect(plainName(60)).toBe('do');
    expect(plainName(61)).toBe('do');
    expect(plainName(70)).toBe('si');
  });
});

describe('the voice that sings it', () => {
  it('a woman for soprano and alto, a man for tenor and bass, whatever the note', () => {
    expect(voiceOf('S', 60)).toBe('f');
    expect(voiceOf('A', 55)).toBe('f');
    expect(voiceOf('T', 69)).toBe('m');
    expect(voiceOf('B', 40)).toBe('m');
    expect(voiceOf('S1', 72)).toBe('f');
    expect(voiceOf('T2', 50)).toBe('m');
  });
  it('any other part (the piano) by the pitch: the woman from middle C up, the man below', () => {
    expect(voiceOf('P', 60)).toBe('f');
    expect(voiceOf('P', 59)).toBe('m');
    expect(voiceOf(undefined, 84)).toBe('f');
    expect(voiceOf(undefined, 36)).toBe('m');
  });
});

describe('the files', () => {
  const have = new Set(manifest.zones.map((z) => `${z.voice}:${z.name}:${z.root}`));

  it('each voice sings every note of the choir’s range on its own pitch: bass and tenor D2..C5, alto and soprano E3..C6', () => {
    expect(manifest.spans.m[0]).toBeLessThanOrEqual(38);
    expect(manifest.spans.m[1]).toBeGreaterThanOrEqual(72);
    expect(manifest.spans.f[0]).toBeLessThanOrEqual(52);
    expect(manifest.spans.f[1]).toBeGreaterThanOrEqual(84);
  });

  it('a file for every note of the span and every name the note can have with one sharp or flat at most', () => {
    const missing: string[] = [];
    for (const v of ['m', 'f'] as const) {
      const [lo, hi] = manifest.spans[v];
      for (let midi = lo; midi <= hi; midi++) {
        for (const [name, pc] of Object.entries(PITCH_CLASS)) {
          const d = (((midi - pc) % 12) + 12) % 12;
          if (Math.min(d, 12 - d) <= 1 && !have.has(`${v}:${name}:${midi}`)) missing.push(`${name} ${v} ${midi}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every file is there, sounds on its note (a cent at most), and says where its vowel starts', () => {
    for (const z of manifest.zones) {
      expect(existsSync(DIR + z.file), z.file).toBe(true);
      expect(Math.abs(z.cents), z.file).toBeLessThanOrEqual(1);
      // the consonant comes before the beat: 70 ms (d) to 190 ms (the woman's s)
      expect(z.onset, z.file).toBeGreaterThan(0.06);
      expect(z.onset, z.file).toBeLessThan(0.2);
      expect(z.gain, z.file).toBeGreaterThan(0.2);
      expect(z.gain, z.file).toBeLessThan(1.5);
    }
  });

  it('no file that the manifest does not name (the old spoken ones are gone)', () => {
    const named = manifest.zones.map((z) => z.file).sort();
    expect(new Set(named).size).toBe(named.length);
    expect(readdirSync(DIR).filter((f) => f.endsWith('.flac')).sort()).toEqual(named);
  });
});
