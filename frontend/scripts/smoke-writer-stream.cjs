// Isolated UI regression: simulated SSE only, no paid model or real user data.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5183';

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('opw_access_token', 'test-only-token');
      sessionStorage.setItem('gaoliu.active-article-run', JSON.stringify({ runId: 'test-run', articleId: 'stream-test', title: '流式回归', ownerUserId: 'test' }));
      window.EventSource = class {
        constructor() { window.__writerStream = this; }
        close() {}
      };
      window.__writerSequence = 0;
      window.__emitWriterEvent = (type, payload) => {
        window.__writerStream.onmessage({ data: JSON.stringify({
          sequence: ++window.__writerSequence, type, payload, runId: 'test-run', articleId: 'stream-test',
        }) });
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${base}/api/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      const responses = {
        '/api/auth/me': { id: 'test', username: 'tester', displayName: 'Tester', role: 'user' },
        '/api/settings/profiles': { profiles: [] },
        '/api/settings/preferences': { disabledNodeIds: [], webSearchMode: 'off' },
        '/api/articles': { articles: [] },
        '/api/articles/stream-test': { articleId: 'stream-test', title: '流式回归', markdown: '', currentRevisionId: null, contentHash: null },
        '/api/media': { assets: [] },
      };
      await route.fulfill({ json: responses[path] || {} });
    });
    await page.goto(base + '/articles');
    const editor = page.getByRole('textbox', { name: 'Markdown 正文', exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => typeof window.__writerStream?.onmessage === 'function');
    await page.evaluate(() => window.__emitWriterEvent('agent.progress', { phase: 'reasoning', elapsedMs: 203000 }));
    await page.getByText('模型正在思考 · 已等待 203 秒', { exact: true }).waitFor();
    const body = '# 生成测试\n\n' + '中文😀逐行生成，保持正文完整。\n'.repeat(110);
    const started = Date.now();
    await page.evaluate(body => {
      window.__emitWriterEvent('article.content_reset', {});
      for (let index = 0; index < body.length; index += 90) {
        window.__emitWriterEvent('agent.message_delta', { stage: 'content', delta: body.slice(index, index + 90) });
      }
    }, body);
    await page.waitForFunction(body => document.querySelector('textarea[aria-label="Markdown 正文"]')?.value === body, body, { timeout: 2000 });
    const catchUpMs = Date.now() - started;
    await page.evaluate(() => window.__emitWriterEvent('run.failed', { message: '模拟断流，正文已保留' }));
    await page.getByText('创作失败：模拟断流，正文已保留', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), body);
    const layouts = [];
    for (const width of [1280, 1158, 800, 390]) {
      await page.setViewportSize({ width, height: 600 });
      const layout = await page.evaluate(() => {
        const bounds = selector => document.querySelector(selector).getBoundingClientRect();
        const failure = bounds('.article-editor__body > [role="alert"]');
        const strip = bounds('.article-run-strip');
        const timeline = bounds('.article-run-strip .workflow-timeline');
        const main = bounds('.article-editor__main');
        const icons = [...document.querySelectorAll('.article-run-strip .workflow-timeline__icon')].map(icon => icon.getBoundingClientRect());
        return {
          width: innerWidth, failureHeight: failure.height, stripHeight: strip.height,
          timelineHeight: timeline.height, noOverlap: failure.bottom <= strip.top && strip.bottom <= main.top,
          iconsUnclipped: icons.every(icon => icon.top >= timeline.top && icon.bottom <= timeline.bottom),
        };
      });
      assert.ok(layout.failureHeight >= 30, JSON.stringify(layout));
      assert.ok(layout.stripHeight >= 50, JSON.stringify(layout));
      assert.ok(layout.timelineHeight >= 30, JSON.stringify(layout));
      assert.ok(layout.noOverlap && layout.iconsUnclipped, JSON.stringify(layout));
      layouts.push(layout);
    }
    await page.setViewportSize({ width: 1158, height: 600 });
    // 长接口错误也应换行，不能撑宽页面或挤扁流程栏。
    await page.evaluate(() => window.__emitWriterEvent('run.failed', { message: '模型接口失败：' + 'long-provider-error-'.repeat(50) }));
    const longError = await page.locator('.article-editor__body > [role="alert"]').evaluate(element => ({
      scroll: element.scrollWidth, width: element.clientWidth, height: element.getBoundingClientRect().height,
    }));
    assert.ok(longError.scroll <= longError.width + 1 && longError.height <= 144, JSON.stringify(longError));
    if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT });
    await editor.fill('用户主动编辑');
    await page.evaluate(() => window.__emitWriterEvent('agent.message_delta', { stage: 'content', delta: '不应覆盖用户编辑' }));
    // 等两帧，验证新增事件经过 effect 后仍尊重用户编辑。
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editor.inputValue(), '用户主动编辑');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ catchUpMs, characters: body.length, layouts, longError, reasoningStatus: true, preservedAfterFailure: true, userEditProtected: true, pageErrors: errors }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
