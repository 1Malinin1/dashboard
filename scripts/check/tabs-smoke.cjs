'use strict';
// Прогон всех вкладок × площадок: ошибки консоли, пустые панели. PORT из env.
const { chromium } = require(require('path').join(__dirname,'..','node_modules','playwright-core'));
const CODE=process.env.VERIFY_CODE, PORT=process.env.PORT||8765;
(async()=>{
  const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
  const page=await (await browser.newContext({viewport:{width:1500,height:1000}})).newPage(); const errors=[];
  page.on('pageerror',e=>errors.push('PAGEERR '+String(e.message)));
  page.on('console',m=>{if(m.type()==='error')errors.push('CONSOLE '+m.text());});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`); await page.waitForSelector('#lockInput');
  await page.fill('#lockInput',CODE); await page.click('.lock-btn');
  await page.waitForFunction(()=>typeof resupplyRows==='function'&&RD&&WBDATA&&FINANCE_CACHE&&FINANCE_CACHE.length>0,null,{timeout:120000});
  await page.waitForTimeout(2000);
  const tabs=await page.evaluate(()=>typeof TABS!=='undefined'?TABS:[]);
  console.log('TABS',tabs.join(','));
  for(const t of tabs){
    await page.evaluate(t=>switchTab(t),t); await page.waitForTimeout(900);
    const mps=await page.evaluate(()=>{const s=document.getElementById('mpSwitch'); return s&&s.offsetParent? [...s.querySelectorAll('button[data-mp]')].map(b=>b.dataset.mp):['(нет)'];});
    for(const mp of mps){
      const before=errors.length;
      if(mp!=='(нет)'){ await page.click(`#mpSwitch button[data-mp="${mp}"]`); await page.waitForTimeout(1500); }
      const info=await page.evaluate(t=>{const p=document.getElementById('tab-'+t)||document.querySelector(`[data-tab-panel="${t}"]`)||document.querySelector('section.tab.active, .tab-panel.active'); const txt=p? p.innerText:document.body.innerText; return {len:txt.length, head:txt.replace(/\s+/g,' ').slice(0,140)};},t);
      console.log(`${t.padEnd(10)} ${mp.padEnd(5)} len=${info.len} err+${errors.length-before} | ${info.head}`);
    }
  }
  console.log('ERRORS',errors.length); errors.slice(0,30).forEach(e=>console.log(' ',e.slice(0,300)));
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
