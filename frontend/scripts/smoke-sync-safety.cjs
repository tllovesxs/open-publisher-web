// Browser extension substitute; never contacts a remote publishing platform.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://localhost:5173';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_BROWSER_PATH });
  try {
    for (const level of ['high', 'unknown', 'low']) {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        localStorage.setItem('opw_access_token', 'test-only');
        localStorage.setItem('opw.publish-notice-muted-date', new Date().toISOString().slice(0, 10));
        window.__syncCalls = 0;
        window.$syncer = { getAccounts: cb => cb([{ type: 'test', title: '测试平台' }]),
          addTask: (_task, status) => { window.__syncCalls++; status({ type: 'test', status: 'done' }); } };
      });
      const page = await context.newPage();
      const errors = [], confirmations = [];
      page.on('pageerror', e => errors.push(e.message));
      const article = { articleId: 'safety-test', title: '安全回归推文', markdown: '# 推文\n事实内容', currentRevisionId: 'r1', contentHash: 'hash', updatedAt: new Date().toISOString() };
      await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()).pathname;
        if (!url.startsWith('/api/')) return route.continue();
        if (url.startsWith('/api/examples/')) return route.continue();
        if (url.endsWith('/sync-preflight')) {
          if (request.postDataJSON().confirm) confirmations.push(true);
          return route.fulfill({ json: { level, blocked: level === 'high', requiresConfirmation: level !== 'low', message: '风险检查：' + level } });
        }
        const data = { '/api/auth/me': { id: 'test', username: 'tester', role: 'user' },
          '/api/articles': { articles: [article] }, '/api/articles/safety-test': article,
          '/api/settings/preferences': { disabledNodeIds: [], webSearchMode: 'off' }, '/api/media': { assets: [] } };
        return route.fulfill({ json: data[url] || {} });
      });
      await page.goto(base + '/articles?open=safety-test');
      await page.getByRole('textbox', { name: 'Markdown 正文', exact: true }).waitFor();
      await page.getByRole('button', { name: '同步发布', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '文章同步发布' });
      await dialog.getByRole('button', { name: '测试平台', exact: true }).click();
      const submit = dialog.getByRole('button', { name: '同步到草稿（1 个平台）', exact: true });
      if (level === 'high') { assert.ok(await submit.isDisabled()); }
      else {
        if (level === 'unknown') {
          assert.ok(await submit.isDisabled());
          await dialog.getByRole('checkbox').check();
        }
        await submit.click();
        await page.waitForFunction(() => window.__syncCalls === 1);
        assert.equal(confirmations.length, 1);
      }
      assert.deepEqual(errors, []);
      console.log('sync safety passed: ' + level);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
