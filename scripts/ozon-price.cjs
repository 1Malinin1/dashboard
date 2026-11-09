// Предельная цена Ozon «со слов продавца» — для товаров, у которых в ряду заказов меньше 5 продаж за 28 дней
// (ЦЕНА-03: цену из ряда не брать, спрашивать продавца). Хранится в REAL_DATA.meta.ozPriceBySup (верхний meta, не
// ozon.meta — его ozon-build.cjs переписывает целиком). Читает price-check.cjs (а через него ozon-ad-check.cjs):
// пока у товара <5 заказов, берётся эта цена и считается надёжной; набралось 5+ — снова цена последних продаж.
//
//   node scripts/ozon-price.cjs set "519572=1999, 519573=1862"   записать (дата — сегодня)
//   node scripts/ozon-price.cjs list                             что записано
//   node scripts/ozon-price.cjs drop <код>                        убрать
// Дальше: node scripts/encrypt.cjs <код доступа>
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const OUT = path.join(__dirname, '..', 'decrypted');
const [cmd = 'list', ...rest] = process.argv.slice(2);
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT, 'wb-data.js'), 'utf8') + '\nglobalThis.__RD=REAL_DATA;', ctx);
const RD = ctx.__RD; RD.meta = RD.meta || {};
const map = Object.assign({}, RD.meta.ozPriceBySup || {});
const today = new Date().toISOString().slice(0, 10);
const save = () => {
  RD.meta.ozPriceBySup = map;
  fs.writeFileSync(path.join(OUT, 'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    + 'const REAL_DATA = ' + JSON.stringify(RD) + ';\n');
};
if (cmd === 'set') {
  const pairs = rest.join(' ').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).map(s => s.split(/\s*[=:]\s*|\s+-\s+|\s+/));
  let n = 0;
  for (const [code, p] of pairs) {
    const sup = String(code || '').replace(/\D/g, ''), price = Number(String(p || '').replace(/\s/g, '').replace(',', '.'));
    if (!/^\d{6}$/.test(sup) || !(price > 0)) { console.error('пропущено: «' + code + ' ' + p + '» — нужен 6-значный код и цена'); continue; }
    map[sup] = { price, setAt: today, note: 'предельная без акций, со слов продавца' }; n++;
  }
  save(); console.log('Записано цен: ' + n + '. Дальше: node scripts/encrypt.cjs <код>');
} else if (cmd === 'drop') {
  const sup = String(rest[0] || '').trim(); delete map[sup]; save(); console.log('Убрано: ' + sup);
} else {
  const ks = Object.keys(map).sort();
  if (!ks.length) console.log('Цен со слов продавца нет.');
  ks.forEach(k => console.log('  ' + k + '  ' + map[k].price + ' ₽  (' + map[k].setAt + ')'));
}
