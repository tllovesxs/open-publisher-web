// Real local APIs, isolated anonymous browser; no model or mutation requests.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://localhost:5173';

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [], privateRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/(articles|templates|media)(\/|$)/.test(path)) privateRequests.push(path);
        assert.equal(request.method(), 'GET', 'anonymous browsing must never create model requests or writes');
      });
      for (const [kind, selector] of [['articles', '.article-browser'], ['templates', '.template-workbench'], ['media', 'figure img']]) {
        await page.goto(`${base}/${kind}`);
        await page.locator(selector).first().waitFor();
        assert.equal(new URL(page.url()).pathname, `/${kind}`);
        if (kind === 'media') {
          await page.waitForFunction(() => document.querySelector('figure img')?.naturalWidth > 0);
        } else if (kind === 'templates') {
          await page.getByLabel('模板骨架', { exact: true }).waitFor();
          assert.ok((await page.getByLabel('模板骨架', { exact: true }).inputValue()).startsWith('# '));
        } else {
          await page.getByRole('button').filter({ hasText: '把零散想法变成一篇清晰的文章' }).click();
          await page.locator('textarea').first().waitFor();
          assert.ok((await page.locator('textarea').first().inputValue()).startsWith('# '));
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${kind} width=${width}`);
      }
      for (const [kind, label] of [['articles', '文章'], ['templates', '模板'], ['media', '素材库']]) {
        await page.goto(`${base}/examples/${kind}`);
        await page.waitForURL(`${base}/${kind}`);
        assert.equal(await page.locator('.workspace-topbar strong').textContent(), label);
      }
      if (width === 1280) {
        await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '文章', exact: true }).click();
        await page.locator('.article-browser').waitFor();
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(privateRequests, []);
      assert.equal(await page.evaluate(() => localStorage.getItem('opw_access_token')), null);
      console.log(`public examples passed width=${width}: article, template, loaded image, no private requests, no page errors`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
