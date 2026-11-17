// СЛЕЖЕНИЕ ЗА ИЗМЕНЕНИЕМ ЦЕН (ЦЕНА-11/ЦЕНА-13, 17.11.2026) — «до» против «после» по данным снимка.
//
// ЗАЧЕМ. 17.11.2026 в репрайсер загружены новые цены: минимальная ВБ поднята до скидки 70% (+9,6% в среднем у 82 карточек),
// у 15 — цена до скидки, у 21 — базовая; Ozon — цена до скидки у 17. Продавец: «следи… важно не ошибиться, т.к. поплывёт вся
// экономика». Запись «было/стало» по каждому коду — `meta.priceChanges[дата]` (её делает repricer-prices.cjs --record).
//
// Что печатает (каждый день после заливки, пока идёт слежение):
//   ВБ:   1) легли ли цены — средняя цена продажи «после» против новой минимальной (допуск 3%: заказы по цене WB Клуба);
//         2) заказы «до/после» — всего и по товарам, с z (Пуассон); 3) экономика ПО ДНЮ ЗАКАЗА с одинаковыми константами
//         («к оплате» и % выкупа — как до изменения), чтобы сравнение было про цену, а не про модель; 4) что сделает
//         репрайсер завтра по плану заказов; 5) особые коды (опущенный коридор, запрет отправки, без стратегии).
//   Ozon: цена Ozon за ВБ (следует ли), упор в свою базовую, заказы и прибыль по дню заказа (как на дашборде).
//   node scripts/price-watch.cjs [--date 2026-11-17] [--before 7]
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = {}; vm.createContext(ctx);
const D = path.join(__dirname, '..', 'decrypted');
vm.runInContext(fs.readFileSync(path.join(D, 'wb-data.js'), 'utf8') + '\nglobalThis.__RD=REAL_DATA;', ctx);
try { vm.runInContext(fs.readFileSync(path.join(D, 'wb-reports.js'), 'utf8').replace(/\bconst\s+/g, 'var '), ctx); } catch (e) {}
const RD = ctx.__RD, MF = ctx.MODELED_FINANCE || [];
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PC = (RD.meta && RD.meta.priceChanges) || {};
const DATE = arg('--date', Object.keys(PC).sort().pop());
const REC = PC[DATE]; if (!REC) { console.error('нет записи meta.priceChanges[' + DATE + '] — сначала repricer-prices.cjs --record'); process.exit(1); }
const NB = +arg('--before', 7);
const addD = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const F = n => Math.round(n).toLocaleString('ru-RU'), P = (n, d = 1) => (n * 100).toFixed(d).replace('.', ',') + '%';
const sgn = n => (n > 0 ? '+' : '') + P(n);
const zRate = (a, na, b, nb) => { const ra = a / na, rb = b / nb, se = Math.sqrt(ra / na + rb / nb); return se ? (rb - ra) / se : 0; };
const bFrom = addD(DATE, -NB), bTo = addD(DATE, -1), aFrom = addD(DATE, 1);
console.log('СЛЕЖЕНИЕ ЗА ЦЕНАМИ от ' + DATE.split('-').reverse().join('.') + ' · «до» ' + bFrom + '…' + bTo + ' (' + NB + ' дн) · ' + DATE + ' — переходный день · «после» с ' + aFrom);

