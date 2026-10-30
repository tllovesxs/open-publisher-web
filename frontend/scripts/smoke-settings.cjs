const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5183';
const stages = ['资料整理', '大纲规划', '正文撰写', '自然表达', '内容审阅', '资料核验', '风险检查', '配图规划'];
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    for (const count of [2, 1, 0]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, colorScheme: 'light' });
      await context.addInitScript(() => localStorage.setItem('opw_access_token', 'test-only-token'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const profiles = [{ id: 'a', name: '写作模型', modelId: 'private-model-id', baseUrl: 'https://private.test', capabilities: { contextWindow: 128000 }, keyHint: 'secret-tail', isDefault: true }, { id: 'b', name: '审阅模型', modelId: 'private-second' }].slice(0, count);
      const catalogs = Object.fromEntries(['image','embedding','rerank'].map(kind => { const models = ['one','two'].slice(0, count === 0 ? 2 : kind === 'rerank' && count === 1 ? 0 : count).map(id => ({id:kind + '-' + id,name:kind + '-' + id})); return [kind,{models,defaultId:models[0]?.id ?? null}]; }));
      let prefs = { imageModelId:null, embeddingModelId:null, rerankModelId:null, disabledNodeIds: ['draft', 'risk'], webSearchMode: 'off', profileId: null, nodeProfileIds: {} };
      let saved = 0;
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/settings/preferences' && route.request().method() === 'PUT') {
          prefs = route.request().postDataJSON(); saved++;
          return route.fulfill({ json: prefs });
        }
        const data = {
          '/api/auth/me': { id: 'test', username: 'tester', role: 'admin' },
          '/api/settings/profiles': { profiles },
          '/api/settings/preferences': prefs,
          '/api/settings/available-models': catalogs,
          '/api/settings/integrations': { trustedHosts: [], publishBridgeUrl: '' },
        };
        await route.fulfill({ json: data[path] || {} });
      });
      await page.goto(base + '/settings');
      await page.getByRole('heading', { name: '模型选择', exact: true }).waitFor();
      const settingsNav = page.getByRole('navigation', { name: '设置分类' });
      assert.equal(await settingsNav.getByRole('button').count(), 4);
      assert.equal(await settingsNav.getByRole('button', { name: '数据', exact: true }).count(), 0);
      assert.equal(await page.locator('.client-settings-layout').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
      await page.waitForFunction(expected => document.querySelector('[aria-label="默认写作模型"]')?.textContent.includes(expected), count ? '写作模型' : '暂无可用模型');
      assert.equal(await page.locator('.client-settings-model-row').count(), 11);
      for (const stage of stages) assert.equal(await page.getByRole('button', { name: stage + '默认模型', exact: true }).isDisabled(), count <= 1);
      assert.equal(await page.getByRole('button', { name: '默认写作模型', exact: true }).isDisabled(), count <= 1);
      assert.equal(await page.getByRole('button', { name: '保存模型选择', exact: true }).isDisabled(), false);
      for (const [kind,label] of [['image','生图模型'],['embedding','资料检索模型（向量）'],['rerank','检索排序模型']]) {
        const select = page.getByRole('button', {name:label,exact:true});
        const models = catalogs[kind].models;
        assert.equal(await select.isDisabled(), models.length <= 1);
        assert.equal(await select.innerText(), models.length === 0 ? '暂无可用模型' : models.length === 1 ? models[0].name : '平台默认（' + models[0].name + '）');
      }
      const extraRows = await page.locator('.client-settings-extra-models .client-settings-model-row').evaluateAll(rows => rows.map(row => { const box = row.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, bottom: box.bottom }; }));
      assert.equal(extraRows.length, 3);
      for (let index = 1; index < extraRows.length; index++) {
        assert.equal(extraRows[index].x, extraRows[0].x);
        assert.equal(extraRows[index].width, extraRows[0].width);
        assert.ok(extraRows[index].y >= extraRows[index - 1].bottom);
      }
      if (count === 2) {
        for (const [kind,label] of [['image','生图模型'],['embedding','资料检索模型（向量）'],['rerank','检索排序模型']]) {
          await page.getByRole('button', {name:label,exact:true}).click();
          await page.getByRole('option', {name:kind + '-two',exact:true}).click();
        }
        await page.getByRole('button', { name: '内容审阅默认模型', exact: true }).click();
        await page.getByRole('option', { name: '审阅模型', exact: true }).click();
        await page.getByRole('button', { name: '默认写作模型', exact: true }).click();
        await page.getByRole('option', { name: '写作模型', exact: true }).click();
        await page.getByRole('button', { name: '保存模型选择', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '模型选择已保存' }).waitFor();
        assert.equal(saved, 1);
        assert.equal(prefs.profileId, 'a');
        for (const kind of ['image','embedding','rerank']) assert.equal(prefs[kind + 'ModelId'],kind + '-two');
        assert.deepEqual(prefs.nodeProfileIds, { review: 'b' });
        assert.deepEqual(prefs.disabledNodeIds, ['risk']);
        await page.reload();
        await page.getByRole('button', { name: '内容审阅默认模型', exact: true }).filter({ hasText: '审阅模型' }).waitFor();
        await page.getByRole('button', {name:'生图模型',exact:true}).filter({hasText:'image-two'}).waitFor();
        await page.getByRole('button', {name:'资料检索模型（向量）',exact:true}).filter({hasText:'embedding-two'}).waitFor();
        await page.getByRole('button', {name:'检索排序模型',exact:true}).filter({hasText:'rerank-two'}).waitFor();
        await page.getByRole('button', { name: '内容审阅默认模型', exact: true }).click();
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('listbox').count(), 0);
      } else if (count === 1) {
        for (const stage of stages) assert.match(await page.getByRole('button', { name: stage + '默认模型', exact: true }).innerText(), /写作模型/);
      }
      const visible = await page.locator('.settings-page').innerText();
      for (const privateText of ['private-model-id', 'private.test', 'secret-tail', '上下文', '最大输出', '模型能力配置']) assert.ok(!visible.includes(privateText), privateText);
      if (count === 2 && process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + '/client-settings-models.png', fullPage: true });
      await page.getByRole('button', { name: '外观', exact: true }).click();
      await page.getByRole('group', { name: '主题模式' }).getByRole('button', { name: '深色', exact: false }).click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      assert.equal(await page.evaluate(() => localStorage.getItem('opw-theme-setting')), 'dark');
      await page.reload();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      await page.getByRole('button', { name: '外观', exact: true }).click();
      assert.equal(await page.getByRole('group', { name: '主题模式' }).getByRole('button', { name: '深色', exact: false }).getAttribute('aria-pressed'), 'true');
      if (count === 2 && process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + '/client-settings-appearance.png', fullPage: true });
      await page.getByRole('group', { name: '主题模式' }).getByRole('button', { name: '浅色', exact: false }).click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      await settingsNav.getByRole('button', { name: '写作', exact: true }).click();
      assert.equal(await page.locator('.client-settings-stage-icon > svg').count(), 8);
      assert.equal(await page.getByRole('checkbox', { name: '正文撰写', exact: true }).isChecked(), true);
      assert.equal(await page.getByRole('checkbox', { name: '正文撰写', exact: true }).isDisabled(), true);
      await page.getByRole('checkbox', { name: '资料整理', exact: true }).uncheck();
      assert.equal(await page.getByRole('button', { name: '联网检索', exact: false }).isDisabled(), true);
      await page.getByRole('checkbox', { name: '资料整理', exact: true }).check();
      assert.equal(await page.getByRole('button', { name: '联网检索', exact: false }).isDisabled(), false);
      assert.equal(await page.getByRole('checkbox', { name: '风险检查', exact: true }).isChecked(), false);
      await page.getByRole('checkbox', { name: '风险检查', exact: true }).check();
      await page.getByRole('checkbox', { name: '大纲规划', exact: true }).uncheck();
      const previousSaved = saved;
      await page.getByRole('button', { name: '保存写作偏好', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '写作偏好已保存' }).waitFor();
      assert.equal(saved, previousSaved + 1);
      assert.deepEqual(prefs.disabledNodeIds, ['outline']);
      assert.equal(prefs.webSearchMode, 'off');
      if (count === 2) assert.deepEqual(prefs.nodeProfileIds, { review: 'b' });
      if (count === 2 && process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + '/client-settings-writing.png', fullPage: true });
      await page.reload();
      await settingsNav.getByRole('button', { name: '写作', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('input[aria-label="大纲规划"]')?.checked === false);
      assert.equal(await page.getByRole('checkbox', { name: '风险检查', exact: true }).isChecked(), true);
      await settingsNav.getByRole('button', { name: '外观', exact: true }).click();
      await page.getByRole('button', { name: '跟随系统', exact: false }).click();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: '模型', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('.client-settings-model-grid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
      await settingsNav.getByRole('button', { name: '写作', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('.client-settings-writing-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
      if (count === 2 && process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + '/client-settings-writing-mobile.png', fullPage: true });
      assert.deepEqual(errors, []);
      console.log('passed profiles=' + count + ': per-stage defaults, privacy, theme persistence, system theme, mobile');
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
