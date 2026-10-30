const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SMOKE_BASE_URL || 'http://localhost:5173';
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('opw_access_token', 'test-only-token'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let templates = [{ id: 'reference', name: '参考模板', description: '测试参考', category: '参考写作', mode: 'reference', isBuiltIn: false,
      markdown: '# {{title}}\n\n{{body}}', usageInstructions: '只学习写法', referenceMarkdown: '# 完整参考原文\n\n只作写法样本',
      sourceFingerprint: 'sha256:test', styleProfile: { tone: '自然', audience: '开发者', perspective: '作者', sentenceStyle: '短句', pacing: '紧凑', density: '高' },
      structureProfile: { openingPattern: '提问', sectionPattern: '分节', conclusionPattern: '收束', headingDepth: 'H2', paragraphPattern: '短段落' },
      layoutProfile: { useLists: true, useTables: false, useBlockquotes: false, useCodeBlocks: true, imagePlacement: '章节后', emphasisRules: '加粗' },
      fixedBlocks: [], variables: ['title','body'] }];
    let submitted, copied;
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.startsWith('/api/templates/') && request.method() === 'PATCH') {
        templates[0] = { ...templates[0], ...request.postDataJSON() };
        return route.fulfill({ json: templates[0] });
      }
      if (path === '/api/templates' && request.method() === 'POST') {
        copied = request.postDataJSON();
        const clone = { ...copied, id: 'copy', isBuiltIn: false };
        templates.push(clone);
        return route.fulfill({ status: 201, json: clone });
      }
      if (path === '/api/agent-runs/article-create') {
        submitted = request.postDataJSON();
        return route.fulfill({ status: 400, json: { detail: '测试结束，不实际生成' } });
      }
      const responses = {
        '/api/auth/me': { id:'test',username:'tester',displayName:'测试',role:'user' },
        '/api/templates': { templates },
        '/api/settings/profiles': { profiles:[{ id:'fake',name:'测试模型',modelId:'fake',is_default:true,keyConfigured:true }] },
        '/api/settings/image-models': { models:[] },
        '/api/settings/preferences': { disabledNodeIds:[],webSearchMode:'off' },
        '/api/media': { assets:[] },
        '/api/articles': { articles:[] },
      };
      return route.fulfill({ json: responses[path] || {} });
    });
    await page.goto(base + '/templates');
    await page.getByLabel('目标读者', { exact:true }).waitFor();
    if (process.env.SMOKE_SCREENSHOT_DIR) await page.screenshot({ path: require('node:path').join(process.env.SMOKE_SCREENSHOT_DIR, 'template-workbench-desktop.png'), fullPage: false });
    await page.setViewportSize({width:390,height:844});
    if (process.env.SMOKE_SCREENSHOT_DIR) await page.screenshot({ path: require('node:path').join(process.env.SMOKE_SCREENSHOT_DIR, 'template-workbench-mobile.png'), fullPage: false });
    assert.equal(await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth), true, 'template page should not overflow horizontally on mobile');
    await page.setViewportSize({width:1440,height:1000});
    assert.equal(await page.getByLabel('目标读者', { exact:true }).inputValue(), '开发者');
    assert.equal(await page.getByLabel('代码块', { exact:true }).isChecked(), true);
    await page.getByLabel('目标读者', { exact:true }).fill('编辑后的读者');
    await page.getByRole('button', {name:'用于创作',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'请先保存修改'}).waitFor();
    await page.getByRole('button', {name:'保存模板修改',exact:true}).click();
    await page.getByText('有未保存的修改', {exact:true}).waitFor({state:'hidden'});
    await page.getByRole('button', {name:'用于创作',exact:true}).click();
    await page.waitForURL(url => url.pathname === '/');
    await page.getByRole('button').filter({hasText:'高保真参考 · 参考模板'}).waitFor();
    await page.locator('textarea').first().fill('写一篇新的项目介绍');
    const generate = page.getByRole('button', {name:/开始创作/});
    await Promise.all([page.waitForRequest(request => request.url().includes('/api/agent-runs/article-create')), generate.click()]);
    assert.ok(submitted);
    assert.equal(submitted.template.styleProfile.audience, '编辑后的读者');
    assert.equal(submitted.template.referenceMarkdown, templates[0].referenceMarkdown);
    assert.equal(submitted.template.layoutProfile.useCodeBlocks, true);
    assert.equal(submitted.template.mode, 'reference');
    assert.equal(submitted.prompt.includes('{{title}}'), false);
    await page.goto(base + '/templates');
    await page.getByLabel('目标读者', {exact:true}).fill('尚未保存的复制内容');
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/templates' && response.request().method() === 'POST'), page.getByRole('button', {name:'复制另存',exact:true}).click()]);
    await page.getByRole('button', {name:'用于创作',exact:true}).waitFor();
    assert.equal(copied.styleProfile.audience,'尚未保存的复制内容');
    assert.equal(copied.referenceMarkdown,templates[0].referenceMarkdown);
    await page.goto(base + '/articles?template=reference');
    await page.waitForURL(url => url.pathname === '/');
    await page.getByRole('button').filter({hasText:'高保真参考 · 参考模板'}).waitFor();
    await page.setViewportSize({width:390,height:844});
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS template profile editing, save/use, full creation payload, unsaved copy, legacy link and narrow viewport');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
