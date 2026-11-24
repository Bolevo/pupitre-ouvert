// Screenshots and the short video of the help page (app/aide.html, and app/help.html in English),
// taken on the built app, on the work it opens on (scores/locus-iste). Usage, from app/
// (the build served on PORT):
//   PW_CHROMIUM=<chrome> [SHOTS_LANG=en] node ../tools/help/shots.cjs <port> <out dir> [names…]
// Writes <out>/<name>.png (raw; help_images.py makes the WebP and the video of the page).
// The controls are found by their class, not by their name: the same script serves both languages.
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');

const [port, out, ...only] = process.argv.slice(2);
const URL = `http://localhost:${port}/${process.env.SHOTS_LANG === 'en' ? '?lang=en' : ''}`;
mkdirSync(out, { recursive: true });

const PHONE = { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1366, height: 820 }, deviceScaleFactor: 1.5 };

let browser;
async function open(kind, { video, init } = {}) {
  const ctx = await browser.newContext({ ...(kind === 'phone' ? PHONE : DESK), ...(video ? { recordVideo: { dir: out, size: video } } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('page error:', e.message));
  if (init) await init(p);
  await p.goto(URL);
  await p.locator('.lane-svg > svg').waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
  return { ctx, p };
}

/** The demo as shown on the help: the work the app opens on, as it opens - the voice it follows
 *  at first (the tenor), its words under the line. */
async function setUp(p) {
  await p.waitForTimeout(600);
}

/** Clicks the middle of printed measure n on the page shown (box from the pack). */
async function clickMeasure(p, n) {
  const pack = await p.evaluate(() => fetch('packs/locus-iste/pack.json').then((r) => r.json()));
  const pg = pack.pages.find((x) => x.measures.some((b) => b.n === n));
  const b = pg.measures.find((x) => x.n === n);
  const sheet = p.locator('.sheet', { has: p.locator(`img[alt$=" ${pg.page}"]`) });
  const box = await sheet.boundingBox();
  const k = box.width / pg.w;
  await sheet.click({ position: { x: ((b.x0 + b.x1) / 2) * k, y: (b.y0 + 40) * k } });
}

const shots = {
  // the first thing to do: choose one's voice (the menu of the line's header, open)
  async voice() {
    const { ctx, p } = await open('phone');
    await p.locator('.lane-voice').click();
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/voice.png` });
    await ctx.close();
  },
  // the main screen while it plays: page, line of my voice, bars
  async hero() {
    const { ctx, p } = await open('phone');
    await setUp(p, true);
    await clickMeasure(p, 5);
    await p.waitForTimeout(2600);
    await p.screenshot({ path: `${out}/hero.png` });
    // the tracks, open (the music goes on)
    await p.locator('.tracks-toggle').click();
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/tracks.png` });
    await ctx.close();
  },
  async desk() {
    const { ctx, p } = await open('desk');
    await setUp(p, false);
    await clickMeasure(p, 9);
    await p.waitForTimeout(2600);
    await p.screenshot({ path: `${out}/desk.png` });
    await p.locator('.play').click();
    await p.waitForTimeout(300);
    // the metronome's menu and the end of the movement (top right)
    await p.locator('.metro-more').click();
    await p.waitForTimeout(300);
    const menu = await p.locator('.metro-menu').boundingBox();
    const tb = await p.locator('.topbar').boundingBox();
    const x = Math.min(menu.x, (await p.locator('.metro').boundingBox()).x) - 12;
    await p.screenshot({ path: `${out}/metro.png`, clip: { x, y: 0, width: tb.width - x, height: menu.y + menu.height + 12 } });
    await p.keyboard.press('Escape');
    // the work's sheet, then « Apprendre le texte »
    await p.locator('.fiche-btn').click();
    await p.waitForTimeout(500);
    await p.locator('.fiche-memo').click();
    await p.locator('.memo .memo-input').waitFor();
    await p.waitForTimeout(300);
    await p.locator('.memo .memo-input').focus();
    await p.keyboard.type('liadfe', { delay: 60 });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/memo.png` });
    await ctx.close();
  },
  // a long press on a note of the line: its name, the note held
  async hold() {
    const { ctx, p } = await open('phone');
    await setUp(p, true);
    const notes = p.locator('.lane-svg > svg g.note');
    const b = await notes.nth(2).boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${out}/hold.png` });
    await p.mouse.up();
    // the tempo
    await p.locator('.tempo-btn').click();
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/tempo.png` });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    // « Aller à »
    await p.locator('.pn-where').click();
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/goto.png` });
    await p.keyboard.press('Escape');
    // « Enregistrer ma voix » switched on: its panel under the bar
    await p.locator('.tracks-toggle').click();
    await p.locator('.tracks-rec').click();
    await p.locator('.tracks-toggle').click();
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/rec.png` });
    await ctx.close();
  },
  // the short video: the music plays, the page and the line follow. Frames from the browser's
  // screencast in the phone's own pixels (Playwright's video is in CSS pixels: blurred on a phone),
  // written with their times for ffmpeg (help_images.py)
  async video() {
    // a browser of its own, drawing at twice the CSS pixels (the screencast keeps them)
    const main = browser;
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=2'] });
    const { ctx, p } = await open('phone');
    await setUp(p, true);
    const cdp = await ctx.newCDPSession(p);
    const frames = [];
    mkdirSync(`${out}/frames`, { recursive: true });
    cdp.on('Page.screencastFrame', async (f) => {
      frames.push({ t: f.metadata.timestamp, data: f.data });
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 720, maxHeight: 1560 });
    await p.waitForTimeout(500);
    await clickMeasure(p, 1);
    await p.waitForTimeout(9000);
    await cdp.send('Page.stopScreencast');
    const { writeFileSync } = require('node:fs');
    const list = [];
    frames.forEach((f, i) => {
      const name = `f${String(i).padStart(4, '0')}.png`;
      writeFileSync(`${out}/frames/${name}`, Buffer.from(f.data, 'base64'));
      const next = frames[i + 1]?.t ?? f.t + 0.04;
      list.push(`file '${name}'`, `duration ${(next - f.t).toFixed(3)}`);
    });
    writeFileSync(`${out}/frames/list.txt`, list.join('\n') + '\n');
    console.log(`${frames.length} frames`);
    await ctx.close();
    await browser.close();
    browser = main;
  },
};

(async () => {
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const [name, fn] of Object.entries(shots)) {
    if (only.length && !only.includes(name)) continue;
    process.stdout.write(`${name}… `);
    await fn();
    console.log('ok');
  }
  await browser.close();
})();
