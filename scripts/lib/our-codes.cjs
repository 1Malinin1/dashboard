// ЕДИНЫЙ ПРИЗНАК «НАШ ТОВАР» ДЛЯ ВСЕХ ЗАГРУЗЧИКОВ OZON (16.11.2026).
//
// ЗАЧЕМ. Кабинет Ozon общий: в выгрузках рядом с товарами продавца лежит чужой ассортимент
// (колпаки, ободки — ~500 строк в «По товарам», ~14 тыс. в остатках), поэтому каждый загрузчик
// отсеивает «чужое». Но признак «наше» был у каждого свой, и почти везде — «есть карточка ВБ»
// (`catalog[].supplierCode`). Новинка, которая пока продаётся ТОЛЬКО на Ozon, такой карточки
// не имеет и выпадала МОЛЧА:
//   · 02.11.2026 — остатки трансформеров 519574/519575 неделю не попадали в дашборд (ozon-build);
//   · 16.11.2026 — заказы 519573, 519575, 519400, 519403, 519572, 519574, 519577 не попадали
//     в ряд заказов Ozon (ozon-ingest-orders: фильтр по карточкам ВБ), хотя воронка Ozon и XWAY
//     их видели: 20 заказов за 09–15.11. Проверка рекламы показывала «заказы товара 0».
// Поэтому признак один на все скрипты, а то, что отсеяно, печатается списком — молча не пропадает.
//
// «НАШ» = любое из:
//   1) арт. поставщика карточки ВБ (catalog[].supplierCode);
//   2) код в каталоге Ozon снимка (ozon.catalog[].sku) — его собирает ozon-build из остатков;
//   3) код, уже бывший в ряду заказов Ozon (ozon.orderSeries.byArt);
//   4) код из выгрузок XWAY Ozon продавца (ozon.meta.adSpend.codes — копит ozon-ads-spend.cjs);
//   5) код из реестра новых товаров (meta.newCodes.items[].code — new-codes.cjs).
'use strict';

function S(v) { return v == null ? '' : ('' + v).replace(/\s/g, ''); }

function ourCodes(RD) {
  const src = { wb: new Set(), oz: new Set(), ser: new Set(), xw: new Set(), nc: new Set() };
  ((RD && RD.catalog) || []).forEach(c => { const s = S(c.supplierCode); if (s) src.wb.add(s); });
  const O = (RD && RD.ozon) || {};
  (O.catalog || []).forEach(c => { const s = S(c.sku); if (s) src.oz.add(s); });
  Object.keys((O.orderSeries && O.orderSeries.byArt) || {}).forEach(s => src.ser.add(S(s)));
  ((O.meta && O.meta.adSpend && O.meta.adSpend.codes) || []).forEach(s => { s = S(s); if (s) src.xw.add(s); });
  ((RD && RD.meta && RD.meta.newCodes && RD.meta.newCodes.items) || []).forEach(x => { const s = S(x && x.code); if (s) src.nc.add(s); });
  const all = new Set();
  Object.values(src).forEach(set => set.forEach(s => all.add(s)));
  const skipped = new Map();               // артикул → строк отсеяно
  return {
    all, src,
    has(a) { return all.has(S(a)); },
    // наш ли артикул; если нет — запомнить для отчёта
    take(a) { const s = S(a); if (!s) return false; if (all.has(s)) return true;
      skipped.set(s, (skipped.get(s) || 0) + 1); return false; },
    skipped,
    // печать отсеянного: сколько строк, сколько артикулов и самые частые — чтобы новинку было видно
    report(label, top) {
      if (!skipped.size) return '';
      const n = [...skipped.values()].reduce((a, b) => a + b, 0);
      const list = [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, top || 12)
        .map(([a, k]) => a + '×' + k).join(', ');
      return (label ? label + ': ' : '') + 'отсеяно как чужое ' + n + ' строк, ' + skipped.size + ' артикулов (частые: ' + list
        + (skipped.size > (top || 12) ? ', …' : '') + '). Если среди них ваш новый товар — node scripts/new-codes.cjs add "<код>"';
    },
  };
}

module.exports = ourCodes;
