// The app's two languages. French is the language the app is written in: its texts, in the
// code, are the keys. `tt` gives a text in the language chosen (Réglages › Langue); i18n-en.ts
// holds the English of each one (tests/i18n.test.ts checks that none is missing, none unused).
// `{name}` in a text is replaced by `vars.name`.
import { signal } from '@preact/signals';
import { en } from './i18n-en';

export type Lang = 'fr' | 'en';
/** The languages, each named in itself (the choice must be readable in the other one). */
export const LANGS: [Lang, string][] = [
  ['fr', 'Français'],
  ['en', 'English'],
];
export const isLang = (v: unknown): v is Lang => v === 'fr' || v === 'en';

/** The language shown. A signal: what is drawn with `tt` is drawn again when it changes.
 *  Set by state.ts (the saved choice) and, in the import worker, from the page's. */
export const lang = signal<Lang>('fr');

export function tt(fr: string, vars?: Record<string, string | number>): string {
  const s = lang.value === 'en' ? (en[fr] ?? fr) : fr;
  return vars ? s.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all)) : s;
}

/** Marks a text kept in a table and translated where it is shown (`tt(label)`), so that the
 *  test of the English texts finds it. */
export const ttKey = (fr: string): string => fr;

/** A part's name as shown: the archives name the usual voices in French (Ténor, Basse). */
export function partLabel(name: string): string {
  return lang.value === 'en' ? name.replace(/^Ténor(?![\p{L}])/u, 'Tenor').replace(/^Basse(?![\p{L}])/u, 'Bass') : name;
}

/** The help page in the language shown. */
export const helpPage = (): string => (lang.value === 'en' ? 'help.html' : 'aide.html');

/** For dates written by the browser. */
export const locale = (): string => (lang.value === 'en' ? 'en-GB' : 'fr-FR');
