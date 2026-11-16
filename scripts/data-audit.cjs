// АУДИТ ПОЛНОТЫ ДАННЫХ — ищет МОЛЧАЛИВЫЕ ПРОПАЖИ, которые не дают ни ошибки, ни пустой таблицы (16.11.2026).
//
// ЗАЧЕМ. 16.11.2026 за один заход нашлось три пропажи одного рода — «новинка не считается нашей»:
//   · заказы Ozon-новинок без карточки ВБ отбрасывал загрузчик заказов (20 шт за 09–15.11);
//   · свой склад 1С не брал 27 кодов (15 593 шт, резерв ещё 22 тыс.) — «розничные»;
//   · 28 карточек ВБ из реестра новинок не были заведены в каталог ВБ (519574: 479 шт на складах ВБ не видно).
// Каждую по отдельности видно только перекрёстной сверкой источников. Этот скрипт её и делает —
// запускается сам в конце encrypt.cjs (ничего не меняет, только печатает) и вручную:
//   node scripts/data-audit.cjs [--days 14]
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');

function load(dir) {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'wb-data.js'), 'utf8') + '\nglobalThis.__RD=REAL_DATA;', ctx);
  try { vm.runInContext(fs.readFileSync(path.join(dir, 'wb-reports.js'), 'utf8').replace(/\bconst\s+/g, 'var '), ctx); } catch (e) {}
  return ctx;
}

