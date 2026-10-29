// Run against Vite with PLAYWRIGHT_MODULE pointing to an installed playwright.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5183';

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('opw_access_token', 'test-only-token'));
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${base}/api/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      const responses = {
        '/api/auth/me': { id: 'test', username: 'tester', displayName: 'Tester', role: 'user' },
        '/api/settings/profiles': { profiles: [] },
        '/api/settings/image-models': { models: [] },
        '/api/settings/preferences': { disabledNodeIds: [], webSearchMode: 'off' },
        '/api/templates': { templates: [] },
        '/api/articles': { articles: [] },
        '/api/media': { assets: [] },
        '/api/assistant/sessions': { sessions: [] },
        '/api/articles/test': { articleId: 'test', title: 'Smoke article', markdown: '# Heading\n\nBody.', currentRevisionId: 'r1', contentHash: 'h1' },
      };
      await route.fulfill({ json: responses[path] || {} });
    });
    const routes = { '/': '.creation-studio', '/articles': '.article-browser', '/templates': '.article-browser', '/media': 'h1', '/settings': '.settings-page', '/login': '.auth-form' };
    for (const [route, selector] of Object.entries(routes)) {
      await page.goto(base + route);
      await page.locator(selector).first().waitFor();
      assert.equal(await page.getByText('页面暂时无法显示', { exact: true }).count(), 0, route);
      console.log('route passed ' + route);
    }
    await page.goto(base);
    await page.getByLabel('文章主题', { exact: true }).waitFor();
    const articleNavigation = page.getByRole('navigation', { name: '主导航' });
    await articleNavigation.getByRole('button', { name: '文章', exact: true }).click();
    await page.locator('.article-browser').waitFor();
    await articleNavigation.getByRole('button', { name: '创作', exact: true }).click();
    await page.getByLabel('文章主题', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '账号菜单' }).count(), 1);
    const checks = await page.evaluate(async () => {
      const files = await import('/src/lib/fileImport.ts');
      const result = await files.readPromptImage(new File([new Uint8Array(1024 * 1024)], 'large.png', { type: 'image/png' }));
      if (!result.startsWith('data:image/png;base64,')) throw Error('image conversion');
      let rejected = false;
      try { await files.readPromptImage(new File([new Uint8Array(11 * 1024 * 1024)], 'oversized.png', { type: 'image/png' })); } catch { rejected = true; }
      if (!rejected) throw Error('oversize accepted');
      if (files.appendReferences('x'.repeat(299999), 'abc').length !== 300000) throw Error('reference limit');
      const timeline = await import('/src/components/ArticleRunTimeline.tsx');
      const label = timeline.formatNodeDetail({ hits: 3, rerankUsed: true, status: 'retrieved' });
      if (label.includes('[object Object]') || !label.includes('命中片段：3')) throw Error('details');
      const preview = await import('/src/components/article/MarkdownPreview.tsx');
      const container = document.createElement('div');
      container.innerHTML = preview.renderMarkdownBlockHtml('# Heading\n\nBody\n\nSecond');
      const lines = Array.from(container.children).map(item => item.getAttribute('data-md-line'));
      if (lines.join(',') !== '1,3,5') throw Error('line mapping ' + lines);
      return { largeImage: true, oversizeRejected: true, referenceLimit: true, ragDetails: label, markdownLines: lines };
    });
    await page.goto(base + '/articles?open=test');
    await page.locator('textarea').first().waitFor();
    const editor = page.locator('textarea').first();
    await editor.fill('# Updated heading\n\nUpdated body.');
    await page.getByRole('article', { name: 'Markdown 预览' }).getByRole('heading', { name: 'Updated heading' }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, editor: true, pageErrors: errors }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
