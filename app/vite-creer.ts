// Build step: the page « Créer l'archive de votre partition » (creer.html; create.html in English)
// carries the method written in docs/CREER.md (docs/CREATE.md), so that there is one text: read
// on GitHub, in the kit, and on the site, where a singer sends an AI (« lis cette page et suis sa
// méthode »). The Markdown is rendered here, at build time, with the app's own renderer: the page
// is plain HTML, readable by any tool that fetches it, without scripts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { renderMarkdown } from './src/util/markdown.ts';

const REPO = 'https://github.com/Bolevo/pupitre-ouvert';

/** The method as HTML. Links between the documents of the repository (relative there) point to
 *  GitHub; the title of the document is the page's own (dropped). */
export function methodHtml(md: string): string {
  const body = md
    .replace(/^# .*\n+/, '')
    .replace(/\]\(((?:\.\.\/)?[\w./-]+?)(#[\w-]+)?\)/g, (all, path: string, hash = '') => {
      if (/^https?:/.test(path)) return all;
      const file = path.startsWith('../') ? path.slice(3) : `docs/${path}`;
      return `](${REPO}/${/\.\w+$/.test(file) ? 'blob' : 'tree'}/main/${file}${hash})`;
    });
  return renderMarkdown(body);
}

/** The pages that carry a method, and the document each one renders. */
const PAGES: Record<string, string> = { 'creer.html': 'CREER.md', 'create.html': 'CREATE.md' };

export function creerPage(): Plugin {
  return {
    name: 'creer-page',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const doc = PAGES[ctx.filename.split(/[\\/]/).pop() ?? ''];
        if (!doc) return html;
        const md = readFileSync(fileURLToPath(new URL(`../docs/${doc}`, import.meta.url)), 'utf8');
        return html.replace('<!-- METHODE -->', methodHtml(md));
      },
    },
  };
}
