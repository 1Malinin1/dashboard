'use strict';
const assert = require('node:assert/strict');
const { withBrowser, unlockDashboard } = require('../lib/dashboard-browser.cjs');

// Ожидаемые панели заданы независимо от TABS и MP_TABS самого сайта.
const panels = {
  recs: '#recList', home: '#homeKpis .kpi, #homeEmpty', dynamics: '#dynTable td',
  turnover: '#turnTable td', stockrate: '#srTable td', stock: '#stkTable td',
  product: '#prodFreshness', finance: '#finTable td', ads: '#adTable td',
  analytics: '#anTable td, #anEmpty',
};
const platforms = ['wb', 'ozon', 'all'];

async function checkTabs(url) {
  await withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url);
    await unlockDashboard(page, process.env.VERIFY_CODE);
    await page.locator('#recList:not(:empty)').waitFor({ state: 'attached' });
    const hasOzon = await page.evaluate(() => Boolean(RD.ozon && RD.ozon.orderSeries));
    const nav = page.locator('.tab-btn[data-tab]');
    assert.deepEqual((await nav.evaluateAll(bs => bs.map(b => b.dataset.tab))).sort(), Object.keys(panels).sort(), 'Список вкладок');
    let states = 0;
    for (const [tab, selector] of Object.entries(panels)) {
      const button = page.locator('.tab-btn[data-tab="' + tab + '"]');
      await button.click();
      const panel = page.locator('#tab-' + tab);
      assert.ok(await panel.isVisible(), 'Нет активной панели ' + tab);
      assert.equal(await button.getAttribute('aria-selected'), 'true', tab);
      assert.equal(await page.locator('.tab-panel:visible').count(), 1, 'Открыто несколько панелей');
      const hasMarketModes = tab !== 'stock' && tab !== 'finance';
      const switchable = hasOzon && hasMarketModes;
      const mpSwitch = page.locator('#mpSwitch');
      assert.equal(await mpSwitch.isVisible(), switchable, 'Переключатель площадок ' + tab);
      if (switchable) {
        const buttons = await mpSwitch.locator('button[data-mp]:visible').evaluateAll(bs => bs.map(b => b.dataset.mp));
        assert.deepEqual(buttons.sort(), [...platforms].sort(), 'Набор площадок ' + tab);
      }
      for (const mp of switchable ? platforms : [hasMarketModes ? 'wb' : null]) {
        const state = tab + '/' + (mp || 'общий');
        if (switchable) {
          await mpSwitch.locator('[data-mp="' + mp + '"]').click();
          assert.equal(await mpSwitch.locator('.active').getAttribute('data-mp'), mp, state);
          assert.equal(await page.evaluate(() => _appliedMp), mp, state);
        }
        let target = selector, message;
        if (tab === 'home' && mp === 'ozon' && await page.evaluate(() => !ozTerms() || !ozFinRows().length)) {
          target = '#homeFreshness'; message = /не задан тариф Ozon|по Ozon нет заказов/i;
        }
        if (mp === 'all' && tab === 'ads') { target = '#adFreshness'; message = /выберите ВБ или Ozon/i; }
        if (mp === 'all' && tab === 'product') message = /по каждой площадке отдельно/i;
        if (mp === 'all' && tab === 'turnover') message = /по каждой площадке|выберите/i;
        if (mp === 'all' && tab === 'analytics') target = '#anAllCard, #anEmpty';
        if (mp === 'ozon' && tab === 'ads' && !(await panel.locator('#adTable td').count())) {
          target = '#adFreshness'; message = /нет данных о заказах/i;
        }
        if (mp === 'wb' && tab === 'ads' && !(await panel.locator('#adTable td').count())) {
          target = '#adCount'; message = /^0 кандидатов/;
        }
        assert.equal(errors.length, 0, state + ': ' + errors.join(' | '));
        const ready = await panel.locator(target).evaluateAll((els, pattern) => {
          const expected = pattern ? new RegExp(pattern, 'i') : null;
          return els.some(e => e.getClientRects().length && e.innerText.trim() &&
            (!expected || expected.test(e.innerText)));
        }, message?.source);
        assert.ok(ready, 'Нет ожидаемого содержимого ' + state + ' (' + target + ')');
        states++;
        console.log('✓ ' + state);
      }
    }
    assert.equal(states, hasOzon ? 26 : 10);
    assert.equal(errors.length, 0, 'Ошибки браузера: ' + errors.join(' | '));
    console.log('Вкладки: 10, состояний: ' + states + ', ошибок браузера: 0');
  });
}

module.exports = { checkTabs };
if (require.main === module) {
  if (!process.env.VERIFY_CODE) { console.error('Не задан VERIFY_CODE.'); process.exit(2); }
  const url = process.env.URL || 'http://127.0.0.1:' + (process.env.PORT || 8765) + '/index.html';
  checkTabs(url).catch(e => { console.error(e.message); process.exitCode = 1; });
}
