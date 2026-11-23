// Build step: which commit the app is built from, for the « Version » line at the bottom of the
// track list (src/version.ts).
//
// It is written in index.html (a <meta>), not in the scripts. The scripts are named by their
// content: with the commit inside, every deployment would make every phone download them again,
// even one that only brings new scores. index.html is a few hundred bytes. And the page reads its
// own <meta>: what it shows is the version of the page that is running, even when the service
// worker has already fetched the next one.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface Checkout {
  /** the commit checked out; null outside a git checkout (a plain copy of the files, the kit) */
  sha: string | null;
  /** its date (ISO 8601) */
  date: string | null;
  /** tracked files were modified since that commit */
  dirty: boolean;
}

/** What index.html carries: "8e96241 2026-11-10T07:55:12+00:00" (short commit, its date);
 *  "8e96241+ <now>" when built with changes not committed; "- <now>" outside git. */
export function describeVersion(c: Checkout, now: Date): string {
  if (!c.sha) return `- ${now.toISOString()}`;
  const short = c.sha.slice(0, 7);
  return c.dirty || !c.date ? `${short}${c.dirty ? '+' : ''} ${now.toISOString()}` : `${short} ${c.date}`;
}

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null; // no git, or not a checkout
  }
}

function checkout(): Checkout {
  const sha = git('rev-parse', 'HEAD');
  if (!sha) return { sha: process.env.GITHUB_SHA || null, date: null, dirty: false };
  return { sha, date: git('log', '-1', '--format=%cI'), dirty: !!git('status', '--porcelain', '--untracked-files=no') };
}

/** Adds <meta name="pupitre-version" content="…"> to index.html (build and dev server). */
export function appVersion(): Plugin {
  return {
    name: 'pupitre:version',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'pupitre-version', content: describeVersion(checkout(), new Date()) }, injectTo: 'head' }],
  };
}
