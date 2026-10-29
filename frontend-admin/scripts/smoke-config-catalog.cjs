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
  const catalogs = Object.fromEntries(['image', 'embedding', 'rerank'].map(kind => [kind, { activeId: 'old-' + kind, profiles: [{ id: 'old-' + kind, name: '原有-' + kind, baseUrl: 'https://old.test/v1', modelId: 'old-model-' + kind, timeoutSeconds: kind === 'rerank' ? 5 : 60 }] }]));
  let textProfiles = [{ id: 'old-text', name: '原有-text', baseUrl: 'https://old.test/v1', modelId: 'old-model-text', timeoutSeconds: 120, isDefault: true, provider: 'custom' }];
  const rag = { embeddingBaseUrl: 'https://old.test/v1', embeddingModel: 'old-model-embedding', embeddingKeyConfigured: false, rerankBaseUrl: 'https://old.test/v1', rerankModel: 'old-model-rerank', rerankTimeoutSeconds: 5, source: 'db' };
  let writes = 0;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
   const path = new URL(route.request().url()).pathname;
   const method = route.request().method();
   if (method !== 'GET') writes++;
   const match = path.match(/\/settings\/model-configs\/(image|embedding|rerank)(?:\/([^/]+))?(?:\/(activate))?$/);
   if (match) {
    const [, kind, id, activate] = match; const catalog = catalogs[kind];
    if (method === 'GET') return route.fulfill({ json: catalog });
    if (method === 'POST' && !id) {
     const payload = route.request().postDataJSON();
     if (catalog.profiles.some(p => p.name === payload.name)) return route.fulfill({ status: 409, json: { detail: '同名配置已存在' } });
     const profile = { id: 'new-' + kind, ...payload }; catalog.profiles.push(profile);
     return route.fulfill({ status: 201, json: profile });
    }
    if (activate) {
     catalog.activeId = id;
     const profile = catalog.profiles.find(p => p.id === id);
     if (kind !== 'image') { rag[kind + 'BaseUrl'] = profile.baseUrl; rag[kind + 'Model'] = profile.modelId; }
     return route.fulfill({ json: { activeId: id } });
    }
    if (method === 'PATCH') {
     const index = catalog.profiles.findIndex(p => p.id === id);
     catalog.profiles[index] = { id, ...route.request().postDataJSON() };
     return route.fulfill({ json: catalog.profiles[index] });
    }
    if (method === 'DELETE') { catalog.profiles = catalog.profiles.filter(p => p.id !== id); return route.fulfill({ status: 204 }); }
   }
   if (path.endsWith('/profiles') && method === 'POST') { const p = { id: 'new-text', ...route.request().postDataJSON() }; textProfiles.push(p); return route.fulfill({ status: 201, json: p }); }
   if (path.endsWith('/profiles/new-text/activate')) { textProfiles = textProfiles.map(p => ({ ...p, isDefault: p.id === 'new-text' })); return route.fulfill({ json: {} }); }
   if (path.endsWith('/profiles/new-text') && method === 'PATCH') { textProfiles = textProfiles.map(p => p.id === 'new-text' ? { ...p, ...route.request().postDataJSON() } : p); return route.fulfill({ json: {} }); }
   const activeImage = catalogs.image.profiles.find(p => p.id === catalogs.image.activeId);
   const activeText = textProfiles.find(p => p.isDefault);
   const data = path.endsWith('/auth/me') ? { id: 'test', username: 'admin', role: 'admin' }
    : path.endsWith('/settings/profiles') ? { profiles: textProfiles }
    : path.endsWith('/settings/model') ? { baseUrl: activeText.baseUrl, model: activeText.modelId, profileName: activeText.name, timeoutSeconds: activeText.timeoutSeconds }
    : path.endsWith('/settings/image') ? { baseUrl: activeImage.baseUrl, model: activeImage.modelId, timeoutSeconds: activeImage.timeoutSeconds, source: 'db', keyConfigured: false }
    : path.endsWith('/settings/rag') ? rag : {};
   await route.fulfill({ json: data });
  });
  await page.goto(base);
  for (const [kind, title] of [['text', '文本模型'], ['image', '生图模型'], ['embedding', '资料检索模型'], ['rerank', '检索排序模型']]) {
   await page.getByRole('button', { name: title, exact: true }).click();
   const panel = page.locator('.model-panel:not([hidden])');
   const add = panel.getByRole('button', { name: '新增配置', exact: true });
   await add.waitFor();
   await page.waitForFunction(() => !document.querySelector('.model-panel:not([hidden]) .model-config-manager')?.textContent.includes('正在读取配置'));
   const before = writes;
   await panel.getByRole('button', { name: '模型配置', exact: true }).click();
   let form = panel.getByRole('form'); await form.waitFor();
   await form.getByLabel('方案名称', { exact: true }).fill('不保存的内容');
   await form.getByRole('button', { name: '取消', exact: true }).click();
   assert.equal(await panel.getByRole('form').count(), 0);
   assert.equal(writes, before);
   await panel.getByRole('button', { name: '模型配置', exact: true }).click();
   form = panel.getByRole('form'); await form.waitFor();
   assert.equal(await form.getByLabel('方案名称', { exact: true }).inputValue(), kind === 'text' ? '' : '原有-' + kind);
   await panel.getByRole('button', { name: '模型配置', exact: true }).click();
   assert.equal(await panel.getByRole('form').count(), 0);
   await add.click(); await panel.getByRole('form').waitFor();
   await page.keyboard.press('Escape'); assert.equal(await panel.getByRole('form').count(), 0);
   await add.click(); form = panel.getByRole('form'); await form.waitFor();
   assert.equal(await form.getByLabel('方案名称', { exact: true }).inputValue(), '');
   await form.getByLabel('方案名称', { exact: true }).fill('   ');
   await form.getByLabel('服务地址', { exact: true }).fill('https://new.test/v1');
   await form.getByLabel('模型名称', { exact: true }).fill('model');
   await form.getByRole('button', { name: '保存配置', exact: true }).click();
   await page.getByRole('alert').waitFor();
   await form.getByRole('button', { name: '取消', exact: true }).click();
   assert.equal(await panel.getByRole('form').count(), 0);
   assert.equal(writes, before);
   await add.click(); form = panel.getByRole('form'); await form.waitFor();
   await form.getByLabel('方案名称', { exact: true }).fill('新增-' + kind);
   await form.getByLabel('服务地址', { exact: true }).fill('https://new.test/v1');
   await form.getByLabel('模型名称', { exact: true }).fill('new-model-' + kind);
   await form.getByRole('button', { name: '保存配置', exact: true }).click();
   const row = panel.locator('.profile').filter({ hasText: '新增-' + kind }); await row.waitFor();
   assert.equal(await panel.locator('.profile').count(), 2);
   assert.match(await panel.locator('.config-grid').innerText(), /old-model-/);
   await row.getByRole('button', { name: '设为默认', exact: true }).click();
   await row.locator('.profile-badge').waitFor();
   assert.match(await panel.locator('.config-grid').innerText(), /new-model-/);
   await row.getByRole('button', { name: '编辑配置', exact: true }).click();
   form = panel.getByRole('form'); await form.waitFor();
   assert.equal(await form.getByLabel('模型名称', { exact: true }).inputValue(), 'new-model-' + kind);
   await form.getByRole('button', { name: '取消', exact: true }).click();
   if (kind !== 'text') {
    await add.click(); form = panel.getByRole('form'); await form.waitFor();
    await form.getByLabel('方案名称', { exact: true }).fill('新增-' + kind);
    await form.getByLabel('服务地址', { exact: true }).fill('https://duplicate.test/v1');
    await form.getByLabel('模型名称', { exact: true }).fill('duplicate-model');
    await form.getByRole('button', { name: '保存配置', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: '同名配置已存在' }).waitFor();
    assert.equal(await form.getByLabel('模型名称', { exact: true }).inputValue(), 'duplicate-model');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await panel.getByRole('alert').count(), 0);
    assert.equal(await panel.locator('.profile').count(), 2);
   }
   console.log('PASS ' + title + ': toggle/cancel/Escape, invalid form can cancel, add preserves existing, default activates, edit restores');
  }
  for (const width of [1440, 600, 390]) {
   await page.setViewportSize({ width, height: 1000 });
   for (const title of ['文本模型', '生图模型', '资料检索模型', '检索排序模型']) {
    await page.getByRole('button', { name: title, exact: true }).click();
    const panel = page.locator('.model-panel:not([hidden])');
    await panel.getByRole('button', { name: '新增配置', exact: true }).click();
    await panel.getByRole('form').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await panel.getByRole('button', { name: '取消', exact: true }).click();
   }
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole('button', { name: '生图模型', exact: true }).click();
  await page.getByRole('button', { name: '新增配置', exact: true }).click();
  await page.getByRole('form').waitFor();
  if (process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + '/admin-new-model-configuration.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS desktop/mobile, no page errors; no real model calls or preference writes');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
