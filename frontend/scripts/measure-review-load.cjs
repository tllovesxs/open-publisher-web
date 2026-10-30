// Local cold-cache build measurements, not a Lighthouse score or public SLA.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.MEASURE_BASE_URL || 'http://127.0.0.1:5186';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_BROWSER_PATH });
  const samples = [];
  try {
    for (let run = 0; run < 3; run++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await page.route('**/api/**', route => route.fulfill({ json: { status: 'ok', profiles: [], assets: [], disabledNodeIds: [] } }));
      await page.goto(base);
      await page.locator('.creation-studio').waitFor();
      await page.waitForLoadState('networkidle');
      const result = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        return { domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
          firstContentfulPaintMs: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0),
          scriptBytes: resources.filter(r => r.name.endsWith('.js')).reduce((n, r) => n + r.encodedBodySize, 0),
          scriptCount: resources.filter(r => r.name.endsWith('.js')).length,
          diagramRequests: resources.filter(r => /mermaid|elk-|cynefin/.test(r.name)).map(r => r.name) };
      });
      assert.deepEqual(result.diagramRequests, [], 'plain creation page must not load diagram engines');
      samples.push(result);
      await context.close();
    }
  } finally { await browser.close(); }
  const report = { date: '2026-10-30', environment: 'Local production Vite preview, Edge headless, cold cache, no throttling, mock health/settings APIs; excludes model latency and public network', samples };
  fs.writeFileSync(path.resolve(__dirname, '../../docs/submission/load-measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