// ───────────────── ВБ ─────────────────
const S = RD.orderSeries, sd = S.dates;
const wbRec = (REC.wb && REC.wb.byCode) || {};
const bySup = {}; RD.catalog.forEach(c => { const s = String(c.supplierCode || '').trim(); if (s && wbRec[s]) bySup[s] = c; });
const idx = (from, to) => sd.map((d, i) => [d, i]).filter(([d]) => d >= from && d <= to).map(x => x[1]);
const IB = idx(bFrom, bTo), IA = idx(aFrom, '9999-12-31'), IT = idx(DATE, DATE);
const H = ['logistics', 'penalty', 'storage', 'reimb', 'deduction', 'priyomka', 'loyalty', 'loyaltyPts'];
// константы экономики — как ДО изменения (28 дн до даты): доля «к оплате» по кабинету; % выкупа ВБ — последний замер
let mr = 0, mn = 0; MF.forEach(x => { if (x.date >= addD(DATE, -28) && x.date < DATE) { mr += x.revenue || 0; mn += (x.payout || 0) - H.reduce((a, k) => a + (x[k] || 0), 0); } });
const KPAY = mr ? mn / mr : 0.585;
const bw = RD.meta && RD.meta.buyoutWin && RD.meta.buyoutWin.history; const BUY = (bw && bw.length) ? (bw[bw.length - 1].all || bw[bw.length - 1].pct || 0.837) : 0.837;
const adDay = {}; (RD.adPerf && RD.adPerf.parts || []).forEach(p => { if (p.from === p.to) adDay[p.from] = Object.values(p.bySku).reduce((a, v) => a + (v.spend || 0), 0); });
function wbWin(I) { let q = 0, rub = 0, cogs = 0, ads = 0; const per = {};
  I.forEach(i => { const d = sd[i]; ads += adDay[d] || 0;
    Object.entries(bySup).forEach(([s, c]) => { const k = (S.bySku[c.sku] || [])[i] || 0; const m = ((S.money[d] || {})[c.sku] || [0])[0] || 0;
      const o = per[s] || (per[s] = { q: 0, rub: 0 }); o.q += k; o.rub += m; q += k; rub += m; cogs += k * (c.costPrice || 0); }); });
  const rev = rub * BUY, gross = rev * KPAY - cogs * BUY;
  return { n: I.length, q, rub, rev, gross, ads, profit: gross - ads, per }; }
const B = wbWin(IB), A = wbWin(IA), T = wbWin(IT);
console.log('\n═══ ВБ ═══ (экономика по дню заказа: «к оплате» ' + P(KPAY) + ', выкуп ' + P(BUY) + ' — одинаковые до и после; себестоимость — каталог)');
const line = (lab, w) => w.n ? console.log('  ' + lab.padEnd(10) + ' заказов ' + (w.q / w.n).toFixed(0) + '/дн · ' + F(w.rub / w.n) + ' ₽/дн · средняя цена ' + F(w.q ? w.rub / w.q : 0)
  + ' · маржа до рекламы ' + P(w.rev ? w.gross / w.rev : 0) + ' · реклама ' + F(w.ads / w.n) + ' ₽/дн · МАРЖА ' + P(w.rev ? w.profit / w.rev : 0) + ' · прибыль ' + F(w.profit / w.n) + ' ₽/дн') : console.log('  ' + lab.padEnd(10) + ' данных нет');
