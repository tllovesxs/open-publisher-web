const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.SMOKE_BROWSER_PATH});
 try {
  for(const logged of [true,false]) {
   const context = await browser.newContext({viewport:{width:1280,height:850}});
   await context.addInitScript(() => localStorage.setItem('opw_access_token','test-only'));
   const page = await context.newPage();
   await page.route('http://localhost:5173/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if(path === '/api/auth/me' && !logged) return route.fulfill({status:401,json:{detail:'unauthorized'}});
    return route.fulfill({json:path === '/api/auth/me' ? {id:'test',username:'writer',displayName:'创作者',role:'user'} : path === '/api/articles' ? {articles:[]} : path === '/api/media' ? {assets:[]} : path.includes('profiles') ? {profiles:[]} : path.includes('preferences') ? {disabledNodeIds:[],webSearchMode:'off'} : path.includes('health') ? {status:'ok'} : {}});
   });
   await page.goto('http://localhost:5173/articles');
   const trigger = page.locator('.avatar-menu__trigger');
   await trigger.waitFor({timeout:5000}).catch(async e => { console.log(await page.locator("body").innerText()); throw e; });
   assert.equal(await page.locator('.workspace-topbar .avatar-menu').count(),0);
   for(const width of [1280,900,390]) {
    await page.setViewportSize({width,height:850});
    if(width===390) await page.getByRole('button',{name:'打开导航',exact:true}).click();
    await trigger.click();
    const menu=page.getByRole('menu',{name:'账号菜单',exact:true});
    await menu.waitFor();
    const box=await menu.boundingBox();
    assert.ok(box.x>=0 && box.x+box.width<=width && box.y>=0,JSON.stringify(box));
    assert.equal(await page.getByRole('menuitem',{name:logged?'退出登录':'登录',exact:true}).count(),1);
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
   }
   await context.close();
  }
  console.log('Account relocation passed: authenticated / guest, single entry, upward menu, Escape, 1280 / 900 / 390px');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});



