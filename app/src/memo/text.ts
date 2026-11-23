// The sung text to learn by heart, read from the work's sheet (fiche.md): one source of truth,
// already written without the musical repetitions. Pure functions (unit-tested).
//
// In the sheet: a `## ` section per movement; a choir movement has a « Jouer ce mouvement » link
// `[…](#mv:<id>)` (sections without one are solos not transcribed: skipped). A text line is a
// line with bold spans (`**Gloria in excelsis Deo.**`, several spans on one line are joined); the
// next plain line, if any, is its phonetic transcription (Taneyev), the next italic line its
// translation. A paragraph « Alto solo : » starts solo lines (skipped) until « Chœur : ».

export interface TextLine {
  /** Stable within a work: the movement id and the line's letters (+ #n for a repeated line). */
  id: string;
  text: string;
  phon?: string;
  tr?: string;
}
export interface Section {
  title: string;
  mv: string;
  lines: TextLine[];
}
/** Which text is typed: the original one, or its phonetic transcription when there is one. */
export type Script = 'text' | 'phon';
export interface Word {
  /** As printed, punctuation included. */
  shown: string;
  /** What is typed: letters and digits only, lower case, without accents. */
  key: string;
}

const LIGATURES: Record<string, string> = { œ: 'oe', Œ: 'oe', æ: 'ae', Æ: 'ae', ß: 'ss' };

/** Letters and digits only, lower case, without accents (é → e, œ → oe, ё → е); modifier letters
 *  (the superscript ᶜʰ of the phonetic transcription), punctuation, hyphens and apostrophes go. */
export function norm(s: string): string {
  return s
    .replace(/[œŒæÆß]/g, (c) => LIGATURES[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lu}\p{Lt}\p{Lo}\p{Nd}]/gu, '');
}

/** The words of a line: split on spaces; tokens without a letter (« · », « — ») are not words. */
export function words(s: string): Word[] {
  return s
    .split(/\s+/)
    .map((shown) => ({ shown, key: norm(shown) }))
    .filter((w) => w.key);
}

/** The number of a movement from its heading (« 2 · Et in terra pax » → « 2 », « II · Andante »
 *  → « II »), to name it without its words (« Épreuve »); without one, its place in the sheet. */
export function sectionNumber(title: string, index: number): string {
  return title.match(/^\s*(?:n°\s*)?([IVXLC]+|\d+)(?![\p{L}\p{N}])/u)?.[1] ?? String(index + 1);
}

export function lineText(l: TextLine, script: Script): string {
  return script === 'phon' && l.phon ? l.phon : l.text;
}

const unescape = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
/** A source line without its hard break (backslash or two spaces at the end). */
const clean = (s: string) => s.replace(/(\\|\s{2,})$/, '').trim();
const spans = (s: string, re: RegExp) => Array.from(s.matchAll(re), (m) => unescape(m[1].trim())).filter(Boolean);
const BOLD = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
const ITALIC = /(?<!\*)\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g;
const MV_LINK = /\]\(#mv:([^)\s]+)\)/;

/** The choir text of the sheet, by movement section, in order. */
export function parseFiche(md: string): Section[] {
  const out: Section[] = [];
  const src = md.replace(/\r\n?/g, '\n').split('\n');
  // sections
  const raw: { title: string; body: string[] }[] = [];
  for (const line of src) {
    const h = line.match(/^\s{0,3}##\s+(.*?)\s*#*\s*$/);
    if (h) raw.push({ title: unescape(h[1].replace(/\*\*|__/g, '')), body: [] });
    else if (/^\s{0,3}#\s/.test(line)) continue;
    else raw[raw.length - 1]?.body.push(line);
  }
  for (const sec of raw) {
    const mv = sec.body.join('\n').match(MV_LINK)?.[1];
    if (!mv) continue;
    const lines: TextLine[] = [];
    const seen = new Map<string, number>();
    let solo = false;
    // paragraphs
    const paras: string[][] = [];
    let cur: string[] = [];
    for (const l of sec.body) {
      if (l.trim()) cur.push(clean(l));
      else if (cur.length) (paras.push(cur), (cur = []));
    }
    if (cur.length) paras.push(cur);
    for (const p of paras) {
      if (p.length === 1 && !p[0].includes('**') && /:\s*$/.test(p[0])) {
        // « Alto solo : », « Soprano et alto solo : », « Chœur : », « Tutti : »
        if (/\bsolo\b|\bsoli\b/i.test(p[0])) solo = true;
        else if (/^(ch(œ|oe)urs?|tutti)\b/iu.test(p[0])) solo = false;
        continue;
      }
      if (solo) continue;
      let last: TextLine | null = null;
      for (const l of p) {
        if (l.includes('**')) {
          const text = spans(l, BOLD).join(' ');
          if (!words(text).length) continue;
          const base = `${mv}:${norm(text)}`;
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          last = { id: n > 1 ? `${base}#${n}` : base, text };
          lines.push(last);
        } else if (!last) {
          continue; // the information line, a link…
        } else if (/^\*[^*]/.test(l)) {
          if (last.tr === undefined) last.tr = spans(l, ITALIC).join(' ');
        } else if (last.phon === undefined && last.tr === undefined && !/[[\]()#]/.test(l)) {
          last.phon = unescape(l);
        }
      }
    }
    if (lines.length) out.push({ title: sec.title, mv, lines });
  }
  return out;
}
