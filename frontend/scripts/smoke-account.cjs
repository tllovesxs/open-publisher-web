const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://localhost:5173';
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    for (const role of ['user', 'admin']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => { if (!sessionStorage.getItem('initialized')) { localStorage.setItem('opw_access_token', 'test-only-token'); sessionStorage.setItem('initialized', '1'); } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let user = { id: 'test', username: 'tester', displayName: '原昵称', role };
      let updates = 0, logouts = 0, integrations = 0, failSave = false, failLogin = true;
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/api/auth/login') {
          if (failLogin) return route.fulfill({ status: 401, json: { detail: '用户名或密码错误' } });
          user = { ...user, id: 'second-user', username: 'second', displayName: '第二个账号' };
          return route.fulfill({ json: { token: 'second-token', user } });
        }
        if (path.includes('/settings/integrations')) integrations++;
        if (path === '/api/auth/me' && request.method() === 'PATCH') {
          if (failSave) return route.fulfill({ status: 500, json: { detail: '模拟失败' } });
          assert.deepEqual(Object.keys(request.postDataJSON()), ['displayName']);
          user = { ...user, ...request.postDataJSON() }; updates++;
          return route.fulfill({ json: user });
        }
        if (path === '/api/auth/logout') logouts++;
        const data = {
          '/api/auth/me': user,
          '/api/settings/profiles': { profiles: [] },
          '/api/settings/preferences': { imageModelId:null, embeddingModelId:null, rerankModelId:null, disabledNodeIds:[], webSearchMode:'auto', profileId:null, nodeProfileIds:{} },
          '/api/settings/available-models': Object.fromEntries(['image','embedding','rerank'].map(kind => [kind,{models:[],defaultId:null}])),
        };
        return route.fulfill({ json: data[path] || {} });
      });
      await page.goto(base + '/settings');
      const account = page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账号', exact: true });
      await account.click();
      await page.getByRole('button', { name: '编辑资料', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.getByText('外部服务', { exact: true }).count(), 0);
      await page.getByRole('button', { name: '编辑资料', exact: true }).click();
      assert.equal(await page.getByLabel('用户名', { exact: true }).inputValue(), 'tester');
      assert.equal(await page.getByLabel('用户名', { exact: true }).getAttribute('readonly'), '');
      await page.getByLabel('昵称', { exact: true }).fill('   ');
      assert.equal(await page.getByRole('button', { name: '保存资料', exact: true }).isDisabled(), true);
      await page.getByLabel('昵称', { exact: true }).fill('取消草稿');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(updates, 0);
      await page.getByRole('button', { name: '编辑资料', exact: true }).click();
      assert.equal(await page.getByLabel('昵称', { exact: true }).inputValue(), '原昵称');
      await page.getByLabel('昵称', { exact: true }).fill('  新昵称  ');
      failSave = true;
      await page.getByRole('button', { name: '保存资料', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '操作失败' }).waitFor();
      assert.equal(await page.getByLabel('昵称', { exact: true }).inputValue(), '  新昵称  ');
      failSave = false;
      await page.getByRole('button', { name: '保存资料', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '资料已更新' }).waitFor();
      assert.equal(updates, 1);
      assert.equal(await page.locator('.client-settings-account-info h2').innerText(), '新昵称');
      await page.reload(); await account.click();
      await page.locator('.client-settings-account-info h2').filter({ hasText: '新昵称' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: '编辑资料', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + '/account-' + role + '-mobile.png', fullPage: true });
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '切换账号', exact: true }).click();
      await page.waitForURL('**/login?switch=1');
      assert.equal(logouts, 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('opw_access_token')), 'test-only-token');
      assert.equal(await page.getByLabel('用户名', { exact: true }).inputValue(), '');
      await page.getByRole('button', { name: '取消切换', exact: true }).click();
      await page.waitForURL('**/settings');
      await page.locator('.client-settings-account-info h2').filter({ hasText: '新昵称' }).waitFor();
      await page.getByRole('button', { name: '切换账号', exact: true }).click();
      await page.waitForURL('**/login?switch=1');
      await page.keyboard.press('Escape');
      await page.waitForURL('**/settings');
      assert.equal(logouts, 0);
      await page.getByRole('button', { name: '切换账号', exact: true }).click();
      await page.waitForURL('**/login?switch=1');
      await page.getByLabel('用户名', { exact: true }).fill('second');
      await page.getByLabel('密码', { exact: true }).fill('test-only-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '用户名或密码错误' }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('opw_access_token')), 'test-only-token');
      await page.getByRole('button', { name: '取消切换', exact: true }).click();
      await page.waitForURL('**/settings');
      await page.getByRole('button', { name: '切换账号', exact: true }).click();
      await page.waitForURL('**/login?switch=1');
      failLogin = false;
      await page.getByLabel('用户名', { exact: true }).fill('second');
      await page.getByLabel('密码', { exact: true }).fill('test-only-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL(base + '/');
      assert.equal(await page.evaluate(() => localStorage.getItem('opw_access_token')), 'second-token');
      assert.equal(integrations, 0);
      assert.deepEqual(errors, []);
      console.log('passed account role=' + role + ': edit, cancel, validation, failure, persistence, mobile, switch');
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
