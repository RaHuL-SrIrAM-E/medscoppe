// Production-bundle check. Serves the BUILT app (vite preview) and drives it with mouse input in
// headless Chromium. The production bundle has no IWER emulator, so this exercises the desktop
// canvas-pointer path only, NOT hand input (that is verify-hands.sh / verify-anatomy.sh).
//
// Prerequisites (once per machine):  npm ci && npx playwright install chromium
// Usage:                             npm run build && npm run verify:production
//
// UIKit panels are drawn on the WebGL canvas, so there is no DOM to select. Instead each step
// clicks a fixed pixel position in a fixed 1280x800 viewport and asserts on measured pixels
// (count of bright pixels in a region). A click that misses therefore FAILS the assertion that
// follows it instead of passing silently. Exits non-zero on any failed assertion.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const OUT = process.env.OUT_DIR ?? 'artifacts/production';
// Explicit mode: ?consultBackend=off pins the consultation to its labelled offline replay (no backend request at all).
// Override the whole URL with PROD_URL to test another mode, e.g. ?consultBackend=on&consultDebug=1.
const URL = process.env.PROD_URL ?? 'https://127.0.0.1:4173/?consultBackend=off&consultDebug=1';
fs.mkdirSync(OUT, { recursive: true });

// --- preview server -------------------------------------------------------------------------
let server = null;
const ready = (url) =>
  new Promise((resolve) => {
    https.get(url, { rejectUnauthorized: false }, (r) => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false));
  });
if (!process.env.PROD_URL) {
  if (!fs.existsSync('dist/index.html')) { console.error('No dist/. Run `npm run build` first.'); process.exit(2); }
  server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
}
for (let i = 0; i < 40 && !(await ready(URL)); i++) await new Promise((r) => setTimeout(r, 500));
if (!(await ready(URL))) { server?.kill(); console.error('Preview server did not start.'); process.exit(2); }

// --- browser --------------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
const meter = await browser.newPage(); // scratch page used only to decode screenshots into pixel counts
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock/.test(m.text())) problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });

const MODEL = [480, 0, 320, 600]; // x, y, w, h: the anatomy column
const CARD = [60, 60, 400, 460];  // the contextual card area, left of the body
const THRESH = 70;                // luma above this counts as "lit"

async function lit(buffer, [x, y, w, h]) {
  const b64 = buffer.toString('base64');
  return meter.evaluate(async ({ b64, x, y, w, h, THRESH }) => {
    const img = new Image();
    await new Promise((ok) => { img.onload = ok; img.src = `data:image/png;base64,${b64}`; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(x, y, w, h).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > THRESH) n++;
    return n;
  }, { b64, x, y, w, h, THRESH });
}

let step = 0, failed = 0;
async function shot(name, action) {
  if (action) await action();
  await page.waitForTimeout(2200); // transitions settle: counts are then exactly repeatable
  const buf = await page.screenshot({ path: path.join(OUT, `${String(step++).padStart(2, '0')}-${name}.png`) });
  return { model: await lit(buf, MODEL), card: await lit(buf, CARD) };
}
const click = (x, y) => () => page.mouse.click(x, y);
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= Math.max(50, tol * Math.max(a, b));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(7000); // GLB, panels, first frames

// 1. Load, layers, reset
const base = await shot('baseline');
check('production bundle loads with no console errors, failed requests or 4xx', problems.length === 0, problems[0]);
check('anatomy renders (model column has lit pixels)', base.model > 5000, `${base.model} px`);
const skel = await shot('layer-skeleton', click(615, 636));
check('Skeleton chip switches the layer', skel.model > base.model * 1.5, `${base.model} -> ${skel.model} px`);
const reset = await shot('reset', click(834, 636));
check('Reset chip restores the default view exactly', near(reset.model, base.model), `${reset.model} px`);

// 2. Select, isolate, show all, close (diaphragm is the first hit at this point)
const sel = await shot('select-diaphragm', click(598, 400));
check('clicking the model selects a structure and opens the card', sel.card > 1000, `card ${sel.card} px`);
const iso = await shot('isolate', click(220, 492));
check('Isolate leaves only the selected structure', iso.model < sel.model * 0.85, `${sel.model} -> ${iso.model} px`);
const all = await shot('show-all', click(220, 492));
check('Show all restores every structure exactly', near(all.model, sel.model), `${all.model} px`);
const closed = await shot('close', click(372, 477));
check('Close removes the card and selection exactly', closed.card < 200 && near(closed.model, base.model), `card ${closed.card}, model ${closed.model} px`);

// 3. Details / Less toggle on a lung lobe (card also carries the "illustrative volume" notice)
const lobe = await shot('select-lobe', click(552, 330));
check('selecting a lobe opens its card', lobe.card > 1000, `card ${lobe.card} px`);
const more = await shot('details', click(295, 336));
check('Details expands the card (guards a missed click)', more.card > lobe.card * 1.2, `${lobe.card} -> ${more.card} px`);
const less = await shot('less', click(302, 376));
check('Less collapses the expanded card back to its compact size', near(less.card, lobe.card), `${more.card} -> ${less.card} px`);
const again = await shot('details-again', click(295, 336));
check('Details restores the expanded card', near(again.card, more.card), `${less.card} -> ${again.card} px`);

// 4. Scripted consultation (offline recorded replay): Start, beads arrive from the session, a bead opens the card.
// Pixel-based like the rest: the bead column and the card area are empty until the session produces something.
const BEADS = [800, 100, 230, 320];
const CARD_AREA = [990, 60, 290, 340];
const beforeBeads = await shot('consult-ready');
const emptyBeads = await lit(await page.screenshot(), BEADS);
const startedAt = Date.now();
await page.mouse.click(95, 707); // Start
await page.waitForTimeout(8000);
const midBeads = await lit(await page.screenshot({ path: path.join(OUT, '10-consult-listening.png') }), BEADS);
check('before Start the bead column is empty (nothing pre-populated)', emptyBeads < 300, `${emptyBeads} px`);
check('mid-replay, before the first answer is extracted, there are still no beads', midBeads < 300, `${midBeads} px`);
await page.waitForTimeout(Math.max(0, 40000 - (Date.now() - startedAt)));
const doneShot = await page.screenshot({ path: path.join(OUT, '11-consult-complete.png') });
const doneBeads = await lit(doneShot, BEADS);
check('after the replay the beads have arrived from the session', doneBeads > emptyBeads + 1500, `${emptyBeads} -> ${doneBeads} px`);
const noCard = await lit(doneShot, CARD_AREA);
await page.mouse.click(817, 232); // the Cough bead
await page.waitForTimeout(2500);
const cardShot = await page.screenshot({ path: path.join(OUT, '12-consult-card.png') });
const withCard = await lit(cardShot, CARD_AREA);
check('selecting a bead opens the observation card', withCard > noCard + 2500, `${noCard} -> ${withCard} px`);
check('no console errors during the consultation', problems.length === 0, problems[0]);

fs.writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(problems, null, 1));
await browser.close();
server?.kill();
console.log(failed === 0 ? 'ALL PRODUCTION CHECKS PASSED' : `${failed} PRODUCTION CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
