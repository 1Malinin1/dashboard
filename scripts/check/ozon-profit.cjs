// Проверка: оплата за заказ по факту отчёта Ozon в дашборде. Код — из env VERIFY_CODE, не печатается.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { withBrowser, unlockDashboard } = require('../lib/dashboard-browser.cjs');
async function checkOzon(url, dir) {
  return withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e && e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url, { waitUntil: 'load' });
    await unlockDashboard(page, process.env.VERIFY_CODE);
    await page.waitForFunction(() => typeof ozFinRows === 'function' && typeof RD !== 'undefined' && RD && RD.ozon, null, { timeout: 90000 });
    await page.waitForTimeout(2500);
    const res = await page.evaluate(() => {
      const out = {};
      const rows = ozFinRows(), fixed = ozFixedRate();
      const sum = (from, to) => { const r = rows.filter(x => x.date >= from && x.date <= to);
        const s = k => r.reduce((a, x) => a + (x[k] || 0), 0);
        return { n: r.length, rev: Math.round(s('revenue')), mp: Math.round(s('mpFee')), ad: Math.round(s('ad')),
          cogs: Math.round(s('cogs')), profit: Math.round(s('profit')) }; };
      /* Окно отчётов «Оплата за заказ» берём ИЗ ДАННЫХ (первый и последний день периодов отчёта), а не
         числом: при жёстких 01–14.10 после заливки 15–18.10 проверка считала 282 строки «вне окна». */
      const D = (RD.ozon.orderSeries.dates || []), lastOz = D[D.length - 1];
      const FP = RD.ozon.meta.orderFee.periods;
      const feeFrom = FP.reduce((m, p) => (!m || p.from < m) ? p.from : m, '');
      const feeTo0 = FP.reduce((m, p) => (!m || p.to > m) ? p.to : m, ''), feeTo = feeTo0 > lastOz ? lastOz : feeTo0;
      const octTo = lastOz < '2026-10-31' ? lastOz : '2026-10-31';
      out.feeWin = [feeFrom, feeTo];
      out.oct = sum('2026-10-01', octTo); out.oct.to = octTo;
      out.oct14 = sum('2026-10-01', '2026-10-14');            // опорная цифра 15.10.2026: реклама 1 242 047
      out.sep = sum('2026-09-01', '2026-09-30');
      out.aug = sum('2026-08-01', '2026-08-31');
      // инвариант: mpFee = выручка × фикс + реклама — по каждой строке
      out.mpBad = rows.filter(r => {
        const difference = r.mpFee - (r.revenue * fixed / 100 + r.ad);
        return !Number.isFinite(difference) || Math.abs(difference) > 0.01;
      }).length;
      // инвариант: Σ ad за дни с отчётом = Σ XWAY + Σ списаний отчёта
      let xw = 0; ozAdSpendParts().forEach(p => { if (p.from >= feeFrom && p.to <= feeTo) Object.values(p.bySup).forEach(v => xw += v); });
      let fee = 0; Object.entries(RD.ozon.meta.orderFee.byDate).forEach(([d, m]) => { if (d >= feeFrom && d <= feeTo) Object.values(m).forEach(v => fee += v); });
      out.xw = Math.round(xw); out.fee = Math.round(fee);
      out.adFeeWin = rows.filter(x => x.date >= feeFrom && x.date <= feeTo).reduce((a, x) => a + x.ad, 0);
      out.feeChain = Math.round(out.adFeeWin - xw - fee);      // должно быть 0
      out.adOctExact = rows.filter(x => x.date >= '2026-10-01' && x.date <= '2026-10-14').reduce((a, x) => a + x.ad, 0);
      out.feeFactRows = rows.filter(x => x.feeFact).length;
      out.feeOutside = rows.filter(x => x.feeFact && (x.date < feeFrom || x.date > feeTo)).length;
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
    if (dir) require('node:fs').writeFileSync(path.join(dir, 'ozon-result.json'), JSON.stringify(res));
    else console.log(JSON.stringify(res, null, 1));
    assert.equal(errors.length, 0, 'Ошибки браузера: ' + errors.join(' | '));
    assert.equal(res.oct14.profit, 2840276, 'Прибыль Ozon 01–14.10');
    assert.equal(res.oct14.ad, 1242047, 'Расходы на рекламу Ozon 01–14.10');
    assert.equal(res.mpBad, 0, 'Нарушена формула удержаний Ozon');
    assert.ok(res.feeChain === 0, 'Расходы за окно отчётов расходятся с XWAY и списаниями');
    assert.equal(res.feeOutside, 0, 'Фактическое списание за пределами окна отчётов');
  });
}

module.exports = { checkOzon };
if (require.main === module) {
  if (!process.env.VERIFY_CODE) { console.error('Не задан VERIFY_CODE.'); process.exit(2); }
  checkOzon(process.env.URL || 'http://127.0.0.1:8765/index.html').catch(e => { console.error(e.message); process.exitCode = 1; });
}
