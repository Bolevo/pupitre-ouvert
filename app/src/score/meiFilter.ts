// Keep only some staves / lyric verses of an MEI document before rendering.
// Ids are untouched, so pack notes still map onto the rendered SVG.
// What the line does not show must not be left in the document: Verovio gives its place to
// everything it is handed, and the line is as high as its highest spot in the whole movement.

const MOVABLE = new Set(['reh']); // keep these on the first visible staff

export function filterMei(mei: string, keepStaves: number[] | null, keepVerses: number[] | null): string {
  if (!keepStaves && !keepVerses) return mei;
  const doc = new DOMParser().parseFromString(mei, 'application/xml');
  const keepS = keepStaves ? new Set(keepStaves.map(String)) : null;
  const keepV = keepVerses ? new Set(keepVerses.map(String)) : null;
  // the score's tempo mark is not shown in the line (the tempo button shows the tempo actually
  // played). Hidden by a style, it kept its row above the staff, and what stands at the same
  // place (a rehearsal mark, « Largamente ») was drawn above that empty row: up to 28 px
  for (const t of Array.from(doc.getElementsByTagName('tempo'))) t.remove();
  const all = Array.from(doc.getElementsByTagName('*'));
  const removed = new Set<string>();

  if (keepS) {
    const first = keepStaves![0];
    for (const el of all) {
      const name = el.localName;
      if ((name === 'staffDef' || name === 'staff') && !keepS.has(el.getAttribute('n') ?? '')) {
        for (const c of Array.from(el.getElementsByTagName('*'))) removed.add(c.getAttribute('xml:id') ?? '');
        el.remove();
        continue;
      }
      const st = el.getAttribute('staff');
      if (st && el.parentNode) {
        const staves = st.split(/\s+/);
        if (!staves.some((s) => keepS.has(s))) {
          const parent = el.parentElement;
          const dup =
            MOVABLE.has(name) &&
            parent &&
            Array.from(parent.children).some(
              (o) => o !== el && o.localName === name && keepS.has(o.getAttribute('staff') ?? '') && o.textContent?.trim() === el.textContent?.trim(),
            );
          if (MOVABLE.has(name) && !dup) el.setAttribute('staff', String(first));
          else el.remove();
        } else if (staves.length > 1) el.setAttribute('staff', staves.filter((s) => keepS.has(s)).join(' '));
      }
    }
    // control events pointing at removed notes
    for (const el of Array.from(doc.querySelectorAll('[startid],[endid]'))) {
      const s = (el.getAttribute('startid') ?? '').replace('#', '');
      const e = (el.getAttribute('endid') ?? '').replace('#', '');
      if (removed.has(s) || removed.has(e)) el.remove();
    }
    // empty staff groups confuse the layout
    let again = true;
    while (again) {
      again = false;
      for (const g of Array.from(doc.getElementsByTagName('staffGrp'))) {
        if (!g.getElementsByTagName('staffDef').length) {
          g.remove();
          again = true;
        }
      }
    }
    // a group symbol with a single staff left looks odd
    for (const g of Array.from(doc.getElementsByTagName('staffGrp'))) {
      const defs = Array.from(g.children).filter((c) => c.localName === 'staffDef');
      if (defs.length === 1 && Array.from(g.children).every((c) => c.localName !== 'staffGrp')) {
        Array.from(g.children)
          .filter((c) => ['grpSym', 'label', 'labelAbbr'].includes(c.localName))
          .forEach((c) => c.remove());
        g.removeAttribute('symbol');
      }
    }
  }
  for (const v of Array.from(doc.getElementsByTagName('verse'))) {
    if (keepV && !keepV.has(v.getAttribute('n') ?? '1')) {
      v.remove();
      continue;
    }
    // the verse's label (« translit ») is drawn as a <title> under every syllable: one more
    // element each, and a tooltip over the words; the lyric lines are named in the pack
    v.removeAttribute('label');
    // a single lyric line shown is the first one: left as the second (Taneyev's phonetics, under
    // the Russian words taken away), it was drawn on the second row, under an empty one (18 px)
    if (keepV?.size === 1) v.setAttribute('n', '1');
  }
  return new XMLSerializer().serializeToString(doc);
}

/** A little more room around the hyphen between the syllables of a word (a no-break space on
 *  each side), so that the layout keeps them apart: in a narrow line they would touch. */
export function airySyllables(mei: string): string {
  return mei.replace(/<syl\b([^>]*)>([^<]*)<\/syl>/g, (all, attrs: string, text: string) => {
    if (!text.trim()) return all;
    const before = /wordpos="[mt]"/.test(attrs) ? '\u00a0' : '';
    const after = /con="d"/.test(attrs) ? '\u00a0' : '';
    return before || after ? `<syl${attrs}>${before}${text}${after}</syl>` : all;
  });
}
