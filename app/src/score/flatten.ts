// Verovio draws every music symbol (note heads, flags, accidentals, rests, clefs…) as a
// <use transform="translate(x, y) scale(s, s)"> of a glyph outline kept in <defs>. In a browser
// each of these transformed elements is a separate piece of the page's drawing (its own transform
// node and paint chunk): thousands for one voice, tens of thousands for a piano part, and the
// browser goes through all of them on the main thread whenever anything is drawn again in the line
// (measured in Chromium: 35 ms per lit note for the piano of a long movement).
//
// Here each <use> becomes a plain <path> holding the glyph's outline already moved and scaled:
// the same drawing, in a handful of pieces. Done in the Verovio worker, on the SVG text.
// Pure functions (unit-tested).

const NUM = /-?(?:\d+\.?\d*|\.\d+)/g;
// arguments per command; arcs (A) and numbers with an exponent are not handled (Verovio's glyphs
// have none): such a glyph stays a <use>
const ARGS: Record<string, number> = { m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, z: 0 };

// one decimal, written short ("-.5", "12")
const fmt = (v: number) => {
  const r = Math.round(v * 10) / 10;
  if (!r) return '0';
  const s = String(r);
  return r > -1 && r < 1 ? s.replace('0.', '.') : s;
};

/** The path `d` moved by (tx, ty) and scaled by (sx, sy): absolute coordinates are scaled then
 *  moved, relative ones only scaled. One decimal (a tenth of Verovio's unit: under 0.01 px).
 *  null when the path uses a command not handled here. */
export function movePath(d: string, tx: number, ty: number, sx: number, sy: number): string | null {
  let out = '';
  const re = /([a-zA-Z])([^a-zA-Z]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const low = cmd.toLowerCase();
    const n = ARGS[low];
    if (n === undefined) return null;
    const abs = cmd !== low;
    const nums = m[2].match(NUM) ?? [];
    if (n === 0 ? nums.length : !nums.length || nums.length % n) return null;
    out += cmd;
    for (let i = 0; i < nums.length; i++) {
      const v = Number(nums[i]);
      // h: x only; v: y only; otherwise x, y alternate
      const isY = low === 'v' || (low !== 'h' && i % 2 === 1);
      const w = isY ? v * sy + (abs ? ty : 0) : v * sx + (abs ? tx : 0);
      const s = fmt(w);
      out += i && s[0] !== '-' ? ` ${s}` : s; // a minus sign separates as well as a space
    }
  }
  return out;
}

const DEF = /<g id="([^"]+)">\s*<path transform="scale\(1,\s*-1\)" d="([^"]+)"\s*\/>\s*<\/g>/g;
const USE = /<use (?:xlink:)?href="#([^"]+)" transform="translate\((-?[\d.]+),\s*(-?[\d.]+)\) scale\((-?[\d.]+),\s*(-?[\d.]+)\)"\s*\/>/g;

/** Verovio's SVG with each glyph <use> replaced by the glyph's outline in place; the glyph
 *  definitions no longer referenced are dropped. A <use> that cannot be replaced (unknown glyph,
 *  other transform, arc in the outline) is left as it is, with its definition. */
export function flattenGlyphs(svg: string): string {
  const glyphs = new Map<string, string>();
  for (const m of svg.matchAll(DEF)) glyphs.set(m[1], m[2]);
  if (!glyphs.size) return svg;
  let out = svg.replace(USE, (all, id: string, x: string, y: string, sx: string, sy: string) => {
    const d = glyphs.get(id);
    // the definition is drawn upside down (scale(1,-1) on its path): y grows upwards in the font
    const p = d === undefined ? null : movePath(d, Number(x), Number(y), Number(sx), -Number(sy));
    // no outline: Verovio's style sheet strokes every <path>, but (in Chromium) not those inside a
    // <use>; a stroke here would make every symbol a little bolder than before
    return p === null ? all : `<path d="${p}" stroke-width="0"/>`;
  });
  // definitions still referenced stay; the others go
  out = out.replace(DEF, (all, id: string) => (out.includes(`"#${id}"`) ? all : ''));
  return out;
}