function audit(ctx, opts) {
  const RD = ctx.__RD, O = RD.ozon || {}, DAYS = (opts && opts.days) || 14;
  const out = [];
  const warn = (title, lines) => { if (lines.length) out.push('⚠ ' + title + (lines.length > 15 ? ' (' + lines.length + ')' : '') + '\n' + lines.slice(0, 15).map(s => '   ' + s).join('\n') + (lines.length > 15 ? '\n   …' : '')); };
  const wbBySup = {}; (RD.catalog || []).forEach(c => { const s = ('' + (c.supplierCode || '')).trim(); if (s) wbBySup[s] = c; });
  const wbSkus = new Set((RD.catalog || []).map(c => '' + c.sku));

  // 1) реестр новинок: карточка ВБ известна, в каталоге ВБ её нет
  const reg = (RD.meta && RD.meta.newCodes && RD.meta.newCodes.items) || [];
  warn('КАРТОЧКА ВБ ЕСТЬ, В КАТАЛОГЕ ВБ НЕТ — заказы, остатки и реклама ВБ по ней не грузятся → node scripts/new-codes.cjs wb-cards --apply',
    reg.filter(x => x.wbSku && !wbSkus.has('' + x.wbSku)).map(x => x.code + ' · ВБ ' + x.wbSku + ' · ' + String(x.name || '').slice(0, 40)));

  // 2) Ozon: воронка видит заказы, ряд заказов — нет (или сильно меньше)
  const S = O.orderSeries;
  if (S && S.dates && S.dates.length) {
    const last = S.dates[S.dates.length - 1], idx = [];
    for (let i = S.dates.length - 1; i >= 0 && idx.length < DAYS; i--) idx.push(i);
    const from = S.dates[idx[idx.length - 1]];
    const ser = {}; Object.entries(S.byArt || {}).forEach(([a, v]) => { ser[a] = idx.reduce((s, i) => s + (v[i] || 0), 0); });
    const fun = {}; (O.funnel || []).forEach(r => { if (r.date >= from && r.date <= last) fun[r.sku] = (fun[r.sku] || 0) + (r.ordersQty || 0); });
    warn('OZON: ВОРОНКА ВИДИТ ЗАКАЗЫ, РЯД ЗАКАЗОВ — НЕТ (' + from + '…' + last + ') — загрузчик заказов их отбросил?',
      Object.entries(fun).filter(([a, f]) => f >= 3 && (ser[a] || 0) < f * 0.3).map(([a, f]) => a + ': воронка ' + f + ' шт, ряд ' + (ser[a] || 0)));
    // дни без данных в последних DAYS днях
    const fee = (O.meta && O.meta.orderFee && O.meta.orderFee.byDate) || {};
    const xwDays = new Set(((O.meta && O.meta.adSpend && O.meta.adSpend.parts) || []).filter(p => p.from === p.to).map(p => p.from));
    const funDays = new Set((O.funnel || []).map(r => r.date));
    const miss = [];
    idx.forEach(i => { const d = S.dates[i]; const m = [];
      const q = Object.values(S.byArt || {}).reduce((s, v) => s + (v[i] || 0), 0); if (!q) m.push('заказы');
      if (!fee[d]) m.push('«Оплата за заказ»'); if (!xwDays.has(d)) m.push('XWAY'); if (!funDays.has(d)) m.push('воронка');
      if (m.length) miss.push(d + ': нет ' + m.join(', ')); });
    warn('OZON: ДНИ БЕЗ ЧАСТИ ДАННЫХ (последние ' + DAYS + ' дн.)', miss);
  }

  // 3) ВБ: воронка видит заказы, ряд заказов — нет
  const W = RD.orderSeries, F = ctx.BAKED_FUNNEL;
  if (W && W.dates && Array.isArray(F)) {
    const n = W.dates.length, idx = []; for (let i = n - 1; i >= 0 && idx.length < DAYS; i--) idx.push(i);
    const from = W.dates[idx[idx.length - 1]], last = W.dates[n - 1];
    const ser = {}; Object.entries(W.bySku || {}).forEach(([s, v]) => { ser[s] = idx.reduce((a, i) => a + (v[i] || 0), 0); });
    const fun = {}; F.forEach(r => { if (r.date >= from && r.date <= last) fun[r.sku] = (fun[r.sku] || 0) + (r.ordersQty || 0); });
    warn('ВБ: ВОРОНКА ВИДИТ ЗАКАЗЫ, РЯД ЗАКАЗОВ — НЕТ (' + from + '…' + last + ')',
      Object.entries(fun).filter(([s, f]) => f >= 3 && (ser[s] || 0) < f * 0.3).map(([s, f]) => s + ': воронка ' + f + ' шт, ряд ' + (ser[s] || 0)));
  }

  // 4) Ozon: свой товар (XWAY/реестр) с остатком или заказами, но кода нет в каталоге Ozon
  const ozCat = new Set((O.catalog || []).map(c => '' + c.sku));
  const sold = new Set(); (O.funnel || []).forEach(r => { if (r.ordersQty) sold.add('' + r.sku); });
  warn('OZON: ПРОДАЁТСЯ (воронка), НО НЕТ В КАТАЛОГЕ OZON — остаток и подсорт по нему не видны',
    [...sold].filter(a => !ozCat.has(a) && (wbBySup[a] || reg.some(x => x.code === a))).map(a => a));

  // 5) себестоимость: продажи за DAYS дн. есть, себестоимости нет
  const costOz = {}; (O.catalog || []).forEach(c => { costOz[c.sku] = 1; });
  const hasCost = a => { const c = wbBySup[a]; if (c && c.costPrice != null) return true;
    const cb = RD.meta && RD.meta.costBySup && RD.meta.costBySup[a]; return !!(cb && cb.cost); };
  if (S && S.dates) {
    const n = S.dates.length; const noCost = [];
    Object.entries(S.byArt || {}).forEach(([a, v]) => { let q = 0; for (let i = Math.max(0, n - DAYS); i < n; i++) q += v[i] || 0;
      if (q > 0 && !hasCost(a)) noCost.push(a + ' (Ozon ' + q + ' шт)'); });
    if (W && W.dates) { const m = W.dates.length; const bySku = {}; (RD.catalog || []).forEach(c => bySku['' + c.sku] = c);
      Object.entries(W.bySku || {}).forEach(([k, v]) => { let q = 0; for (let i = Math.max(0, m - DAYS); i < m; i++) q += v[i] || 0;
        const c = bySku[k]; if (q > 0 && c && c.costPrice == null && !hasCost(('' + (c.supplierCode || '')).trim())) noCost.push((c.supplierCode || k) + ' (ВБ ' + q + ' шт)'); }); }
    warn('НЕТ СЕБЕСТОИМОСТИ при продажах за ' + DAYS + ' дн. — прибыль по ним завышена', noCost);
  }
  return out;
}

module.exports = audit;

if (require.main === module) {
  const days = (() => { const i = process.argv.indexOf('--days'); return i >= 0 ? +process.argv[i + 1] || 14 : 14; })();
  const res = audit(load(path.join(__dirname, '..', 'decrypted')), { days });
  console.log(res.length ? 'АУДИТ ПОЛНОТЫ ДАННЫХ:\n' + res.join('\n') : 'АУДИТ ПОЛНОТЫ ДАННЫХ: пропаж не найдено.');
}
