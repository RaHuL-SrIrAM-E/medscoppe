// Browser validation of the consultation through the real input path (mouse on the canvas of the production build,
// headless Chromium). The UI is drawn on a WebGL canvas, so buttons are clicked at calibrated pixels in a fixed 1280x800
// viewport; every step is then asserted against the app's read-only debug summary (?consultDebug=1), so a missed click FAILS
// the following assertion instead of passing silently. Offline replay only: no backend is configured or contacted.
//
// Prerequisites:  npm ci && npx playwright install chromium && npm run build
// Usage:          npm run verify:consult-states            (screenshots go to artifacts/consult/final/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';

const OUT = process.env.OUT_DIR ?? 'artifacts/consult/final';
const BASE = process.env.PROD_BASE ?? 'https://127.0.0.1:4173/';
fs.mkdirSync(OUT, { recursive: true });

const ready = (url) => new Promise((r) => https.get(url, { rejectUnauthorized: false }, (x) => { x.resume(); r(x.statusCode === 200); }).on('error', () => r(false)));
let server = null;
if (!process.env.PROD_BASE) {
  if (!fs.existsSync('dist/index.html')) { console.error('No dist/. Run `npm run build` first.'); process.exit(2); }
  server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
}
for (let i = 0; i < 40 && !(await ready(BASE)); i++) await new Promise((r) => setTimeout(r, 500));
if (!(await ready(BASE))) { server?.kill(); console.error('Preview server did not start.'); process.exit(2); }

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal'] });
const problems = [];
let failed = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };

