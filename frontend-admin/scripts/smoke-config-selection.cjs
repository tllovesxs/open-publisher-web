const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.ADMIN_BASE_URL || 'http://127.0.0.1:5184';
(async () => {
 const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => localStorage.setItem('opw_access_token', 'test-only'));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const kinds = ['text', 'image', 'embedding', 'rerank'];
  const catalogs = Object.fromEntries(kinds.map(kind => [kind, { activeId: 'second-' + kind, profiles: ['first', 'second'].map((which, i) => ({ id: which + '-' + kind, name: which + '-' + kind, baseUrl: 'https://' + which + '.test/v1', modelId: which + '-model-' + kind, timeoutSeconds: 10 + i, keyConfigured: true, keyHint: '****' + (i ? '2222' : '1111'), provider: 'custom', isDefault: i === 1 })) }]));
  const writes = [], tests = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
   const req = route.request(); const url = new URL(req.url()); const path = url.pathname; const method = req.method();
   if (method !== 'GET') writes.push({ path, method });
   if (path.endsWith('/auth/me')) return route.fulfill({ json: { id: 'test', username: 'admin', role: 'admin' } });
   if (path.endsWith('/settings/model')) return route.fulfill({ json: { model: 'active-model', baseUrl: 'https://active.test', timeoutSeconds: 120 } });
   if (/\/(model|image|rag)\/test$/.test(path) || path.endsWith('/settings/models')) {
    tests.push({ path, profileId: url.searchParams.get('profileId'), target: url.searchParams.get('target') });
    return route.fulfill({ json: path.endsWith('/models') ? { models: ['available'] } : path.endsWith('/rag/test') ? { [url.searchParams.get('target')]: { ok: true, latencyMs: 1 } } : { model: 'mock', latencyMs: 1 } });
   }
   const match = path.match(/\/settings\/(?:model-configs\/(image|embedding|rerank)|profiles)(?:\/([^/]+))?(?:\/(key|activate))?$/);
   if (!match) throw new Error('Unexpected mocked request: ' + method + ' ' + path);
   const kind = match[1] || 'text', id = match[2], action = match[3]; const catalog = catalogs[kind];
   if (method === 'GET') return route.fulfill({ json: catalog });
   const profile = catalog.profiles.find(p => p.id === id);
   if (action === 'key') {
    if (method === 'PUT') { assert.equal(req.postDataJSON().apiKey, 'test-only-new-key'); profile.keyConfigured = true; profile.keyHint = '****wkey'; }
    else { profile.keyConfigured = false; profile.keyHint = ''; }
    return route.fulfill({ json: {} });
   }
   if (action === 'activate') { catalog.activeId = id; for (const p of catalog.profiles) p.isDefault = p.id === id; return route.fulfill({ json: {} }); }
   if (method === 'DELETE') { catalog.profiles = catalog.profiles.filter(p => p.id !== id); return route.fulfill({ status: 204 }); }
   if (method === 'PATCH') { Object.assign(profile, req.postDataJSON()); return route.fulfill({ json: profile }); }
   throw new Error('Unexpected mutation ' + path);
  });
  await page.goto(base);
  for (const [kind, title] of [['text','文本模型'], ['image','生图模型'], ['embedding','资料检索模型'], ['rerank','检索排序模型']]) {
   await page.getByRole('button', { name: title, exact: true }).click();
   const panel = page.locator('.model-panel:not([hidden])');
   const first = panel.locator('.profile').filter({ has: page.locator('.profile-select', { hasText: 'first-' + kind }) });
   const second = panel.locator('.profile').filter({ has: page.locator('.profile-select', { hasText: 'second-' + kind }) });
   await first.locator('.profile-select').waitFor();
   await page.waitForFunction(() => !document.querySelector('.model-panel:not([hidden])')?.textContent.includes('正在读取配置'));
   assert.match(await panel.locator('.config-grid').innerText(), new RegExp('first-model-' + kind));
   assert.match(await panel.locator('.configuration-key-editor').innerText(), /1111/);
   assert.equal(await first.locator('.profile-select').getAttribute('aria-pressed'), 'true');
   assert.equal(catalogs[kind].activeId, 'second-' + kind);
   const before = writes.length;
   await panel.getByLabel('当前配置访问密钥', { exact: true }).fill('discarded-draft');
   await second.locator('.profile-select').click();
   assert.match(await panel.locator('.config-grid').innerText(), new RegExp('second-model-' + kind));
   assert.match(await panel.locator('.configuration-key-editor').innerText(), /2222/);
   assert.equal(await panel.getByLabel('当前配置访问密钥', { exact: true }).inputValue(), '');
   assert.equal(writes.length, before);
   await panel.getByRole('button', { name: '模型配置', exact: true }).click();
   let form = panel.getByRole('form'); await form.waitFor();
   assert.equal(await form.getByLabel('方案名称', { exact: true }).inputValue(), 'second-' + kind);
   await first.locator('.profile-select').click();
   assert.equal(await panel.getByRole('form').count(), 0);
   assert.equal(writes.length, before);
   await panel.getByLabel('当前配置访问密钥', { exact: true }).fill('test-only-new-key');
   await panel.getByRole('button', { name: '保存密钥', exact: true }).click();
   await panel.getByRole('status').filter({ hasText: '此配置的密钥已保存' }).waitFor();
   const expectedKeyPath = '/api/settings/' + (kind === 'text' ? 'profiles' : 'model-configs/' + kind) + '/first-' + kind + '/key';
   assert.deepEqual(writes.at(-1), { path: expectedKeyPath, method: 'PUT' });
   assert.equal(catalogs[kind].activeId, 'second-' + kind);
   await panel.getByRole('button', { name: '刷新', exact: true }).click();
   await page.waitForFunction(() => !document.querySelector('.model-panel:not([hidden])')?.textContent.includes('正在读取配置'));
   assert.equal(await first.locator('.profile-select').getAttribute('aria-pressed'), 'true');
   await panel.getByRole('button', { name: '测试连接', exact: true }).click();
   await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
   assert.equal(tests.at(-1).profileId, 'first-' + kind);
   if (kind === 'text') { await panel.getByRole('button', { name: '获取模型列表', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已发现' }).waitFor(); assert.equal(tests.at(-1).profileId, 'first-text'); }
   await panel.getByRole('button', { name: '移除密钥', exact: true }).click();
   await panel.getByRole('status').filter({ hasText: '此配置的密钥已移除' }).waitFor();
   assert.deepEqual(writes.at(-1), { path: expectedKeyPath, method: 'DELETE' });
   assert.equal(await panel.getByRole('button', { name: '移除密钥', exact: true }).count(), 0);
   // Removing a viewed, non-default configuration falls back to the first remaining row.
   await first.getByRole('button', { name: new RegExp('^删除') }).click();
   await first.waitFor({ state: 'detached' });
   assert.match(await panel.locator('.config-grid').innerText(), new RegExp('second-model-' + kind));
   assert.match(await panel.locator('.configuration-key-editor').innerText(), /2222/);
   console.log('PASS ' + title + ': first item, click selection, scoped key save/remove, draft reset, selected test, deletion fallback');
  }
  for (const width of [1440, 600, 390]) {
   await page.setViewportSize({ width, height: 1000 });
   for (const title of ['文本模型','生图模型','资料检索模型','检索排序模型']) {
    await page.getByRole('button', { name: title, exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   }
  }
  if (process.env.SMOKE_OUTPUT_DIR) {
   await page.setViewportSize({ width: 1440, height: 1080 });
   await page.getByRole('button', { name: '生图模型', exact: true }).click();
   await page.locator('.nav-link.active').filter({ hasText: '生图模型' }).waitFor();
   await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + '/selected-model-settings.png', fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS desktop/mobile; all requests mocked; no real keys or paid model calls');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
