import { expect, test, type Page } from '@playwright/test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { FIXTURES } from './setup';

const EXAMPLE = 'Anton Bruckner — Locus iste'; // the work the app opens on
const EXAMPLES = [EXAMPLE, 'Franz Schubert — Messe en sol — Kyrie']; // the works that come with the app
const IMPORT = '__import__';
const MANAGE = '__manage__';
const ACTIONS = ['Ajouter une partition (.zip)…', 'Gérer mes partitions…']; // what the list of works ends with

const works = (page: Page) => page.locator('.work-select option').allTextContents();
const current = (page: Page) => page.locator('.work-select').evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent ?? '');
const laneLeft = (page: Page) => page.locator('.lane-svg').evaluate((e) => e.getBoundingClientRect().left);
const lane = (page: Page) => expect(page.locator('.lane-svg > svg')).toBeAttached({ timeout: 20000 });

/** The app, opened on the example, with nothing kept from another test. */
async function ready(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await lane(page);
  await expect.poll(() => current(page)).toBe(EXAMPLE);
  return errors;
}

/** Adds an archive through the list of works, as a singer does. */
async function add(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.work-select').selectOption(IMPORT);
  await (await chooser).setFiles(file);
}

/** « Mes partitions », opened from the list of works. */
async function manage(page: Page) {
  await page.locator('.work-select').selectOption(MANAGE);
  const panel = page.getByRole('dialog', { name: /^(Mes partitions|My scores)$/ });
  await expect(panel).toBeVisible();
  return panel;
}

/** The music goes on: the line of the voice keeps moving left under the playhead. */
async function plays(page: Page, play = 'Lecture') {
  await page.locator('.play').click();
  await expect(page.locator('.play')).toHaveAttribute('aria-label', 'Pause');
  const l0 = await laneLeft(page);
  await expect.poll(() => laneLeft(page), { timeout: 10000 }).toBeLessThan(l0 - 10);
  await page.locator('.play').click();
  await expect(page.locator('.play')).toHaveAttribute('aria-label', play);
}

test('the app opens on the example: its pages, the line of a voice, and it plays', async ({ page }) => {
  const errors = await ready(page);
  await expect(page).toHaveTitle('Pupitre Ouvert');
  await expect(page.locator('img[alt="Page 8"]')).toBeVisible(); // the pages keep the numbers printed on them
  await expect(page.locator('.lane-voice')).toHaveText('Ténor');
  // the list: the examples, then its two actions
  expect(await works(page)).toEqual([...EXAMPLES, ...ACTIONS]);
  await plays(page);
  await expect(page.locator('.pn-page')).toContainText('8');
  // nothing of the app is kept under the names of its sibling on the same site (bolevo.github.io/Pupitre)
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) expect(k).toMatch(/^pupitre-ouvert/);
  expect(await page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name)))).toContain('pupitre-ouvert');
  expect(errors).toEqual([]);
});

test('the second example opens too: a soloist, the choir and the piano', async ({ page }) => {
  const errors = await ready(page);
  await page.locator('.work-select').selectOption({ label: EXAMPLES[1] });
  await expect.poll(() => current(page)).toBe(EXAMPLES[1]);
  await lane(page);
  await expect(page.locator('img[alt="Page 1"]')).toBeVisible();
  // four voices and the accompaniment, each with its track
  await expect(page.locator('.track-rows .t-name')).toHaveText(['Soprano', 'Alto', 'Ténor', 'Basse', 'Piano']);
  await plays(page);
  // the work left open is the one found at the next visit
  await page.reload();
  await lane(page);
  await expect.poll(() => current(page)).toBe(EXAMPLES[1]);
  expect(errors).toEqual([]);
});

