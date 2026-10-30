const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.SMOKE_BASE_URL || "http://localhost:5173";
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SMOKE_BROWSER_PATH ? { executablePath: process.env.SMOKE_BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const exampleRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().includes("/api/examples/")) exampleRequests.push(request.url()); });
    await page.route("**/api/**", route => route.abort("connectionrefused"));
    await page.goto(base + "/templates");
    await page.locator(".template-toolbar h2").filter({ hasText: "产品推广" }).waitFor();
    assert.equal(await page.locator(".template-library__list button").count(), 2);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.ok((await page.getByRole("textbox", { name: "模板骨架", exact: true }).inputValue()).includes("{{product_name}}"));
    await page.getByRole("button", { name: "复制另存", exact: true }).click();
    await page.locator(".template-toolbar h2").filter({ hasText: "副本" }).waitFor();
    assert.equal(await page.locator(".template-library__list button").count(), 3);
    await page.reload();
    await page.locator(".template-library__list button").filter({ hasText: "副本" }).waitFor();
    await page.locator(".template-library__list button").filter({ hasText: "产品推广", hasNotText: "副本" }).click();
    await page.getByRole("button", { name: "用于创作", exact: true }).click();
    await page.waitForURL(url => url.searchParams.get("template") === "product-promotion");
    await page.locator(".creation-toolbar__button strong").filter({ hasText: "产品推广" }).waitFor();
    await page.goto(base + "/templates");
    await page.locator(".template-library__list button").filter({ hasText: "实用指南模板" }).waitFor();
    if (process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + "/templates-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开模板列表", exact: true }).click();
    await page.locator(".template-library__list button").filter({ hasText: "实用指南模板" }).click();
    assert.equal(await page.locator(".template-toolbar h2").innerText(), "实用指南模板");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.SMOKE_OUTPUT_DIR) await page.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + "/templates-mobile.png" });
    assert.deepEqual(exampleRequests, [], "starter content must not depend on example API");
    assert.deepEqual(errors, []);
    await context.close();

    const signedIn = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await signedIn.addInitScript(() => localStorage.setItem("opw_access_token", "test-only-token"));
    const memberPage = await signedIn.newPage();
    let failing = true;
    await memberPage.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/me") return route.fulfill({ json: { id: "smoke-user", username: "tester", displayName: "测试", role: "user" } });
      if (path === "/api/templates") return failing ? route.fulfill({ status: 503, json: { detail: "unavailable" } }) : route.fulfill({ json: { templates: [{ id: "custom-smoke", name: "我的模板", description: "个人模板", category: "自定义", markdown: "# {{title}}", isBuiltIn: false, mode: "scaffold" }, { id: "product-promotion", name: "产品推广", description: "官方模板", category: "产品推广", markdown: "# {{title}}", isBuiltIn: true, mode: "scaffold" }] } });
      return route.fulfill({ json: {} });
    });
    await memberPage.goto(base + "/templates");
    await memberPage.getByRole("status").filter({ hasText: "个人模板暂时无法同步" }).waitFor();
    assert.equal(await memberPage.locator(".template-library__list button").count(), 2);
    if (process.env.SMOKE_OUTPUT_DIR) await memberPage.screenshot({ path: process.env.SMOKE_OUTPUT_DIR + "/templates-server-unavailable.png" });
    failing = false;
    await memberPage.getByRole("button", { name: "重新加载", exact: true }).click();
    await memberPage.locator(".template-library__list button").filter({ hasText: "我的模板" }).waitFor();
    assert.equal(await memberPage.locator(".template-library__list button").count(), 3, "official template must not be duplicated");
    assert.equal(await memberPage.getByRole("status").filter({ hasText: "个人模板暂时无法同步" }).count(), 0);
    for (const status of [401, 403]) {
      await memberPage.route("**/api/templates", route => route.fulfill({ status, json: { detail: "denied" } }));
      await memberPage.reload();
      await memberPage.getByRole("alert").filter({ hasText: "无法加载模板列表" }).waitFor();
      assert.equal(await memberPage.locator(".template-library__list button").count(), 0, "authentication errors must not be masked");
    }
    await signedIn.close();
    console.log(JSON.stringify({ result: "PASS", checks: ["guest starter templates without backend", "full official template content", "copy persists across reload", "template passed into creation", "mobile selection and no overflow", "no public example network dependency", "503 fallback and retry recovery", "personal templates preserved and official deduplicated", "401/403 remain errors", "no page errors"] }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
