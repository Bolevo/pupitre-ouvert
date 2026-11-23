import { describe, expect, it } from 'vitest';
import { flattenGlyphs, movePath } from '../src/score/flatten';

describe('movePath: a glyph outline moved and scaled', () => {
  it('absolute coordinates are scaled then moved, relative ones only scaled', () => {
    expect(movePath('M0 -39c0 68 73 172 200 172z', 1000, 2000, 0.5, -0.5)).toBe('M1000 2019.5c0-34 36.5-86 100-86z');
    expect(movePath('M10 10l5 0L20 30', 100, 200, 2, 3)).toBe('M120 230l10 0L140 290');
  });
  it('h and v take one coordinate; s, q, t, several groups after one command', () => {
    expect(movePath('M0 0h10v-10H4V2', 1, 1, 2, 2)).toBe('M1 1h20v-20H9V5');
    expect(movePath('M0 0s1 2 3 4 5 6 7 8q1 1 2 2t3 3', 0, 0, 10, 10)).toBe('M0 0s10 20 30 40 50 60 70 80q10 10 20 20t30 30');
  });
  it('numbers written short, one decimal', () => {
    expect(movePath('M0.24 -0.26l0.5 -0.5', 0, 0, 1, 1)).toBe('M.2-.3l.5-.5');
  });
  it('null for what it does not handle (arcs, exponents, a wrong number of arguments)', () => {
    expect(movePath('M-1e1 3', 0, 0, 1, 1)).toBeNull();
    expect(movePath('M0 0a5 5 0 0 1 10 10', 0, 0, 1, 1)).toBeNull();
    expect(movePath('M0 0l5', 0, 0, 1, 1)).toBeNull();
    expect(movePath('M0 0z5', 0, 0, 1, 1)).toBeNull();
  });
});

describe('flattenGlyphs: Verovio’s <use> glyphs as plain paths', () => {
  const defs = '<defs><g id="E0A4-x1"><path transform="scale(1,-1)" d="M0 -39c0 68 73 172 200 172z"/></g><g id="E050-x1"><path transform="scale(1,-1)" d="M0 0a1 1 0 0 1 2 2"/></g></defs>';
  const svg = (body: string) => `<svg id="x1">${defs}<svg class="definition-scale"><g class="page-margin">${body}</g></svg></svg>`;

  it('each <use> becomes the outline in place (the font’s y axis points up), without a stroke', () => {
    const out = flattenGlyphs(svg('<g class="notehead"><use xlink:href="#E0A4-x1" transform="translate(1000, 2000) scale(0.5, 0.5)"/></g>'));
    expect(out).toContain('<g class="notehead"><path d="M1000 2019.5c0-34 36.5-86 100-86z" stroke-width="0"/></g>');
    expect(out).not.toContain('<use');
    expect(out).not.toContain('id="E0A4-x1"'); // its definition is not needed any more
  });
  it('also without the xlink prefix; a glyph it cannot move stays a <use>, with its definition', () => {
    const out = flattenGlyphs(svg('<use href="#E0A4-x1" transform="translate(0, 0) scale(1, 1)"/><use xlink:href="#E050-x1" transform="translate(5, 5) scale(1, 1)"/>'));
    expect(out).toContain('<path d="M0 39c0-68 73-172 200-172z" stroke-width="0"/>');
    expect(out).toContain('<use xlink:href="#E050-x1" transform="translate(5, 5) scale(1, 1)"/>');
    expect(out).toContain('id="E050-x1"');
  });
  it('leaves anything else alone', () => {
    const plain = '<svg><g class="staff"><path d="M0 0L10 0" stroke-width="13"/></g></svg>';
    expect(flattenGlyphs(plain)).toBe(plain);
    const other = flattenGlyphs(svg('<use xlink:href="#E0A4-x1" transform="rotate(30)"/>')); // another transform
    expect(other).toContain('<use xlink:href="#E0A4-x1" transform="rotate(30)"/>');
    expect(other).toContain('id="E0A4-x1"');
  });
});
