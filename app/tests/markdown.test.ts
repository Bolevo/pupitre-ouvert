import { describe, expect, it } from 'vitest';
import { inline, renderMarkdown } from '../src/util/markdown';

describe('fiche Markdown', () => {
  it('escapes raw HTML (imported packs)', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
  it('only safe links; movement links carry their id', () => {
    expect(inline('[x](javascript:alert)')).toBe('x');
    expect(inline('[x](javascript:alert(1))')).not.toContain('<a');
    expect(inline('[Ouvrir](#mv:mvt2)')).toBe('<a href="#mv:mvt2" data-mv="mvt2">Ouvrir</a>');
    expect(inline('[site](https://imslp.org/a?b=1&c=2)')).toContain('href="https://imslp.org/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"');
  });
  it('emphasis, code, hard breaks', () => {
    expect(inline('**Gloria** *in* excelsis')).toBe('<strong>Gloria</strong> <em>in</em> excelsis');
    expect(inline('a `*b*` c')).toBe('a <code>*b*</code> c');
    expect(inline('ligne 1\\\nligne 2')).toBe('ligne 1<br>ligne 2');
    expect(inline('ligne 1  \nligne 2')).toBe('ligne 1<br>ligne 2');
    expect(inline('snake_case_word')).toBe('snake_case_word');
  });
  it('headings with ids, lists, tables, quotes', () => {
    const html = renderMarkdown(
      [
        '# Gloria',
        '',
        '## 2 · Et in terra pax',
        '',
        '- un',
        '- deux',
        '  - deux bis',
        '',
        '1. premier',
        '2. second',
        '',
        '| N° | Ton |',
        '|---|:---:|',
        '| 1 | Ré majeur |',
        '',
        '> cité',
        '> encore',
      ].join('\n'),
    );
    expect(html).toContain('<h1 id="gloria">Gloria</h1>');
    expect(html).toContain('<h2 id="2-et-in-terra-pax">');
    expect(html).toContain('<ul><li>un</li><li>deux\n<ul><li>deux bis</li></ul></li></ul>');
    expect(html).toContain('<ol><li>premier</li><li>second</li></ol>');
    expect(html).toContain('<th style="text-align:center">Ton</th>');
    expect(html).toContain('<td style="text-align:center">Ré majeur</td>');
    expect(html).toContain('<blockquote><p>cité\nencore</p></blockquote>');
  });
  it('a paragraph stops at a heading or a list', () => {
    expect(renderMarkdown('texte\n## Titre\nsuite')).toBe('<p>texte</p>\n<h2 id="titre">Titre</h2>\n<p>suite</p>');
  });
});
