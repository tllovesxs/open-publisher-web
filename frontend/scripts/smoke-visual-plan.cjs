// Isolated blueprint visual-flow regression. Every API is mocked; no paid requests.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5173';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/agsAAAAASUVORK5CYII=', 'base64');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  const reports = [];
  try {
    async function setup(options = {}) {
      const context = await browser.newContext();
      await context.addInitScript(({ manual }) => {
        localStorage.setItem('opw_access_token', 'test-only-token');
        if (!manual) sessionStorage.setItem('gaoliu.active-article-run', JSON.stringify({
          runId: 'visual-run', articleId: 'visual-test', title: '配图回归', ownerUserId: 'test',
          visualPlan: { enabled: true, targetCount: 6, mode: 'fixed', imageModelId: 'image-2', assetIds: ['chosen'], materialMatchThreshold: 40 },
        }));
        window.EventSource = class { constructor() { window.__visualStream = this; } close() {} };
      }, { manual: Boolean(options.manual) });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let article = { articleId: 'visual-test', title: '配图回归', markdown: '# 配图回归\n\n## 正文\n\n已保存的文章正文。\n', currentRevisionId: 'r1', contentHash: 'h1', updatedAt: null };
      const calls = [], attempts = new Map(), completedImages = new Set();
      let inflight = 0, maxInflight = 0, applied = 0, planned = 0;
      await page.route(`${base}/api/**`, async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const body = request.method() === 'POST' ? request.postDataJSON() : null;
        calls.push({ path, body, method: request.method() });
        if (path.endsWith('/raw')) return route.fulfill({ contentType: 'image/png', body: image });
        if (path.endsWith('/visual-plan')) {
          planned++;
          const count = options.manual ? 1 : body.targetCount;
          return route.fulfill({ json: {
            targetCount: count, sourceRevisionId: article.currentRevisionId, sourceContentHash: article.contentHash,
            materialMatchThreshold: body.materialMatchThreshold, assetIds: body.assetIds, mode: body.mode, needsConfirmation: true,
            placements: Array.from({ length: count }, (_, index) => ({
              id: `p${index}`, anchorHeading: '正文', anchorExcerpt: '已保存的文章正文。', alt: `配图${index}`,
              source: 'generate', assetId: null, selectionReason: '说明正文关系', generationPrompt: `prompt-${index}`,
              candidates: options.candidates ? [{ assetId: 'chosen', score: 650, description: '选中的素材' }] : [],
            })),
          } });
        }
        if (path.endsWith('/visual-validate')) return route.fulfill({ json: { valid: true } });
        if (path === '/api/media/preview') throw new Error('Preview must never generate an image');
        if (path === '/api/media/generate') {
          const key = body.prompt;
          const attempt = (attempts.get(key) || 0) + 1;
          attempts.set(key, attempt);
          inflight++; maxInflight = Math.max(maxInflight, inflight);
          if (options.staleDuringGeneration) article = { ...article, currentRevisionId: 'changed', contentHash: 'changed' };
          await new Promise(resolve => setTimeout(resolve, 180));
          inflight--;
          if (options.failOnce && key === 'prompt-1' && attempt === 1) return route.fulfill({ status: 502, json: { detail: '模拟单张生图失败' } });
          completedImages.add(key);
          return route.fulfill({ status: 201, json: { id: `generated-${key}` } });
        }
        if (path.endsWith('/visual-apply')) {
          assert.equal(inflight, 0);
          assert.ok(body.placements.every(item => item.source === 'existing_asset' && item.assetId));
          applied++;
          article = { ...article, currentRevisionId: 'r2', contentHash: 'h2', markdown: article.markdown + body.placements.map(p => `\n![${p.alt}](asset://${p.assetId})`).join('') };
          return route.fulfill({ json: { article, insertedCount: body.placements.length, skipped: [] } });
        }
        if (path === '/api/articles' && request.method() === 'POST') {
          article = { ...article, markdown: body.markdown, currentRevisionId: 'saved', contentHash: 'saved' };
          return route.fulfill({ status: 201, json: article });
        }
        const responses = {
          '/api/auth/me': { id: 'test', username: 'tester', displayName: 'Tester', role: 'user' },
          '/api/settings/image-models': { models: [{ id: 'image-1', name: '模型一', model: 'first' }, { id: 'image-2', name: '模型二', model: 'chosen-model' }] },
          '/api/settings/profiles': { profiles: [] }, '/api/settings/preferences': { disabledNodeIds: [], webSearchMode: 'off' },
          '/api/articles': { articles: [article] }, '/api/articles/visual-test': article, '/api/media': { assets: [] },
        };
        return route.fulfill({ json: responses[path] || {} });
      });
      await page.goto(base + '/articles?open=visual-test', { waitUntil: 'domcontentloaded' });
      const editor = page.getByRole('textbox', { name: 'Markdown 正文', exact: true });
      await editor.waitFor();
      if (!options.manual) {
        await page.waitForFunction(() => typeof window.__visualStream?.onmessage === 'function');
        if (options.finishOnOtherPage) await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.__visualStream?.onmessage === 'function');
        await page.evaluate(failed => window.__visualStream.onmessage({ data: JSON.stringify({ sequence: 1, type: failed ? 'run.failed' : 'run.completed', payload: failed ? { message: 'LLM 调用失败：Connection error.' } : {}, runId: 'visual-run', articleId: 'visual-test' }) }), Boolean(options.writerConnectionFailure));
        if (options.writerConnectionFailure) {
          await page.getByText('创作失败：LLM 调用失败：Connection error.', { exact: true }).waitFor();
        } else {
          await page.getByRole('dialog', { name: '确认配图方案' }).waitFor();
          await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent === '确认并继续' && !b.disabled));
        }
      }
      return { context, page, editor, calls, errors, attempts, completedImages, changeRemote: () => { article = { ...article, currentRevisionId: 'remote', contentHash: 'remote' }; }, stats: () => ({ applied, planned, maxInflight, generated: [...attempts.values()].reduce((a, b) => a + b, 0) }) };
    }

    // Plan and replan never generate. Scope, chosen model and threshold survive.
    {
      const t = await setup({ candidates: true });
      const dialog = t.page.getByRole('dialog', { name: '确认配图方案' });
      assert.equal(await dialog.getByRole('combobox', { name: '生图模型', exact: true }).inputValue(), 'image-2');
      assert.equal(t.stats().generated, 0);
      assert.equal(await dialog.getByRole('button', { name: '预览', exact: true }).count(), 0);
      await dialog.getByRole('slider', { name: '素材匹配阈值' }).fill('100');
      await dialog.getByText('预计生图 6 张', { exact: false }).waitFor();
      await dialog.getByRole('button', { name: '重新生成策略' }).click();
      await t.page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '确认并继续')?.disabled);
      const plans = t.calls.filter(c => c.path.endsWith('/visual-plan'));
      assert.deepEqual(plans.at(-1).body.assetIds, ['chosen']);
      assert.equal(plans.at(-1).body.materialMatchThreshold, 100);
      assert.equal(await dialog.getByRole('combobox', { name: '生图模型', exact: true }).inputValue(), 'image-2');
      // User can override the threshold and reuse an intentionally chosen material.
      await dialog.getByRole('radiogroup', { name: '配图 1 来源', exact: true }).getByRole('radio', { name: '使用素材', exact: true }).check();
      await dialog.getByRole('combobox', { name: '配图 1 素材', exact: true }).waitFor();
      await dialog.getByRole('radiogroup', { name: '配图 1 来源', exact: true }).getByRole('radio', { name: 'AI 生图', exact: true }).check();
      const layouts = [];
      for (const width of [1280, 390]) {
        await t.page.setViewportSize({ width, height: 720 });
        layouts.push(await dialog.evaluate(el => ({ width: innerWidth, fits: el.getBoundingClientRect().right <= innerWidth + 1, noOverflow: el.scrollWidth <= el.clientWidth + 1 })));
      }
      assert.ok(layouts.every(x => x.fits && x.noOverflow), JSON.stringify(layouts));
      if (process.env.SMOKE_SCREENSHOT) await t.page.screenshot({ path: process.env.SMOKE_SCREENSHOT });
      await dialog.getByRole('button', { name: '确认并继续' }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(t.stats(), { applied: 1, planned: 2, maxInflight: 4, generated: 6 });
      assert.ok(t.calls.filter(c => c.path === '/api/media/generate').every(c => c.body.size === '1536x1024' && c.body.imageModelId === 'image-2'));
      assert.deepEqual(t.errors, []);
      reports.push({ scenario: 'confirm-four-wide-and-scope', ...t.stats(), layouts });
      await t.context.close();
    }
    // Cancel never triggers images.
    {
      const t = await setup();
      await t.page.getByRole('button', { name: '暂不配图', exact: true }).click();
      assert.equal(t.stats().generated, 0); assert.equal(t.stats().applied, 0);
      reports.push({ scenario: 'cancel-zero-images', ...t.stats() }); await t.context.close();
    }
    // Global orchestration still plans when the user leaves the article page.
    {
      const t = await setup({ finishOnOtherPage: true });
      assert.ok(t.page.url().includes('/settings'));
      assert.equal(t.stats().planned, 1); assert.equal(t.stats().generated, 0);
      await t.page.getByRole('button', { name: '暂不配图', exact: true }).click();
      reports.push({ scenario: 'global-plan-after-navigation', ...t.stats() }); await t.context.close();
    }
    // A remote revision change before approval never triggers an image request.
    {
      const t = await setup();
      t.changeRemote();
      await t.page.getByRole('button', { name: '确认并继续', exact: true }).click();
      await t.page.getByText('当前策略已过期', { exact: true }).waitFor();
      assert.equal(t.stats().generated, 0); assert.equal(t.stats().applied, 0);
      reports.push({ scenario: 'stale-before-confirm-zero-images', ...t.stats() }); await t.context.close();
    }
    // No partial insert after one failure; successful images are reused on retry.
    {
      const t = await setup({ failOnce: true });
      await t.page.getByRole('button', { name: '确认并继续', exact: true }).click();
      await t.page.getByText('模拟单张生图失败', { exact: true }).waitFor();
      assert.equal(t.stats().applied, 0); assert.equal(t.stats().generated, 4);
      await t.page.getByRole('button', { name: '确认并继续', exact: true }).click();
      await t.page.getByRole('dialog', { name: '确认配图方案' }).waitFor({ state: 'hidden' });
      assert.equal(t.stats().generated, 7); assert.equal(t.stats().applied, 1);
      assert.equal(t.attempts.get('prompt-0'), 1); assert.equal(t.attempts.get('prompt-1'), 2);
      reports.push({ scenario: 'failed-batch-retry-reuses-successes', ...t.stats() }); await t.context.close();
    }
    // Revision changes stop the next batch and final insertion.
    {
      const t = await setup({ staleDuringGeneration: true });
      await t.page.getByRole('button', { name: '确认并继续', exact: true }).click();
      await t.page.getByText('当前策略已过期', { exact: true }).waitFor();
      assert.equal(t.stats().generated, 4); assert.equal(t.stats().applied, 0);
      assert.ok(await t.page.getByRole('button', { name: '确认并继续', exact: true }).isDisabled());
      reports.push({ scenario: 'revision-change-stops-next-batch', ...t.stats() }); await t.context.close();
    }
    // Dirty draft is persisted before planning; edits after planning invalidate it.
    {
      const t = await setup({ manual: true });
      await t.editor.fill('# 修改后正文\n\n用户新写的段落。');
      await t.page.getByRole('button', { name: '智能配图', exact: true }).click();
      await t.page.getByRole('dialog', { name: '确认配图方案' }).waitFor();
      const saveIndex = t.calls.findIndex(c => c.path === '/api/articles' && c.method === 'POST');
      const planIndex = t.calls.findIndex(c => c.path.endsWith('/visual-plan'));
      assert.ok(saveIndex >= 0 && saveIndex < planIndex);
      assert.equal(t.calls[planIndex].body.mode, 'auto');
      await t.page.getByRole('button', { name: '配图任务转后台' }).click();
      await t.editor.fill('规划后继续编辑');
      await t.page.locator('.visual-plan-chip').click();
      await t.page.getByText('当前策略已过期', { exact: true }).waitFor();
      assert.ok(await t.page.getByRole('button', { name: '确认并继续', exact: true }).isDisabled());
      assert.equal(t.stats().generated, 0);
      reports.push({ scenario: 'save-before-plan-and-dirty-invalidation', ...t.stats() }); await t.context.close();
    }
    // Text connection failure must never start visual planning or image generation.
    {
      const t = await setup({ writerConnectionFailure: true });
      assert.deepEqual(t.stats(), { applied: 0, planned: 0, maxInflight: 0, generated: 0 });
      assert.equal(await t.page.getByRole('dialog', { name: '确认配图方案' }).count(), 0);
      assert.deepEqual(t.errors, []);
      reports.push({ scenario: 'writer-connection-failure-no-visual-work', ...t.stats() }); await t.context.close();
    }
    console.log(JSON.stringify(reports));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
