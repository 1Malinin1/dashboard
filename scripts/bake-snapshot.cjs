// Собирает decrypted/wb-reports.js заново: старый снимок (BAKED_FINANCE/BAKED_ADS)
// как базовый слой + накопленные построчные записи (acc-finance.json/acc-ads.json)
// поверх. Даты из накопителя ПОЛНОСТЬЮ заменяют те же даты старого снимка (без
// задвоения); даты, которых в накопителе нет, остаются из старого снимка —
// поэтому недели складываются, а не затираются (та же логика, что в
// fdbRefreshFinanceCache() на сайте при смешивании снимка с загрузками).
//
// Перед запуском: node scripts/decrypt.cjs <код>  (иначе wb-reports.js не найдётся)
// Использование: node scripts/bake-snapshot.cjs "29.06.2026 – 12.07.2026"
//   (аргумент — новая подпись периода для BAKED_PERIOD; если не передать,
//   старая подпись останется — не забудьте передать!)
// После: сверьте выведенные контрольные суммы с личным кабинетом WB, затем
// node scripts/encrypt.cjs <код> и закоммитьте wb-secure.js.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { aggregateFinanceRows, aggregateAdRows, controlTotals } = require('./lib/parse-wb.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');
const newPeriod = process.argv[2];

const ctx = {}; vm.createContext(ctx);
// BAKED_FUNNEL держим отдельно и переносим КАК ЕСТЬ: воронку печёт bake-funnel.cjs,
// этот скрипт её не трогает. Без переноса пересборка wb-reports.js молча стирала
// воронку (и ломала вкладку «Товар») — этот скрипт старше, чем воронка.
vm.runInContext(fs.readFileSync(path.join(OUT, 'wb-reports.js'), 'utf8')
  + '\nglobalThis.__O = {BAKED_FINANCE, BAKED_ADS, BAKED_FINANCE_ROWS, BAKED_ADS_ROWS, BAKED_PERIOD,'
  + ' BAKED_FUNNEL: (typeof BAKED_FUNNEL!=="undefined"? BAKED_FUNNEL : []),'
  + ' BAKED_FUNNEL_ROWS: (typeof BAKED_FUNNEL_ROWS!=="undefined"? BAKED_FUNNEL_ROWS : 0)};', ctx);
const old = ctx.__O;

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } }
const finRaw = Object.values(load(path.join(OUT, 'acc-finance.json')));
const adsRaw = Object.values(load(path.join(OUT, 'acc-ads.json')));
if (!finRaw.length && !adsRaw.length) {
  console.error('Накопитель пуст (acc-finance.json/acc-ads.json) — сначала прогоните scripts/ingest-finance.cjs на файлах недели.');
  process.exit(1);
}

const weekFin = aggregateFinanceRows(finRaw);
const weekAds = aggregateAdRows(adsRaw);
const wDates = [...new Set(weekFin.map(r => r.date))].sort();
console.log('НОВЫЕ ДАННЫЕ:', JSON.stringify(controlTotals(weekFin)),
  '| реклама', Math.round(weekAds.reduce((a, r) => a + r.spend, 0)),
  '| дней', wDates.length, wDates.length ? `(${wDates[0]}…${wDates[wDates.length - 1]})` : '');
console.log('  ⚠ Сверьте это с личным кабинетом WB за тот же период ПЕРЕД тем, как продолжить.');

const wDateSet = new Set(weekFin.map(r => r.date));
const wAdDateSet = new Set(weekAds.map(r => r.date));
const mergedFin = old.BAKED_FINANCE.filter(r => !wDateSet.has(r.date)).concat(weekFin).sort((a, b) => a.date < b.date ? -1 : 1);
const mergedAds = old.BAKED_ADS.filter(r => !wAdDateSet.has(r.date)).concat(weekAds).sort((a, b) => a.date < b.date ? -1 : 1);
console.log('СНИМОК ИТОГО:', JSON.stringify(controlTotals(mergedFin)), '| реклама', Math.round(mergedAds.reduce((a, r) => a + r.spend, 0)));

const finRows = old.BAKED_FINANCE_ROWS + finRaw.length;
const adsRows = old.BAKED_ADS_ROWS + adsRaw.length;
const period = newPeriod || old.BAKED_PERIOD;
if (!newPeriod) console.log('  ⚠ Подпись периода НЕ передана аргументом — оставляю старую:', period, '(вероятно, нужно передать новую!)');
const at = new Date().toISOString().slice(0, 10);

const js = '// Зашитый снимок отчётов (финансы + реклама + воронка) по нашим артикулам.\n'
  + '// Собран автоматически из выгрузок WB. Показывается на «Главной»/«Финансах» как базовый слой.\n'
  + 'const BAKED_AT="' + at + '", BAKED_PERIOD="' + period + '";\n'
  + 'const BAKED_FINANCE_ROWS=' + finRows + ', BAKED_ADS_ROWS=' + adsRows + ', BAKED_FUNNEL_ROWS=' + old.BAKED_FUNNEL_ROWS + ';\n'
  + 'const BAKED_FINANCE=' + JSON.stringify(mergedFin) + ';\n'
  + 'const BAKED_ADS=' + JSON.stringify(mergedAds) + ';\n'
  + 'const BAKED_FUNNEL=' + JSON.stringify(old.BAKED_FUNNEL) + ';\n';
fs.writeFileSync(path.join(OUT, 'wb-reports.js'), js);
console.log('\ndecrypted/wb-reports.js пересобран:', (js.length / 1024 | 0), 'KB · finance агрегатов', mergedFin.length,
  '· ads агрегатов', mergedAds.length, '· строк воронки', old.BAKED_FUNNEL.length, '(перенесены без изменений) · период', period);
console.log('Далее: node scripts/encrypt.cjs <код>, затем git add wb-secure.js && git commit && git push.');
