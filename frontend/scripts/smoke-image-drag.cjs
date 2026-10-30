// Real browser drags; guest storage and mocked private uploads. No model calls.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://localhost:5173';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_BROWSER_PATH });
  try {
    for (const signedIn of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      if (signedIn) await context.addInitScript(() => localStorage.setItem('opw_access_token', 'test-only'));
      const page = await context.newPage();
      const errors = [], paid = [];
      let uploadId = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith('/api/')) return route.continue();
        if (path.startsWith('/api/examples/')) return route.continue();
        if (path === '/api/auth/me') return route.fulfill({ json: { id: 'drag-test', username: 'tester', role: 'user' } });
        if (path === '/api/media' && route.request().method() === 'POST') return route.fulfill({ json: { id: `test-image-${++uploadId}`, name: 'test.png' } });
        if (/^\/api\/media\/.+\/raw$/.test(path)) return route.fulfill({ contentType: 'image/png', body: png });
        if (path === '/api/articles') return route.fulfill({ json: { articles: [] } });
        if (/generate|visual-plan|article-create|rewrite|analyze/.test(path)) paid.push(path);
        return route.fulfill({ json: {} });
      });
      await page.goto(base + '/articles');
      await page.getByRole('button').filter({ hasText: '把零散想法变成一篇清晰的文章' }).click();
      const editor = page.getByLabel('Markdown 正文', { exact: true });
      await editor.fill('# Heading\n\nFirst paragraph.\n\nLast paragraph.');
      await page.getByRole('button', { name: '编辑器布局', exact: true }).click();
      await page.getByRole('option', { name: '编辑与预览', exact: true }).click();
      await page.getByRole('button', { name: '配图', exact: true }).click();
      const pending = name => page.locator('.article-figures__item').filter({ has: page.getByRole('button', { name: `插入 ${name}`, exact: true }) });
      const upload = async name => {
        await page.locator('.article-figures input[type=file]').setInputFiles({ name: name + '.png', mimeType: 'image/png', buffer: png });
        await pending(name).waitFor();
        assert.ok(await pending(name).locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
      };
      await upload('preview-drag');
      // Drag directly from image pixels, not just the enclosing figure.
      await pending('preview-drag').locator('img').dragTo(page.locator('.preview-pane h1'), { targetPosition: { x: 30, y: 5 } });
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="Markdown 正文"]').value.includes('![preview-drag]'));
      assert.ok((await editor.inputValue()).indexOf('![preview-drag]') < (await editor.inputValue()).indexOf('# Heading'));
      assert.equal(await pending('preview-drag').count(), 0);
      await upload('editor-drag');
      await editor.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
      await pending('editor-drag').locator('img').dragTo(editor, { targetPosition: { x: 15, y: 5 } });
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="Markdown 正文"]').value.includes('![editor-drag]'));
      let markdown = await editor.inputValue();
      assert.ok(markdown.indexOf('![editor-drag]') < markdown.indexOf('Last paragraph.'), 'use drop point instead of stale selection');
      assert.equal(await pending('editor-drag').count(), 0);
      const existing = page.locator('.article-figures__item').filter({ has: page.getByRole('button', { name: '编辑 editor-drag', exact: true }) });
      await existing.locator('img').dragTo(page.locator('.preview-pane p').filter({ hasText: 'Last paragraph.' }), { targetPosition: { x: 25, y: 15 } });
      markdown = await editor.inputValue();
      assert.equal(markdown.split('![editor-drag]').length - 1, 1, 'moving must not duplicate');
      assert.ok(markdown.indexOf('![editor-drag]') > markdown.indexOf('Last paragraph.'), 'existing figure moves to the requested paragraph');
      await upload('cancel-drag');
      await pending('cancel-drag').locator('img').dragTo(page.locator('.article-figures__head'));
      assert.equal(await pending('cancel-drag').count(), 1, 'cancelled drag retains pending upload');
      assert.equal(await page.getByText('只能导入图片文件。', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(paid, []);
      console.log(`PASS ${signedIn ? 'signed-in' : 'guest'} upload, preview/editor drop, pending cleanup, move without duplication, cancelled drag; zero model calls`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
