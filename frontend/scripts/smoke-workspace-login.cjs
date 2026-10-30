// Real public API, mocked account/paid routes. Never call a paid provider.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5183';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_BROWSER_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [], paid = [], privateReads = [];
    let logged = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (/article-create|rewrite-candidate|\/generate$|\/analyze$|\/visual-plan$|\/chat$|\/templates\/extract$/.test(path)) {
        paid.push(path); return route.fulfill({ status: 500, json: { detail: 'Paid request blocked by test' } });
      }
      if (path === '/api/auth/login') { logged = true; return route.fulfill({ json: { token: 'test-only', user: { id: 'test-login', username: 'tester', role: 'user' } } }); }
      if (path === '/api/auth/me') return route.fulfill({ json: { id: 'test-login', username: 'tester', role: 'user' } });
      if (['/api/articles','/api/templates','/api/media'].includes(path)) {
        privateReads.push(path); assert.ok(logged, 'private read before login');
        return route.fulfill({ json: { [path.endsWith('media') ? 'assets' : path.split('/').pop()]: [] } });
      }
      return route.continue();
    });
    const cancel = async () => { await page.getByRole('dialog', { name: '登录', exact: true }).waitFor(); await page.getByRole('button', { name: '取消登录', exact: true }).click(); await page.getByRole('dialog', { name: '登录', exact: true }).waitFor({ state: 'detached' }); };
    await page.goto(base + '/templates');
    await page.locator('.template-workbench').waitFor();
    await page.getByLabel('模板骨架', { exact: true }).waitFor();
    assert.ok((await page.getByLabel('模板骨架', { exact: true }).inputValue()).includes('{{主题}}'));
    assert.equal(await page.locator('.auth-form').count(), 0);
    await page.getByRole('button', { name: '复制另存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.template-toolbar__title h2')?.textContent.includes('副本'));
    await page.getByLabel('模板骨架', { exact: true }).fill('# 本机模板');
    await page.getByRole('button', { name: '保存模板修改', exact: true }).click();
    await page.reload();
    await page.getByLabel('模板骨架', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('模板骨架', { exact: true }).inputValue(), '# 本机模板');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
    await cancel();
    assert.equal(new URL(page.url()).pathname, '/templates');
    assert.equal(await page.getByLabel('模板骨架', { exact: true }).inputValue(), '# 本机模板');
    await page.goto(base + '/');
    await page.getByLabel('文章主题', { exact: true }).fill('取消登录不能丢失的主题');
    await page.getByRole('button', { name: '登录后开始创作', exact: true }).click();
    await cancel();
    assert.equal(await page.getByLabel('文章主题', { exact: true }).inputValue(), '取消登录不能丢失的主题');
    await page.goto(base + '/articles');
    await page.getByRole('button').filter({ hasText: '把零散想法变成一篇清晰的文章' }).click();
    const editor = page.locator('textarea').first();
    await editor.fill('# 保留本机文章');
    await page.getByRole('button', { name: '保存新版本', exact: true }).click();
    await page.getByRole('button', { name: '智能配图', exact: true }).click();
    await cancel();
    assert.equal(await editor.inputValue(), '# 保留本机文章');
    await page.getByRole('button', { name: 'AI 修改', exact: true }).click();
    await page.getByLabel('AI 修改要求', { exact: true }).fill('这个要求取消登录后仍应保留');
    await page.getByLabel('发送 AI 修改要求', { exact: true }).click();
    await cancel();
    assert.equal(await page.getByLabel('AI 修改要求', { exact: true }).inputValue(), '这个要求取消登录后仍应保留');
    await page.goto(base + '/media');
    await page.locator('figure img').waitFor();
    assert.ok(await page.locator('figure img').evaluate(img => img.complete && img.naturalWidth > 0));
    await page.getByPlaceholder('AI 生成：描述想要的图片……').fill('保留图片描述');
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
    await cancel();
    assert.equal(await page.getByPlaceholder('AI 生成：描述想要的图片……').inputValue(), '保留图片描述');
    assert.deepEqual(privateReads, []);
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('tester');
    await page.getByLabel('密码', { exact: true }).fill('test-only-password');
    await page.getByRole('dialog', { name: '登录', exact: true }).getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('dialog', { name: '登录', exact: true }).waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).pathname, '/media');
    await page.locator('figure img').waitFor();
    await page.goto(base + '/templates');
    await page.getByLabel('模板骨架', { exact: true }).waitFor();
    assert.ok((await page.getByLabel('模板骨架', { exact: true }).inputValue()).includes('{{主题}}'));
    await page.goto(base + '/articles');
    await page.getByRole('button').filter({ hasText: '把零散想法变成一篇清晰的文章' }).waitFor();
    assert.deepEqual(paid, []);
    assert.deepEqual(errors, []);
    console.log('PASS shared workbenches, guest save/reload, cancel keeps drafts, settings prompt, login stays in place, examples remain after login, zero paid requests');
    await context.close();
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
