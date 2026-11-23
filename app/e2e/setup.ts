// Before the tests: the archives they add to the app, made from the example by the pipeline
// (pipeline/tests/layouts.py): works of every shape, as a singer's own would be. Needs Python
// with the pipeline's requirements; made once, then kept (e2e/.fixtures, not versioned).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./.fixtures', import.meta.url));

export default function setup() {
  if (existsSync(`${FIXTURES}/all.zip`)) return;
  const script = fileURLToPath(new URL('../../pipeline/tests/layouts.py', import.meta.url));
  execFileSync(process.env.PYTHON || 'python3', [script, FIXTURES], { stdio: ['ignore', 'ignore', 'inherit'] });
}