test('a work added stays: there after a reload, replaced by a new version, removed on request', async ({ page }) => {
  const errors = await ready(page);
  await add(page, `${FIXTURES}/all.zip`);
  const mine = 'J. S. Bach — Deux chorals (all)';
  await expect.poll(() => current(page)).toBe(mine);
  await lane(page);
  await expect(page.locator('img[alt="Page 1"]')).toBeVisible();
  expect(await works(page)).toEqual([...EXAMPLES, mine, ...ACTIONS]);
  await plays(page);

  // kept in the browser: the work is there, and open, at the next visit
  await page.reload();
  await lane(page);
  await expect.poll(() => current(page)).toBe(mine);

  // a corrected archive (same id) takes the place of the first: one entry, the new title
  const files = unzipSync(readFileSync(`${FIXTURES}/all.zip`));
  const pack = JSON.parse(Buffer.from(files['pack.json']).toString('utf8'));
  pack.title = 'Deux chorals, corrigés';
  await add(page, { name: 'v2.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ ...files, 'pack.json': strToU8(JSON.stringify(pack)) })) });
  await expect.poll(() => current(page)).toBe('J. S. Bach — Deux chorals, corrigés');
  expect((await works(page)).filter((w) => w.startsWith('J. S. Bach'))).toHaveLength(1);

  // « Mes partitions »: the work on the screen is marked; a work added can be removed, an example hidden
  const panel = await manage(page);
  const rows = panel.locator('.lib-list > li');
  await expect(rows.locator('.lib-work b')).toHaveText(['Locus iste', 'Messe en sol — Kyrie', 'Deux chorals, corrigés']);
  await expect(rows.nth(2).locator('.lib-work')).toHaveAttribute('aria-current', 'true');
  await expect(rows.locator('.lib-act')).toHaveText(['Masquer', 'Masquer', 'Retirer']);
  // declined: nothing happens; accepted: the work goes, the example is on the screen, also after a reload
  await panel.getByRole('button', { name: 'Retirer « Deux chorals, corrigés »' }).click();
  await expect(panel.locator('.lib-ask')).toContainText('Retirer « Deux chorals, corrigés » de cet appareil ?');
  await expect(panel.getByRole('button', { name: 'Annuler' })).toBeFocused();
  await panel.getByRole('button', { name: 'Annuler' }).click();
  await expect(panel.locator('.lib-ask')).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await panel.getByRole('button', { name: 'Retirer « Deux chorals, corrigés »' }).click();
  await panel.locator('.lib-ask').getByRole('button', { name: 'Retirer' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.lib-work')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect.poll(() => current(page)).toBe(EXAMPLE);
  await lane(page);
  expect(await works(page)).toEqual([...EXAMPLES, ...ACTIONS]);
  await page.reload();
  await lane(page);
  expect(await works(page)).toEqual([...EXAMPLES, ...ACTIONS]);
  expect(errors).toEqual([]);
});

test('« Mes partitions »: an example is hidden on this device and put back; a work is opened and added from there', async ({ page }) => {
  const errors = await ready(page);
  let panel = await manage(page);
  // the keys of the app are not for what is behind the panel: R (play my voice again) starts nothing
  await page.keyboard.press('r');
  await expect(panel).toBeVisible();
  await expect(page.locator('.play')).toHaveAttribute('aria-label', 'Lecture');
  // the example on the screen is hidden: the other one takes its place, nothing is erased
  await panel.getByRole('button', { name: 'Masquer « Locus iste »' }).click();
  await expect(panel.locator('.lib-list:not(.lib-hidden) .lib-work b')).toHaveText(['Messe en sol — Kyrie']);
  await expect(panel.locator('.lib-hidden .lib-work b')).toHaveText(['Locus iste']);
  await panel.getByRole('button', { name: 'Fermer' }).click();
  await expect.poll(() => current(page)).toBe(EXAMPLES[1]);
  await lane(page);
  expect(await works(page)).toEqual([EXAMPLES[1], ...ACTIONS]);
  // kept by the browser: still hidden at the next visit
  await page.reload();
  await lane(page);
  await expect.poll(() => current(page)).toBe(EXAMPLES[1]);
  expect(await works(page)).toEqual([EXAMPLES[1], ...ACTIONS]);

  // the last one hidden too: the empty screen offers to add a score or to put the examples back
  panel = await manage(page);
  await panel.getByRole('button', { name: 'Masquer « Messe en sol — Kyrie »' }).click();
  await expect(panel.locator('.lib-none')).toBeVisible();
  await page.mouse.click(1200, 700); // a press beside the panel closes it
  await expect(panel).toHaveCount(0);
  await expect(page.getByText('Aucune partition dans cette app pour l’instant.')).toBeVisible();
  expect(await works(page)).toEqual(['Mes partitions', ...ACTIONS]);
  await page.reload();
  await expect(page.getByText('Aucune partition dans cette app pour l’instant.')).toBeVisible();

  // a work is added from the panel: it opens, the panel closes
  panel = await manage(page);
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Ajouter une partition (.zip)…' }).click();
  await (await chooser).setFiles(`${FIXTURES}/solo.zip`);
  await expect(panel).toHaveCount(0);
  await expect.poll(() => current(page)).toBe('J. S. Bach — Deux chorals (solo)');
  await lane(page);

  // one example is put back from the panel, and opened from there
  panel = await manage(page);
  await panel.getByRole('button', { name: 'Remettre « Messe en sol — Kyrie »' }).click();
  await expect(panel.locator('.lib-list:not(.lib-hidden) .lib-work b')).toHaveText(['Messe en sol — Kyrie', 'Deux chorals (solo)']);
  await panel.locator('button.lib-work', { hasText: 'Messe en sol — Kyrie' }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => current(page)).toBe(EXAMPLES[1]);
  await lane(page);
  // (its pages show, although the screen came back with a work that has none)
  await expect(page.locator('img[alt="Page 1"]')).toBeVisible();

  // an archive that is refused says why in the panel itself
  panel = await manage(page);
  const again = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Ajouter une partition (.zip)…' }).click();
  await (await again).setFiles({ name: 'photo.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(panel.getByRole('alert')).toContainText('Ce fichier n’est pas une archive .zip lisible.');

  // the work added is removed, the examples all put back from the empty screen
  await panel.getByRole('button', { name: 'Retirer « Deux chorals (solo) »' }).click();
  await panel.locator('.lib-ask').getByRole('button', { name: 'Retirer' }).click();
  await panel.getByRole('button', { name: 'Masquer « Messe en sol — Kyrie »' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remettre les exemples' }).click();
  await lane(page);
  await expect.poll(() => current(page)).toBe(EXAMPLE);
  expect(await works(page)).toEqual([...EXAMPLES, ...ACTIONS]);
  // (the key that did nothing behind the panel does start the music here)
  await page.keyboard.press('r');
  await expect(page.locator('.play')).toHaveAttribute('aria-label', 'Pause');
  await page.locator('.play').click();
  expect(errors).toEqual([]);
});

for (const [name, voice] of [
  ['solo', 'Ténor'],
  ['duo', 'Soprano'],
  ['trio', 'Soprano'],
  ['voice-keyboard', 'Soprano'],
  ['instruments', 'Violin'],
  ['no-pages', 'Ténor'],
] as const) {
  test(`a work of another shape opens and plays: ${name}`, async ({ page }) => {
    const errors = await ready(page);
    await add(page, `${FIXTURES}/${name}.zip`);
    await expect.poll(() => current(page)).toBe(`J. S. Bach — Deux chorals (${name})`);
    await lane(page);
    await expect(page.locator('.error')).toHaveCount(0);
    // the voice followed: the singer's own (the tenor) where the work has it, else its first
    await expect(page.locator('.lane-voice')).toHaveText(voice);
    await expect(page.getByText('Pas d’images de pages pour cette œuvre.')).toBeVisible();
    await plays(page);
    if (name === 'solo') {
      // the app started on a work without pages: the pages of the next work opened are shown
      await page.reload();
      await lane(page);
      await expect(page.getByText('Pas d’images de pages pour cette œuvre.')).toBeVisible();
      await page.locator('.work-select').selectOption({ label: EXAMPLE });
      await expect(page.locator('img[alt="Page 8"]')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

test('an archive the app could not show is refused, with what to correct', async ({ page }) => {
  await ready(page);
  const files = unzipSync(readFileSync(`${FIXTURES}/all.zip`));
  const pack = JSON.parse(Buffer.from(files['pack.json']).toString('utf8'));
  pack.id = 'broken';
  pack.movements[0].mei = 'absent.mei';
  delete files['pages/p002.webp'];
  await add(page, { name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ ...files, 'pack.json': strToU8(JSON.stringify(pack)) })) });
  const error = page.locator('.error');
  await expect(error).toContainText('Import impossible. L’archive est à corriger :');
  await expect(error).toContainText('Mouvement 1 : le fichier absent.mei n’est pas dans l’archive.');
  await expect(error).toContainText('Page 2 : l’image pages/p002.webp n’est pas dans l’archive.');
  // the example is still there, nothing was added
  expect(await current(page)).toBe(EXAMPLE);
  expect(await works(page)).toEqual([...EXAMPLES, ...ACTIONS]);
  await error.getByRole('button', { name: 'Fermer' }).click();
  await expect(error).toHaveCount(0);
  // a file that is no archive at all
  await add(page, { name: 'photo.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(error).toContainText('Ce fichier n’est pas une archive .zip lisible.');
});

test('the help says how to add a score, and the page for an AI carries the method and the kit', async ({ page, request }) => {
  await page.goto('/aide.html');
  await expect(page).toHaveTitle('Aide de Pupitre Ouvert');
  await expect(page.locator('#partitions h2')).toHaveText('Vos partitions');
  await page.locator('#partitions a', { hasText: 'Créer l’archive de ma partition' }).click();
  await expect(page).toHaveURL(/creer\.html$/);
  await expect(page.locator('h1')).toHaveText('Créer l’archive de votre partition');
  // the method of docs/CREER.md, rendered in the page itself (no script needed to read it)
  await expect(page.locator('#methode h2', { hasText: 'Le chemin éprouvé' })).toBeVisible();
  await expect(page.locator('#methode pre', { hasText: 'python pipeline/publish.py <id>' }).first()).toBeAttached();
  const html = await (await request.get('/creer.html')).text();
  expect(html).toContain('python tools/source.py scores/&lt;id&gt; partition.pdf');
  expect(html).not.toContain('<!-- METHODE -->');
  // the sentence a singer gives to an AI names this page
  await expect(page.locator('#phrase')).toContainText('https://bolevo.github.io/pupitre-ouvert/creer.html');
  // the kit is served beside the app, with the tools and the example
  const kit = await request.get('/kit.zip');
  expect(kit.ok()).toBe(true);
  const names = Object.keys(unzipSync(new Uint8Array(await kit.body())));
  for (const f of ['docs/CREER.md', 'docs/CREATE.md', 'docs/ARCHIVE.md', 'LICENSE', 'pipeline/publish.py', 'pipeline/check_pack.py', 'pipeline/requirements.txt', 'tools/source.py', 'tools/omr/pages.py', 'pipeline/cht/heads.py', 'scores/locus-iste/work.yaml', 'scores/locus-iste/src/008.cht', 'scores/locus-iste/source.pdf', 'scores/schubert-kyrie/src/003.cht']) {
    expect(names).toContain(`pupitre-ouvert/${f}`);
  }
  expect(names.filter((n) => n.startsWith('pupitre-ouvert/app/'))).toEqual([]);
});

test('English: chosen in the settings, kept, asked by ?lang=en, and the pages of the site in English', async ({ page }) => {
  const errors = await ready(page);
  // French unless asked otherwise
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('.lane-voice')).toHaveText('Ténor');
  await expect(page.locator('.tracks-help')).toHaveAttribute('href', 'aide.html');
  // the choice is in the settings, each language named in itself
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.lane-voice')).toHaveText('Tenor');
  await expect(page.locator('.play')).toHaveAttribute('aria-label', 'Play');
  await expect(page.locator('.tracks-help')).toHaveAttribute('href', 'help.html');
  expect(await works(page)).toEqual([...EXAMPLES, 'Add a score (.zip)…', 'Manage my scores…']);
  // an archive that is refused says why in the same language (the check runs in a worker)
  await add(page, { name: 'photo.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(page.locator('.error')).toContainText('This file is not a readable .zip archive.');
  await page.locator('.error').getByRole('button', { name: 'Close' }).click();
  // kept on this device
  await page.reload();
  await lane(page);
  await expect(page.locator('.lane-voice')).toHaveText('Tenor');
  await plays(page, 'Play');
  // and back
  await page.getByRole('radio', { name: 'Français' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('.lane-voice')).toHaveText('Ténor');
  // a link can ask for English (the English pages do); the parameter does not stay in the address
  await page.goto('/?lang=en');
  await lane(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.lane-voice')).toHaveText('Tenor');
  expect(errors).toEqual([]);

  // the help and the page for an AI, in English, each one step from its French twin
  await page.goto('/help.html');
  await expect(page).toHaveTitle('Pupitre Ouvert help');
  await expect(page.locator('#scores h2')).toHaveText('Your scores');
  await page.locator('#scores a', { hasText: 'Make the archive of my score' }).click();
  await expect(page).toHaveURL(/create\.html$/);
  await expect(page.locator('h1')).toHaveText('Make the archive of your score');
  await expect(page.locator('#method h2', { hasText: 'The proven path' })).toBeVisible();
  await expect(page.locator('#method pre', { hasText: 'python pipeline/publish.py <id>' }).first()).toBeAttached();
  await expect(page.locator('#phrase')).toContainText('https://bolevo.github.io/pupitre-ouvert/create.html');
  await page.locator('.other-lang').click();
  await expect(page).toHaveURL(/creer\.html$/);
  await page.locator('.other-lang').click();
  await expect(page).toHaveURL(/create\.html$/);
  await page.locator('.masthead .open-app').click();
  await lane(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
