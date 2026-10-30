// Capture only public examples in an isolated browser. No real accounts or model calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://localhost:5173';
const out = path.resolve(__dirname, '../../docs/submission/screenshots');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_BROWSER_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => assert.equal(request.method(), 'GET', 'Evidence capture is read-only'));
    for (const [route, name] of [['/', '01-create'], ['/articles', '02-articles'], ['/templates', '04-templates'], ['/media', '05-media']]) {
      await page.goto(base + route);
      await page.waitForLoadState('networkidle');
      if (route === '/articles') {
        await page.screenshot({ path: path.join(out, name + '.png') });
        await page.getByRole('button').filter({ hasText: '把零散想法变成一篇清晰的文章' }).click();
        await page.getByRole('textbox', { name: 'Markdown 正文', exact: true }).waitFor();
        await page.screenshot({ path: path.join(out, '03-workbench.png') });
      } else await page.screenshot({ path: path.join(out, name + '.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/templates');
    await page.getByLabel('模板骨架', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(out, '06-mobile.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ screenshots: 6, errors, paidRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
