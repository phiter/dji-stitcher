// End-to-end check in system Chrome: stitches a dataset and saves the UI screenshot and the downloaded panorama.
// Usage: npm run dev (other terminal), then: node scripts/e2e.mjs [dataset] [export size option index]
// Set BASE_URL to test another server (e.g. `vite preview`).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dataset = process.argv[2] ?? '100_0997';
const exportIndex = process.argv[3]; // optional <select> option index for the export size
// Set PLANET=1:1 (or 16:9, 9:16) to test the little planet tab instead of the panorama export.
const planetAspect = process.env.PLANET;
const outDir = path.resolve('e2e-out');
fs.mkdirSync(outDir, { recursive: true });

const dir = path.resolve('PANORAMAS', dataset);
const files = fs
  .readdirSync(dir)
  .filter((f) => /^DJI_\d+\.JPG$/i.test(f))
  .sort()
  .map((f) => path.join(dir, f));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) console.log('[browser]', m.type(), m.text().slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file]', files);
await page.getByRole('button', { name: /Stitch panorama/ }).click();
const t0 = Date.now();
await page.waitForSelector('.pnlm-container canvas', { timeout: 240_000 });
console.log('stitched in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForFunction(() => getComputedStyle(document.querySelector('.pnlm-load-box')).display === 'none', null, {
  timeout: 60_000,
});
await page.waitForTimeout(800);
console.log(await page.locator('text=/Aligned/').innerText());
await page.screenshot({ path: path.join(outDir, `${dataset}-ui.png`) });

if (planetAspect) {
  await page.getByRole('button', { name: 'Little planet' }).click();
  await page.getByRole('button', { name: planetAspect, exact: true }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, `${dataset}-planet-ui.png`), fullPage: true });
}

if (exportIndex !== undefined) {
  if (exportIndex !== '') await page.locator('.export select').first().selectOption({ index: Number(exportIndex) });
  const t1 = Date.now();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 600_000 }),
    page.getByRole('button', { name: /Render/ }).click(),
  ]);
  const target = path.join(outDir, `${dataset}-${download.suggestedFilename()}`);
  await download.saveAs(target);
  console.log('export in', ((Date.now() - t1) / 1000).toFixed(1), 's ->', target, (fs.statSync(target).size / 1e6).toFixed(1), 'MB');
}
await browser.close();
