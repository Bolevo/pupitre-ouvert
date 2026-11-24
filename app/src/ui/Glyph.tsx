// Clefs and note values drawn from the Leipzig font's outlines (see glyphs.ts): the same shapes
// as the line of my voice, on every device.
import type { Clef } from '../pack/types';
import { GLYPHS, type GlyphName } from './glyphs';
import { tt, ttKey } from '../i18n';

function clefGlyph(c: Clef): GlyphName {
  if (c.sign === 'F') return c.octave === -1 ? 'fClef8vb' : 'fClef';
  if (c.sign === 'C') return 'cClef';
  if (c.sign === 'percussion') return 'percClef';
  return c.octave === -1 ? 'gClef8vb' : c.octave === 1 ? 'gClef8va' : 'gClef';
}

/** A clef, `px` pixels per 1000 font units (one staff = 1000: clefs keep their relative sizes). */
export function ClefGlyph({ clef, px = 12 }: { clef: Clef; px?: number }) {
  const g = GLYPHS[clefGlyph(clef)];
  return (
    <svg class="glyph clef" width={(g.w * px) / 1000} height={(g.h * px) / 1000} viewBox={`${g.x} ${-(g.y + g.h)} ${g.w} ${g.h}`} aria-hidden="true">
      <path transform="scale(1,-1)" d={g.d} fill="currentColor" />
    </svg>
  );
}

/** Note value of a beat given in quarters (2 = half, 1.5 = dotted quarter…). */
export function beatGlyph(beat: number): { name: GlyphName; dot: boolean } {
  const table: [number, GlyphName, boolean][] = [
    [4, 'whole', false],
    [3, 'half', true],
    [2, 'half', false],
    [1.5, 'quarter', true],
    [1, 'quarter', false],
    [0.75, 'eighth', true],
    [0.5, 'eighth', false],
  ];
  const hit = table.find(([q]) => Math.abs(q - beat) < 1e-6);
  return hit ? { name: hit[1], dot: hit[2] } : { name: 'quarter', dot: false };
}

/** The note value of a metronome mark (♩, 𝅗𝅥, ♩.), drawn. */
export function NoteGlyph({ beat, px = 15 }: { beat: number; px?: number }) {
  const { name, dot } = beatGlyph(beat);
  const g = GLYPHS[name];
  const d = GLYPHS.dot;
  const dotX = (name === 'whole' ? 405 : 310) + 60;
  const top = Math.max(g.y + g.h, 66);
  const bottom = Math.min(g.y, -66);
  const w = dot ? dotX + d.w : name === 'eighth' ? g.w : g.w;
  return (
    <svg class="glyph note" width={(w * px) / 1000} height={((top - bottom) * px) / 1000} viewBox={`${g.x} ${-top} ${w} ${top - bottom}`} aria-hidden="true">
      {/* a thin outline: at text size the stem (27 units) would fall under a pixel */}
      <path transform="scale(1,-1)" d={g.d} fill="currentColor" stroke="currentColor" stroke-width={24} />
      {dot && <path transform={`translate(${dotX} -20) scale(1,-1)`} d={d.d} fill="currentColor" />}
    </svg>
  );
}

/** A metronome note value in words (titles, screen readers). */
export function beatWords(beat: number): string {
  const { name, dot } = beatGlyph(beat);
  const w = tt({ whole: ttKey('ronde'), half: ttKey('blanche'), quarter: ttKey('noire'), eighth: ttKey('croche') }[name as 'whole' | 'half' | 'quarter' | 'eighth'] ?? ttKey('noire'));
  return dot ? tt('{note} pointée', { note: w }) : w;
}

/** A key signature, compact: « 2♯ », « 1♭ », « ♮ » (no accidental), the signs drawn. */
export function SignatureGlyph({ fifths, px = 17 }: { fifths: number; px?: number }) {
  const g = GLYPHS[fifths > 0 ? 'sharp' : fifths < 0 ? 'flat' : 'natural'];
  // one box for the three signs (sharp and natural are centred on 0, the flat sits higher)
  const top = 520;
  const bottom = -360;
  return (
    <span class="sig">
      {fifths !== 0 && <span class="sig-n">{Math.abs(fifths)}</span>}
      <svg class="glyph acc" width={(g.w * px) / 1000} height={((top - bottom) * px) / 1000} viewBox={`${g.x} ${-top} ${g.w} ${top - bottom}`} aria-hidden="true">
        <path transform="scale(1,-1)" d={g.d} fill="currentColor" />
      </svg>
    </span>
  );
}
