// Before the tests: the archives they add to the app, made from the example by the pipeline
// (pipeline/tests/layouts.py): works of every shape, as a singer's own would be. Needs Python
// with the pipeline's requirements; made once, then kept (e2e/.fixtures, not versioned).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./.fixtures', import.meta.url));
/** The archive of the example as pipeline/publish.py makes it (packs/, with its sources): what a
 *  singer receives from whoever made the archive of a score. */
export const EXAMPLE_ZIP = fileURLToPath(new URL('../../packs/locus-iste.zip', import.meta.url));

export default function setup() {
  const python = process.env.PYTHON || 'python3';
  if (!existsSync(EXAMPLE_ZIP)) {
    execFileSync(python, [fileURLToPath(new URL('../../pipeline/publish.py', import.meta.url)), 'locus-iste'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (existsSync(`${FIXTURES}/all.zip`)) return;
  const script = fileURLToPath(new URL('../../pipeline/tests/layouts.py', import.meta.url));
  execFileSync(python, [script, FIXTURES], { stdio: ['ignore', 'ignore', 'inherit'] });
}