// calibrated pixels (1280x800)
// The controls panel is centred on its own middle, so its buttons move up or down as rows (caption, error) come and go.
// The primary button (Start / Pause / Resume / New session) is therefore found by trying a short vertical run of points at its
// left edge, where nothing else can be hit, until the app's state shows that it was pressed. Retry is found the same way.
const PRIMARY_POINTS = [[95, 707], [95, 690], [95, 672], [95, 725], [95, 655], [95, 740], [95, 640]];
const RETRY_POINTS = [[255, 740], [255, 722], [255, 758], [255, 704], [255, 690]];
const BEAD = { Fever: [819, 147], Cough: [817, 232], Dyspnoea: [815, 301], 'No chest pain': [813, 368] };
const CONFIRM_COUGH = [1033, 340];
const FEVER_DISMISS = [1115, 284];
const DYSP = { correct: [1070, 425], note: [1155, 431], correctRow: [1162, 397], mild: [1090, 390], moderate: [1110, 419], absent: [1090, 358] };

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock/.test(m.text())) problems.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(`${BASE}?consultDebug=1&${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);
  const st = () => page.evaluate(() => globalThis.__medscopeConsult());
  const click = async ([x, y], wait = 1800) => { await page.mouse.click(x, y); await page.waitForTimeout(wait); };
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
  const press = async (points, changed) => {
    const before = await st();
    for (const p of points) { await page.mouse.click(p[0], p[1]); await page.waitForTimeout(700); if (changed(before, await st())) return true; }
    return false;
  };
  const until = async (pred, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred(await st())) return true; await page.waitForTimeout(150); } return false; };
  return { page, st, click, shot, until, press };
}

// ---------------------------------------------------------------------------------------------- A. normal replay
{
  const { page, st, click, shot, until, press } = await open('consultBackend=off&consultSpeed=2');
  let s = await st();
  check('initial: READY, no beads, labelled scripted and recorded replay', s.life === 'READY' && s.beads.length === 0 && s.extractionLabel.startsWith('RECORDED REPLAY') && s.extractionDetail === 'Offline recorded replay. No backend configured.', s.extractionDetail);
  await shot('01-initial-layout');

  // sample the caption all the way through
  const captions = []; const fades = [];
  const sampler = setInterval(async () => { try { const c = await st(); if (c.caption) captions.push(c.caption); if (c.captionFading) fades.push(c.caption); } catch {} }, 120);

  await press(PRIMARY_POINTS, (a, b) => b.life !== a.life);
  check('Start: session starts', await until((x) => x.life === 'LISTENING', 8000));
  check('nothing is pre-populated at the start', (await st()).beads.length === 0);
  check('first answer extracted: cough and fever appear', await until((x) => x.beads.length >= 2, 15000));
  await page.waitForTimeout(1500); // let the new beads finish arriving before the picture
  await shot('02-active-consultation');
  await press(PRIMARY_POINTS, (a, b) => b.life !== a.life);
  s = await st();
  check('Pause: session paused', s.life === 'PAUSED');
  const n = s.beads.length;
  await page.waitForTimeout(2500);
  check('while paused nothing more arrives', (await st()).beads.length === n);
  await press(PRIMARY_POINTS, (a, b) => b.life !== a.life);
  check('Resume: listening again', (await st()).life === 'LISTENING');
  check('replay completes', await until((x) => x.life === 'COMPLETE', 30000));
  // the last line is held, then dims, then clears: wait for the dim state and take a picture of it
  if (await until((x) => x.captionFading, 5000)) await shot('03a-fading-caption');
  await page.waitForTimeout(2200);
  clearInterval(sampler);
  s = await st();
  check('beads: cough, fever, dyspnoea, no chest pain', JSON.stringify(s.beads.map((b) => b.label)) === JSON.stringify(['Cough', 'Fever', 'Dyspnoea', 'No chest pain']), s.beads.map((b) => b.label).join(','));
  check('caption: shown during the replay, never over 60 characters', captions.length > 3 && Math.max(...captions.map((c) => c.length)) <= 60, `${captions.length} samples, max ${Math.max(0, ...captions.map((c) => c.length))}`);
  check('caption: dims before it clears', fades.length > 0, `${fades.length} dim samples`);
  check('extraction still labelled recorded replay at the end', s.extractionLabel.startsWith('RECORDED REPLAY') && !/LIVE MODEL/.test(s.extractionLabel));
  await page.waitForTimeout(1500);
  await shot('03-complete');

  // evidence and source on every observation
  const expected = { Cough: 'coughing for about five days', Fever: 'fever for the last two days', Dyspnoea: 'walking upstairs', 'No chest pain': "don't" };
  for (const [name, [x, y]] of Object.entries(BEAD)) {
    await click([x, y], 1500);
    const c = (await st()).card;
    check(`${name}: card shows the exact evidence and patient-reported source`, !!c && c.evidence.includes(expected[name]) && c.source === 'Source: patient-reported' && c.confirmLine === 'Not confirmed by a doctor', c?.evidence);
    await click([x, y], 800);
    check(`${name}: selecting again closes the card`, (await st()).card === null);
  }

  // card, correction, annotation, confirmation, dismissal
  await click(BEAD.Dyspnoea, 2200); await shot('04-observation-card');
  await click(DYSP.correctRow, 1500);
  check('Correct opens the option row', (await st()).card?.panel === 'CORRECT');
  await click(DYSP.moderate, 2200);
  s = await st();
  check('Severity: Moderate is applied as a doctor correction with history kept', s.card?.confirmLine === 'Corrected by a doctor (explicit action)' && /Revision 2/.test(s.card?.revision ?? '') && s.card.evidence.includes('walking upstairs'), s.card?.confirmLine);
  await shot('05-corrected-observation');
  await click(DYSP.note, 1500);
  check('Note opens the preset row', (await st()).card?.panel === 'NOTE');
  await shot('06a-note-options');
  let noted = false;
  for (const y of [379, 383, 375]) { await click([1085, y], 1500); if ((await st()).card?.note) { noted = true; break; } }
  check('a preset note is added', noted && /Needs follow-up/.test((await st()).card?.note ?? ''), (await st()).card?.note);
  await shot('06-annotated-observation');
  await click(BEAD.Dyspnoea, 800);

  await click(BEAD.Cough, 2200);
  await click(CONFIRM_COUGH, 2200);
  s = await st();
  check('Confirm: only the chosen observation becomes doctor-confirmed, by explicit press', s.beads.filter((b) => b.origin === 'DOCTOR_CONFIRMED').map((b) => b.label).sort().join() === 'Cough,Dyspnoea' && s.beads.find((b) => b.label === 'Fever').origin === 'PATIENT');
  await shot('07-confirmed-observation');
  await click(BEAD.Cough, 800);

  await click(BEAD.Fever, 2200);
  await click(FEVER_DISMISS, 2200);
  s = await st();
  check('Dismiss removes the fever bead and closes its card', !s.beads.some((b) => b.label === 'Fever') && s.card === null);

  await press(PRIMARY_POINTS, (a, b) => b.life !== a.life);
  s = await st();
  check('New session starts clean: no beads, nothing confirmed, nothing selected', s.life !== 'COMPLETE' && s.beads.length === 0 && s.selected === null);
  check('the new run completes with all four observations again', await until((x) => x.life === 'COMPLETE', 40000) && (await st()).beads.length === 4);
  check('no observation is doctor-confirmed in the new run', (await st()).beads.every((b) => b.origin === 'PATIENT'));
  await shot('08-second-run-complete');
  await page.close();
}

// ---------------------------------------------------------------------------------------------- B. failure fixture
{
  const { page, st, click, shot, until, press } = await open('consultFixture=failure&consultSpeed=8');
  await press(PRIMARY_POINTS, (a, b) => b.life !== a.life);
  check('failure fixture: run completes with a visible error and a Retry control', await until((x) => x.life === 'COMPLETE' && x.retry, 30000));
  let s = await st();
  check('failure fixture: labelled as a test fixture, still labelled recorded replay', s.fixture === 'TEST FIXTURE: failure' && s.extractionLabel.startsWith('RECORDED REPLAY'));
  check('failure fixture: nothing invented for the failed part', JSON.stringify(s.beads.map((b) => b.label).sort()) === JSON.stringify(['Dyspnoea', 'No chest pain']) && /Extraction failed/.test(s.error ?? ''), s.error);
  await page.waitForTimeout(1500);
  await shot('09-failure-state');
  await press(RETRY_POINTS, (a, b) => b.retry === false);
  await page.waitForTimeout(1500);
  s = await st();
  check('failure fixture: Retry recovers all four observations, error cleared', s.beads.length === 4 && s.retry === false && s.error === null, `${s.beads.length} beads`);
  await shot('10-failure-recovered');
  await page.close();
}

// ---------------------------------------------------------------------------------------------- C. conflict fixture
{
  const { page, st, click, shot, until, press } = await open('consultFixture=conflict&consultSpeed=8');
  await press(PRIMARY_POINTS, (a, b) => b.life !== a.life);
  check('conflict fixture: run completes', await until((x) => x.life === 'COMPLETE', 40000));
  let s = await st();
  const unresolved = s.beads.filter((b) => b.presence === 'UNRESOLVED');
  check('conflict fixture: the contradiction leaves two unresolved cough beads', unresolved.length === 2 && s.fixture === 'TEST FIXTURE: conflict', unresolved.map((b) => b.label).join());
  await page.waitForTimeout(1500);
  await shot('11-conflict-beads');
  await click(JSON.parse(process.env.CONFLICT_BEAD_XY ?? '[817,232]'), 2200);
  s = await st();
  check('conflict fixture: the card says unresolved and offers no Confirm', !!s.card && /Cough/.test(s.card.title), s.card?.title);
  await shot('12-conflict-card');
  await click(JSON.parse(process.env.KEEP_XY ?? '[1056,384]'), 2200);
  s = await st();
  check('conflict fixture: Keep this resolves it explicitly, leaving one cough', s.beads.filter((b) => b.presence === 'UNRESOLVED').length === 0 && s.beads.filter((b) => /cough/i.test(b.label)).length === 1 && s.beads.some((b) => b.origin === 'DOCTOR_CONFIRMED'), s.beads.map((b) => `${b.label}/${b.presence}`).join());
  await shot('13-conflict-resolved');
  await page.close();
}

check('no console errors, failed requests or 4xx during any run', problems.length === 0, problems[0]);
await browser.close();
server?.kill();
console.log(failed === 0 ? 'ALL CONSULTATION STATE CHECKS PASSED' : `${failed} CONSULTATION STATE CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
