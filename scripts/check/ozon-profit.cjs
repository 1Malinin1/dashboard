// Проверка: оплата за заказ по факту отчёта Ozon в дашборде. Код — из env VERIFY_CODE, не печатается.
'use strict';
const { chromium } = require(require('path').join(__dirname,'..','node_modules','playwright-core'));
const URL = process.env.URL || 'http://127.0.0.1:8765/index.html';
const CODE = process.env.VERIFY_CODE;
if (!CODE) { console.error('no code'); process.exit(2); }
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#lockInput', { timeout: 30000 });
  await page.fill('#lockInput', CODE);
  await page.click('.lock-btn');
  await page.waitForFunction(() => typeof ozFinRows === 'function' && typeof RD !== 'undefined' && RD && RD.ozon, null, { timeout: 90000 });
  await page.waitForTimeout(2500);
  const res = await page.evaluate(() => {
    const out = {};
    const rows = ozFinRows(), fixed = ozFixedRate();
    const sum = (from, to) => { const r = rows.filter(x => x.date >= from && x.date <= to);
      const s = k => r.reduce((a, x) => a + (x[k] || 0), 0);
      return { n: r.length, rev: Math.round(s('revenue')), mp: Math.round(s('mpFee')), ad: Math.round(s('ad')),
        cogs: Math.round(s('cogs')), profit: Math.round(s('profit')) }; };
    out.oct = sum('2026-10-01', '2026-10-14');
    out.sep = sum('2026-09-01', '2026-09-30');
    out.aug = sum('2026-08-01', '2026-08-31');
    // инвариант: mpFee = выручка × фикс + реклама — по каждой строке
    out.mpBad = rows.filter(r => Math.abs(r.mpFee - (r.revenue * fixed / 100 + r.ad)) > 0.01).length;
    // инвариант: Σ ad за покрытые дни = Σ XWAY + Σ списаний отчёта
    let xw = 0; ozAdSpendParts().forEach(p => { if (p.from >= '2026-10-01' && p.to <= '2026-10-14') Object.values(p.bySup).forEach(v => xw += v); });
    let fee = 0; Object.entries(RD.ozon.meta.orderFee.byDate).forEach(([d, m]) => { if (d <= '2026-10-14') Object.values(m).forEach(v => fee += v); });
    out.xw = Math.round(xw); out.fee = Math.round(fee);
    out.adOctExact = rows.filter(x => x.date >= '2026-10-01' && x.date <= '2026-10-14').reduce((a, x) => a + x.ad, 0);
    out.feeFactRows = rows.filter(x => x.feeFact).length;
    out.feeOutside = rows.filter(x => x.feeFact && (x.date < '2026-10-01' || x.date > '2026-10-14')).length;
    out.zeroFeeRows = rows.filter(x => x.feeFact && x.revenue === 0 && !x.ordQty).map(x => [x.date, x.sku, Math.round(x.fee)]);
    // цепочка ДРР: части сходятся
    const ar = ozAdRows(), L = ozAdLevels(ar), W = ozAdWindow();
    const finW = rows.filter(r => r.date >= W.from && r.date <= W.to).reduce((a, r) => a + r.ad, 0);
    out.chain = { W, sp: Math.round(L.all.sp), spF: Math.round(L.all.spF), spO: Math.round(L.all.spO), spR: Math.round(L.all.spR),
      finW: Math.round(finW), parts: Math.round(L.all.sp - L.all.spF - L.all.spO - L.all.spR) };
    return out;
  });
  // визуальные подписи на Озоне
  await page.evaluate(() => { switchTab('home'); });
  await page.waitForTimeout(800);
  const b = await page.$('#mpSwitch button[data-mp="ozon"]'); if (b) { await b.click(); await page.waitForTimeout(1800); }
  res.homeFresh = await page.evaluate(() => (document.getElementById('homeFreshness') || document.querySelector('#homeFresh, .fresh'))?.innerText || '');
  await page.evaluate(() => { switchTab('ads'); });
  await page.waitForTimeout(1500);
  const b2 = await page.$('#mpSwitch button[data-mp="ozon"]'); if (b2 && await b2.isVisible()) { await b2.click(); await page.waitForTimeout(1500); }
  res.adsFresh = await page.evaluate(() => document.getElementById('adFreshness')?.innerText || '');
  res.adsHow = await page.evaluate(() => document.getElementById('adHowTo')?.innerText || '');
  res.adsKpi = await page.evaluate(() => [...document.querySelectorAll('#adKpis .kpi')].map(e => e.innerText.replace(/\s+/g, ' ')).slice(0, 4));
  res.adsSubs = await page.evaluate(() => [...new Set([...document.querySelectorAll('#adTable td .sub')].map(e => e.innerText))].slice(0, 12));
  res.errors = errors;
  console.log(JSON.stringify(res, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
