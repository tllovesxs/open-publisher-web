const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('opw:local-workspace:guest:articles', JSON.stringify([
        { articleId: 'private-legacy', title: 'PRIVATE_LEGACY_SECRET', markdown: 'private' },
      ]));
      sessionStorage.setItem('gaoliu.active-article-run', JSON.stringify({
        runId: 'private-run', articleId: 'private-article', title: 'PRIVATE_RUN_SECRET', ownerUserId: 'alice',
      }));
    });
    const page = await context.newPage();
    await page.goto('http://localhost:5173/articles');
    await page.getByRole('button').filter({ hasText: '把零散想法变成一篇清晰的文章' }).waitFor();
    assert.equal(await page.getByText('PRIVATE_LEGACY_SECRET').count(), 0);
    assert.equal(await page.getByText('PRIVATE_RUN_SECRET').count(), 0);
    assert.equal(await page.locator('.article-list-item').count(), 1);
    await page.goto('http://localhost:5173/articles?open=private-legacy');
    await page.locator('.article-list-item').waitFor();
    assert.equal(await page.getByText('PRIVATE_LEGACY_SECRET').count(), 0);
    assert.equal(await page.getByText('PRIVATE_RUN_SECRET').count(), 0);
    console.log('Browser isolation passed: stale private task and anonymous legacy draft hidden; public article visible.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
