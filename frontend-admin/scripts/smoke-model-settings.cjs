const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_BROWSER_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1245, height: 889 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('opw_access_token', 'test-only'));
    let release;
    let signal;
    const started = new Promise(resolve => { signal = resolve; });
    const tested = [];
    let saved;
    let savedRag;
    const template = { id: 't1', name: '测试模板', description: '说明', category: '通用', markdown: '# 标题', usageInstructions: '', styleProfile: { tone: '自然', forbiddenPatterns: ['夸大'], custom: '保留' }, structureProfile: { sectionOrder: ['开头', '正文'] }, layoutProfile: {}, fixedBlocks: [{ name: '结尾', content: '谢谢阅读', position: '文末' }], variables: [], isBuiltIn: false };
    const rag = { embeddingBaseUrl: 'https://embed.example.test', embeddingModel: 'embed', embeddingKeyConfigured: true, rerankBaseUrl: 'https://rank.example.test', rerankModel: 'ranker', rerankTimeoutSeconds: 7, source: 'db' };
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith('/model/test')) {
        signal();
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({ json: { model: 'test', latencyMs: 12 } });
      }
      if (path.endsWith('/rag/test')) {
        tested.push(url.searchParams.get('target'));
        return route.fulfill({ json: { embedding: { ok: false, detail: '404 model not found; INTERNAL request id' }, rerank: { ok: true, latencyMs: 8 } } });
      }
      if (path.endsWith('/templates/t1') && route.request().method() === 'PATCH') {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: { ...template, ...saved } });
      }
      if (path.endsWith('/settings/rag') && route.request().method() === 'PUT') {
        savedRag = route.request().postDataJSON();
        return route.fulfill({ json: { ...rag, ...savedRag } });
      }
      const data = path.endsWith('/auth/me') ? { id: 'test', username: 'admin', displayName: '管理员', role: 'admin' }
        : path.endsWith('/profiles') ? { profiles: [] }
        : path.endsWith('/settings/rag') ? rag
        : path.endsWith('/templates') ? { templates: [template] }
        : path.endsWith('/templates/t1') ? template
        : { baseUrl: 'https://example.test/v1', model: 'test-model', keyConfigured: false, keySource: 'none', keyHint: '', timeoutSeconds: 60, source: 'db' };
      return route.fulfill({ json: data });
    });
    await page.goto(process.env.ADMIN_BASE_URL || 'http://localhost:5174');
    assert.equal(await page.getByRole('button', { name: '密钥安全', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '文本模型方案', exact: true }).count(), 0);
    await page.getByRole('button', { name: '模型配置', exact: true }).click();
    assert.equal(await page.locator('.config-form').count(), 1);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await started;
    await page.getByRole('button', { name: '生图模型', exact: true }).click();
    release();
    await page.waitForResponse(response => response.url().endsWith('/model/test'));
    assert.equal(await page.getByRole('status').count(), 0);
    await page.getByRole('button', { name: '文本模型', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    await page.getByRole('button', { name: '资料检索模型', exact: true }).click();
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '当前服务不支持所选模型' }).waitFor();
    await page.getByRole('button', { name: '检索排序模型', exact: true }).click();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    assert.deepEqual(tested, ['embedding', 'rerank']);
    await page.getByRole('button', { name: '编辑配置', exact: true }).click();
    await page.getByLabel('服务地址', { exact: true }).fill('https://new-rank.example.test');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(savedRag.embeddingBaseUrl, rag.embeddingBaseUrl);
    assert.equal(savedRag.embeddingModel, rag.embeddingModel);
    assert.equal(savedRag.rerankBaseUrl, 'https://new-rank.example.test');
    assert.equal(savedRag.rerankModel, 'ranker');
    for (const width of [1245, 600]) {
      await page.setViewportSize({ width, height: 889 });
      for (const name of ['文本模型', '生图模型', '资料检索模型', '检索排序模型']) {
        await page.getByRole('button', { name, exact: true }).click();
        assert.equal(await page.locator('.admin-card:not([hidden])').count(), 1);
        assert.equal(await page.getByRole('button', { name: '模型配置', exact: true }).count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
    }
    await page.goto((process.env.CLIENT_BASE_URL || 'http://localhost:5173') + '/templates');
    await page.locator('.article-browser').waitFor();
    await page.getByLabel('文章语气', { exact: true }).fill('亲切自然');
    await page.getByLabel('固定内容', { exact: true }).fill('欢迎交流');
    const response = page.waitForResponse(response => response.url().endsWith('/templates/t1') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存画像', exact: true }).click();
    await response;
    assert.equal(saved.styleProfile.tone, '亲切自然');
    assert.equal(saved.styleProfile.custom, '保留');
    assert.deepEqual(saved.styleProfile.forbiddenPatterns, ['夸大']);
    assert.equal(saved.fixedBlocks[0].content, '欢迎交流');
    assert.deepEqual(errors, []);
    console.log('PASS: scoped async notices, selected-service tests, preserved configuration, four admin views at two widths, template edit/save, no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
