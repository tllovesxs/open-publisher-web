const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://localhost:5173';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    for (const mode of ['success', 'mixed', 'empty', 'missing', 'image-error']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(({ mode }) => {
        localStorage.setItem('opw_access_token', 'test-only-token');
        localStorage.setItem('opw.publish-notice-muted-date', new Date().toISOString().slice(0, 10));
        window.__posts = [];
        // Simulate content-script responses while using the extension's REAL inject-api.js.
        window.addEventListener('message', event => {
          let request;
          try { request = JSON.parse(event.data); } catch { return; }
          if (request.callReturn || !request.eventID) return;
          if (request.method === 'getAccounts') {
            const accounts = mode === 'empty' ? [] : [
              { type: 'zhihu', title: '测试账号', displayName: '知乎' },
              { type: 'csdn', title: '测试账号', displayName: 'CSDN' },
            ];
            window.postMessage(JSON.stringify({ eventID: request.eventID, callReturn: true, result: accounts }), '*');
          }
          if (request.method === 'addTask') {
            window.__posts.push(request.task);
            const accounts = request.task.accounts.map(a => ({ ...a, status: 'uploading' }));
            window.postMessage(JSON.stringify({ method: 'taskUpdate', task: { accounts } }), '*');
            setTimeout(() => window.postMessage(JSON.stringify({ method: 'taskUpdate', task: { accounts: accounts.map(a => ({ ...a, status: mode === 'mixed' && a.type === 'csdn' ? 'failed' : 'done', error: mode === 'mixed' && a.type === 'csdn' ? '请重新登录' : undefined, editResp: { draftLink: a.type === 'zhihu' ? 'https://zhuanlan.zhihu.com/p/test' : 'javascript:alert(1)' } })) } }), '*'), 100);
          }
        });
      }, { mode });
      if (mode !== 'missing') {
        if (process.env.SYNC_INJECT_API) {
          const source = require('node:fs').readFileSync(process.env.SYNC_INJECT_API, 'utf8');
          await context.addInitScript({ content: source });
        } else throw Error('Set SYNC_INJECT_API to the installed extension inject-api.js');
      }
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let imageReads = 0;
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/media/picture/raw') {
          imageReads++;
          if (mode === 'image-error') return route.fulfill({ status: 403, json: { detail: 'Denied' } });
          if (route.request().resourceType() === 'xhr') assert.equal(new URL(route.request().url()).searchParams.has('access_token'), false);
          return route.fulfill({ contentType: 'image/png', body: png });
        }
        const data = {
          '/api/auth/me': { id: 'test', username: 'tester', role: 'user' },
          '/api/settings/profiles': { profiles: [] },
          '/api/settings/image-models': { models: [] },
          '/api/templates': { templates: [] },
          '/api/articles': { articles: [] },
          '/api/media': { assets: [] },
          '/api/assistant/sessions': { sessions: [] },
          '/api/articles/test': { articleId: 'test', title: '同步测试', markdown: '# 正文\n\n测试内容\n\n![素材](asset://picture)', currentRevisionId: 'r1', contentHash: 'h1' },
        };
        return route.fulfill({ json: data[path] || {} });
      });
      await page.goto(base + '/articles?open=test');
      await page.getByRole('button', { name: '同步发布', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '文章同步发布' });
      await dialog.waitFor();
      assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '发布', exact: true }).count(), 0);
      if (mode === 'missing') await dialog.getByText('未检测到插件。', { exact: false }).waitFor();
      else if (mode === 'empty') await dialog.getByText('插件已连接，请先登录目标平台，再刷新平台。').waitFor();
      else {
        await dialog.getByRole('button', { name: '知乎', exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: '同步到草稿（0 个平台）', exact: true }).isDisabled(), true);
        await dialog.getByRole('button', { name: '知乎', exact: true }).click();
        if (mode === 'mixed') await dialog.getByRole('button', { name: 'CSDN', exact: true }).click();
        await dialog.getByRole('button', { name: /同步到草稿/ }).click();
        if (mode === 'image-error') {
          await dialog.getByRole('alert').waitFor();
          assert.equal(await page.evaluate(() => window.__posts.length), 0);
          assert.equal(await dialog.getByRole('button', { name: /同步到草稿/ }).isEnabled(), true);
        } else {
          await dialog.getByRole('link', { name: '查看草稿' }).waitFor();
          await dialog.getByRole('button', { name: '已提交同步', exact: true }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: '已提交同步', exact: true }).isDisabled(), true);
          const posts = await page.evaluate(() => window.__posts);
          assert.equal(posts.length, 1);
          assert.equal(posts[0].accounts.length, mode === 'mixed' ? 2 : 1);
          assert.match(posts[0].post.content, /data:image\/png;base64/);
          assert.match(posts[0].post.markdown, /data:image\/png;base64/);
          assert.ok(!JSON.stringify(posts).includes('test-only-token'));
          assert.ok(!JSON.stringify(posts).includes('access_token'));
          assert.equal(await dialog.getByRole('link', { name: '查看草稿' }).getAttribute('href'), 'https://zhuanlan.zhihu.com/p/test');
          if (mode === 'mixed') await dialog.getByText('请重新登录', { exact: true }).waitFor();
        }
        assert.ok(imageReads >= 1);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
      }
      await dialog.getByRole('button', { name: '返回文章', exact: true }).click();
      await page.goto(base + '/publish-queue');
      await page.waitForURL(base + '/articles');
      assert.deepEqual(errors, []);
      console.log('sync passed: ' + mode);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