line('до', B); line(DATE.slice(5).split('-').reverse().join('.') + ' (перех.)', T); line('после', A);
if (!A.n) console.log('  → данных «после» ещё нет: первый полный день — ' + aFrom + ' (придёт ' + addD(aFrom, 1) + ').');
else {
  const z = zRate(B.q, B.n, A.q, A.n);
  console.log('  ИТОГ: заказы ' + sgn(A.q / A.n / (B.q / B.n) - 1) + ' (z=' + z.toFixed(2) + (Math.abs(z) >= 1.96 ? ', настоящее' : ', шум') + ') · цена ' + sgn((A.rub / A.q) / (B.rub / B.q) - 1)
    + ' · прибыль ' + sgn((A.profit / A.n) / (B.profit / B.n) - 1) + ' (' + F(A.profit / A.n - B.profit / B.n) + ' ₽/дн) · маржа ' + P(B.profit / B.rev) + ' → ' + P(A.profit / A.rev) + ' (цель 20%)');
  // 1) легли ли цены
  const chk = Object.entries(wbRec).map(([s, r]) => { const a = A.per[s], b = B.per[s]; if (!a || !a.q) return null;
    const pa = a.rub / a.q, pb = b && b.q ? b.rub / b.q : null; return { s, r, pa, pb, qa: a.q, qb: b ? b.q : 0 }; }).filter(Boolean);
  const below = chk.filter(x => x.pa < 0.97 * x.r.new.MinPrice), above = chk.filter(x => x.pa > 1.01 * x.r.new.MaxPrice);
  console.log('  ЛЕГЛИ ЛИ ЦЕНЫ: продажи «после» у ' + chk.length + ' кодов · ниже новой минимальной (−3% допуск) — ' + below.length + ' · выше базовой — ' + above.length);
  below.sort((a, b) => b.qa - a.qa).slice(0, 12).forEach(x => console.log('     ⚠ ' + x.s + ': цена после ' + F(x.pa) + ' при минимальной ' + F(x.r.new.MinPrice) + ' (до было ' + (x.pb ? F(x.pb) : '—') + ')'
    + (x.r.disabled ? ' · ОТПРАВКА ЦЕН ЗАПРЕЩЕНА' : '') + (x.r.strategy === '0' ? ' · без стратегии' : '')));
  above.slice(0, 6).forEach(x => console.log('     ⚠ ' + x.s + ': цена после ' + F(x.pa) + ' выше базовой ' + F(x.r.new.MaxPrice)));
  // 2) заказы по товарам: цена ↑ и заказы ↓ — по z
  const both = chk.filter(x => x.qb > 0).map(x => ({ ...x, dp: x.pa / x.pb - 1, dq: (x.qa / A.n) / (x.qb / B.n) - 1, z: zRate(x.qb, B.n, x.qa, A.n) }));
  const drop = both.filter(x => x.z <= -1.96).sort((a, b) => a.z - b.z);
  console.log('  ЗАКАЗЫ ПО ТОВАРАМ (' + both.length + ' кодов с продажами до и после): значимо упали ' + drop.length + ', значимо выросли ' + both.filter(x => x.z >= 1.96).length);
  drop.slice(0, 12).forEach(x => console.log('     ↓ ' + x.s + ': заказы ' + (x.qb / B.n).toFixed(1) + ' → ' + (x.qa / A.n).toFixed(1) + '/дн (' + sgn(x.dq) + ', z=' + x.z.toFixed(1) + ') при цене ' + sgn(x.dp)));
  const big = both.filter(x => x.dp > 0.12).sort((a, b) => b.qb - a.qb).slice(0, 8);
  if (big.length) console.log('  САМЫЙ БОЛЬШОЙ ПОДЪЁМ ЦЕНЫ (>12%):'), big.forEach(x => console.log('     ' + x.s + ': цена ' + sgn(x.dp) + ' · заказы ' + (x.qb / B.n).toFixed(1) + ' → ' + (x.qa / A.n).toFixed(1) + '/дн (z=' + x.z.toFixed(1) + ')'));
  // 4) репрайсер завтра: последний день против плана
  const last = IA[IA.length - 1], dl = sd[last]; let dn = 0, hold = 0, up = 0; const dnL = [];
  Object.entries(bySup).forEach(([s, c]) => { const r = wbRec[s]; if (!r.plan || r.disabled) return; const y = (S.bySku[c.sku] || [])[last] || 0; const f = y / r.plan;
    if (f < 0.75) { dn++; dnL.push(s); } else if (f > 1.25) up++; else hold++; });
  console.log('  РЕПРАЙСЕР по ' + dl + ' (заказы ÷ план): ниже 75% плана → −1% у ' + dn + ' · 75–125% → держит у ' + hold + ' · выше 125% → +1% у ' + up + ' (правило 2–3 дней не учтено)');
}
// особые: опущенный коридор; запрет отправки — только если товар продаётся или лежит на ВБ (старые «на вывод» без остатка не шумят); без стратегии
const live = s => (B.per[s] && B.per[s].q > 0) || ((bySup[s] || {}).wbStock > 0);
const SPECIAL = Object.entries(wbRec).filter(([s, r]) => r.new.MinPrice < (r.old.MinPrice || 0) - 0.5 || (r.disabled && live(s)) || r.strategy === '0' || r.strategy === '');
console.log('  ОСОБЫЕ КОДЫ ВБ: ' + SPECIAL.map(([s, r]) => s + (r.new.MinPrice < (r.old.MinPrice || 0) - 0.5 ? ' (коридор опущен: мин ' + F(r.old.MinPrice) + '→' + F(r.new.MinPrice) + ')' : '')
  + (r.disabled ? ' (отправка запрещена)' : '') + ((r.strategy === '0' || r.strategy === '') ? ' (без стратегии)' : '') + (A.per[s] && A.per[s].q ? ' · после ' + F(A.per[s].rub / A.per[s].q) + ' ₽, ' + (A.per[s].q / A.n).toFixed(1) + '/дн' : '')).join(' · '));

// ───────────────── Ozon ─────────────────
const OzFin = require('../calc/ozon-fin.js'); const C = OzFin.create(RD); const rows = C.rows();
const ozRec = (REC.oz && REC.oz.byCode) || {};
const O = RD.ozon.orderSeries, od = O.dates;
function ozWin(from, to) { const R = rows.filter(r => r.date >= from && r.date <= to); const n = new Set(R.map(r => r.date)).size; const s = k => R.reduce((a, r) => a + (r[k] || 0), 0);
  return { n, q: s('ordQty'), rub: s('ordRub'), rev: s('revenue'), ad: s('ad'), profit: s('profit') }; }
