// What the device remembers of the text learning: the level of help of each movement and the best
// scores of the « Épreuve », per work and per script (`<NS>-memo2:<work>:<script>`, NS: site.ts),
// and the last settings (`<NS>-memo`). Works without storage (private mode): nothing is remembered.
import { NS } from '../site';
import type { LevelProgress, Mode } from './drill';
import type { Script } from './text';

export interface Best {
  acc: number; // 0..1
  ms: number;
  at: number;
}
export interface MemoStore {
  sections: Record<string, LevelProgress>; // by movement id
  best: Record<string, Best>; // by `<scope>|<mode>`
}
export interface MemoSettings {
  mode: Mode;
  script: Script;
}

const keyOf = (work: string, script: Script) => `${NS}-memo2:${work}:${script}`;

function read<T>(key: string): Partial<T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode, full */
  }
}

export function loadStore(work: string, script: Script): MemoStore {
  const s = read<MemoStore>(keyOf(work, script));
  return {
    sections: s.sections && typeof s.sections === 'object' ? s.sections : {},
    best: s.best && typeof s.best === 'object' ? s.best : {},
  };
}
export function saveStore(work: string, script: Script, s: MemoStore) {
  write(keyOf(work, script), s);
}

/** Forgets what was learnt of a work's text (the work is removed from this device). */
export function forgetProgress(work: string) {
  try {
    for (const script of ['text', 'phon'] as Script[]) localStorage.removeItem(keyOf(work, script));
  } catch {
    /* no storage: nothing was kept */
  }
}

export function loadSettings(): MemoSettings {
  const s = read<MemoSettings>(`${NS}-memo`);
  return {
    mode: s.mode === 'words' ? 'words' : 'initials',
    script: s.script === 'text' ? 'text' : 'phon',
  };
}
export function saveSettings(s: MemoSettings) {
  write(`${NS}-memo`, s);
}
