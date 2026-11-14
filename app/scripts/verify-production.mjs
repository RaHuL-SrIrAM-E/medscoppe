// Production-bundle check: drives the BUILT app (vite preview) with mouse input in a real
// headless Chromium. The production bundle has no IWER emulator, so this exercises the
// desktop path only (canvas pointer events), not hands. Uses the playwright that ships with
// @iwsdk/cli. Usage: node scripts/verify-production.mjs <outDir> [steps.json]
import { chromium } from 'playwright';
import fs from 'node:fs';

const [outDir, stepsFile] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [];
const URL = process.env.PROD_URL ?? 'https://127.0.0.1:4173/';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
const problems = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock/.test(m.text())) problems.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(7000); // GLB + panels + first frames
await page.screenshot({ path: `${outDir}/00-baseline.png` });

for (const [i, step] of steps.entries()) {
  const n = String(i + 1).padStart(2, '0');
  if (step.click) await page.mouse.click(step.click[0], step.click[1]);
  if (step.key) await page.keyboard.press(step.key);
  await page.waitForTimeout(step.wait ?? 2200);
  await page.screenshot({ path: `${outDir}/${n}-${step.name}.png` });
}
fs.writeFileSync(`${outDir}/problems.json`, JSON.stringify(problems, null, 1));
console.log(`problems: ${problems.length}`);
for (const p of problems.slice(0, 12)) console.log('  ' + p);
await browser.close();
