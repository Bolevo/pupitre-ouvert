// A small Markdown renderer for the work's information sheet (fiche.md): headings, paragraphs,
// bold / italic / code, links, lists (nested), tables, blockquotes, rules, hard line breaks
// (backslash or two spaces at the end of a line). All text is escaped: raw HTML in the source is
// shown as text (packs can be imported by anyone), and only http(s), mailto and in-page links
// (#…, #mv:<movement id>) become links. Small enough to live in the main bundle (no chunk loaded
// late, see ARCHITECTURE › mise à jour de l'app).

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An id for a heading: lower case, accents and punctuation dropped. */
export function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^#/.test(u) || /^(https?:|mailto:)/i.test(u)) return u;
  return null;
}

/** Inline Markdown of one block (lines joined with \n). */
export function inline(src: string): string {
  // code spans and backslash escapes are set aside first, so nothing inside them is interpreted
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code: string) => hold(`<code>${esc(code.trim())}</code>`));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c: string) => hold(esc(c)));
  // hard line breaks: a backslash or two spaces at the end of a line
  s = s.replace(/(\\| {2,})\n/g, () => hold('<br>'));
  s = esc(s);
  // links (the label may hold emphasis)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (all, label: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    if (!href) return label;
    const mv = href.match(/^#mv:(.+)$/);
    if (mv) return `<a href="${esc(href)}" data-mv="${esc(mv[1])}">${label}</a>`;
    if (href.startsWith('#')) return `<a href="${esc(href)}">${label}</a>`;
    return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>').replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, k: string) => held[Number(k)]);
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  // split on pipes not escaped
  return l.split(/(?<!\\)\|/).map((c) => c.trim());
}

const startsBlock = (line: string) => HEADING.test(line) || HR.test(line) || FENCE.test(line) || /^\s{0,3}>/.test(line) || LIST.test(line);

/** Block Markdown to HTML. */
export function renderMarkdown(src: string): string {
  return blocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function blocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = line.match(HEADING))) {
      const n = m[1].length;
      const text = m[2];
      out.push(`<h${n} id="${esc(slug(text.replace(/[*_`[\]]/g, '')))}">${inline(text)}</h${n}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (/^\s{0,3}>/.test(lines[i]) || !startsBlock(lines[i]))) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${blocks(body)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      const attr = (k: number) => (align[k] ? ` style="text-align:${align[k]}"` : '');
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const c = cells(lines[i]);
        rows.push(`<tr>${head.map((_, k) => `<td${attr(k)}>${inline(c[k] ?? '')}</td>`).join('')}</tr>`);
        i++;
      }
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((h, k) => `<th${attr(k)}>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
      );
      continue;
    }
    if ((m = line.match(LIST))) {
      const indent = m[1].length;
      const ordered = /\d/.test(m[2]);
      const items: string[][] = [];
      let loose = false;
      while (i < lines.length) {
        const l = lines[i];
        const lm = l.match(LIST);
        if (lm && lm[1].length === indent && /\d/.test(lm[2]) === ordered) {
          items.push([lm[3]]);
          i++;
          continue;
        }
        if (!l.trim()) {
          // a blank line inside the list: it goes on if the next line is indented or a new item
          const next = lines[i + 1];
          const nm = next?.match(LIST);
          if (next !== undefined && ((nm && nm[1].length === indent && /\d/.test(nm[2]) === ordered) || /^\s{2,}\S/.test(next))) {
            loose = true;
            items[items.length - 1].push('');
            i++;
            continue;
          }
          break;
        }
        const ind = l.match(/^\s*/)![0].length;
        if (ind > indent || (!startsBlock(l) && items.length)) {
          // continuation (or a nested list): drop the item's indentation
          items[items.length - 1].push(l.slice(Math.min(ind, indent + 2)));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const li = items.map((it) => {
        const html = blocks(it);
        // a tight item: its single paragraph without <p>
        return `<li>${!loose ? html.replace(/^<p>([\s\S]*?)<\/p>/, '$1') : html}</li>`;
      });
      out.push(`<${tag}>${li.join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i])) && !(lines[i].includes('|') && DELIM.test(lines[i + 1] ?? ''))) {
      para.push(lines[i].replace(/^\s+/, ''));
      i++;
    }
    if (!para.length) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}
