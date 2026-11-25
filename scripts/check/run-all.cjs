'use strict';
const { withDashboardServer } = require('../lib/dashboard-browser.cjs');
const { withCheckWorkspace } = require('./workspace.cjs');
const { checkTabs } = require('./tabs-smoke.cjs');
const { checkOzon } = require('./ozon-profit.cjs');
const { checkTrucks } = require('./full-trucks.cjs');

async function main() {
  if (!process.env.VERIFY_CODE) {
    console.error('run-all: нет VERIFY_CODE — проверки не запущены');
    process.exitCode = 3;
    return;
  }
  await withCheckWorkspace(dir => withDashboardServer(Number(process.env.PORT || 0), async url => {
    const failed = [];
    for (const [name, run] of [['Вкладки', checkTabs], ['Прибыль Ozon', checkOzon], ['Полные машины', checkTrucks]]) {
      try {
        await run(url, dir);
        console.log('✓ ' + name);
      } catch (error) {
        failed.push(name);
        console.error('✗ ' + name + ': ' + error.message);
      }
    }
    if (failed.length) throw new Error('Не прошли проверки: ' + failed.join(', '));
  }, dir));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