const OB = ozWin(bFrom, bTo), OT = ozWin(DATE, DATE), OA = ozWin(aFrom, '9999-12-31');
console.log('\n═══ Ozon ═══ (как на дашборде: по дню заказа, % выкупа по дате — с 16.11 он 80,9% вместо 83,7%)');
const oline = (lab, w) => w.n ? console.log('  ' + lab.padEnd(10) + ' заказов ' + (w.q / w.n).toFixed(0) + '/дн · ' + F(w.rub / w.n) + ' ₽/дн · средняя цена ' + F(w.q ? w.rub / w.q : 0) + ' · реклама ' + P(w.rev ? w.ad / w.rev : 0) + ' · МАРЖА ' + P(w.rev ? w.profit / w.rev : 0) + ' · прибыль ' + F(w.profit / w.n) + ' ₽/дн') : console.log('  ' + lab.padEnd(10) + ' данных нет');
oline('до', OB); oline(DATE.slice(5).split('-').reverse().join('.') + ' (перех.)', OT); oline('после', OA);
if (OA.n) { const z = zRate(OB.q, OB.n, OA.q, OA.n);
  console.log('  ИТОГ: заказы ' + sgn(OA.q / OA.n / (OB.q / OB.n) - 1) + ' (z=' + z.toFixed(2) + (Math.abs(z) >= 1.96 ? ', настоящее' : ', шум') + ') · цена ' + sgn((OA.rub / OA.q) / (OB.rub / OB.q) - 1) + ' · прибыль ' + sgn((OA.profit / OA.n) / (OB.profit / OB.n) - 1) + ' (' + F(OA.profit / OA.n - OB.profit / OB.n) + ' ₽/дн)'); }
// следует ли Ozon за ВБ: цена Ozon ÷ цена ВБ по общим кодам, до и после; упор в базовую Ozon
function follow(fromW, toW) { let n = 0, sum = 0; Object.keys(wbRec).forEach(s => { const c = bySup[s]; if (!c) return;
  let wq = 0, wr = 0, oq = 0, orb = 0;
  sd.forEach((d, i) => { if (d < fromW || d > toW) return; wq += (S.bySku[c.sku] || [])[i] || 0; wr += ((S.money[d] || {})[c.sku] || [0])[0] || 0; });
  od.forEach((d, i) => { if (d < fromW || d > toW) return; oq += (O.byArt[s] || [])[i] || 0; orb += ((O.money[d] || {})[s] || [0])[0] || 0; });
  if (wq >= 3 && oq >= 3) { n++; sum += (orb / oq) / (wr / wq); } }); return n ? { n, r: sum / n } : null; }
const fb = follow(bFrom, bTo), fa = OA.n ? follow(aFrom, '9999-12-31') : null;
console.log('  ЦЕНА OZON ÷ ЦЕНА ВБ (средняя по кодам с продажами на обеих): до ' + (fb ? fb.r.toFixed(3) + ' (' + fb.n + ' кодов)' : '—') + ' · после ' + (fa ? fa.r.toFixed(3) + ' (' + fa.n + ' кодов)' : '—'));
// базовая Ozon: новая, если её меняли (17.11 вечер — 60% у всех), иначе как была
const ozBase = r => (r.new && r.new.MaxPrice != null) ? r.new.MaxPrice : r.base;
const cap = Object.entries(ozRec).filter(([s, r]) => ozBase(r) != null && wbRec[s] && ozBase(r) < wbRec[s].new.MaxPrice - 0.5);
console.log('  УПОР В БАЗОВУЮ OZON (ниже новой базовой ВБ — выше неё Ozon за ВБ не пойдёт): ' + cap.length + ' · ' + cap.slice(0, 10).map(([s, r]) => s + ' ' + F(ozBase(r)) + '<' + F(wbRec[s].new.MaxPrice)).join(' · '));
const off = Object.entries(ozRec).filter(([s, r]) => r.reprice !== 1 || r.strategy === '');
if (off.length) console.log('  Ozon: отправка цен не разрешена / нет стратегии: ' + off.map(([s, r]) => s + (r.reprice !== 1 ? '(отправка не разрешена)' : '') + (r.strategy === '' ? '(без стратегии)' : '')).join(' '));
