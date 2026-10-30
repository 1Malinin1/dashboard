// Финансы Озона: сколько остаётся после расходов площадки и себестоимости.
// Пишет REAL_DATA.ozon.meta.terms (тариф) и печатает P&L по неделям/периоду.
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. До 04.09.2026 прибыль Озона не считалась вообще: «Главная»/«Финансы»/«Аналитика» —
// только Wildberries. Не хватало одного — сколько площадка забирает себе. Продавец прислал
// свои индивидуальные условия («Сравнение условий», Ozon, ИУ 2026) и подтвердил: колонка
// «Новое ИУ 2026» — это его траты, которые забирает Озон.
// Вторая колонка той же таблицы («Базовая оферта») К ПРОДАВЦУ НЕ ОТНОСИТСЯ — он работает по ИУ.
// Не считай по ней и не приводи её в ответах, даже для сравнения.
//
// ТАРИФ (ИУ 2026), % от выручки — ФИКСИРОВАННАЯ ЧАСТЬ 32,7%:
//   эквайринг 1,3 · комиссия категории 30 · логистика 0 · возвраты 0 · кроссдокинг 0 ·
//   платное размещение 0 · подписка Premium и прочее 1,4
// ПЛЮС РЕКЛАМА — НЕ ФИКСИРОВАННАЯ, А ИЗ ОТЧЁТА «ЮНИТ-ЭКОНОМИКА» (17.09.2026).
// Раньше стояли жёсткие 10% (в таблице ИУ было 8%, продавец просил 10%), итого 42,7%.
// Первый же финотчёт Ozon показал, что это завышено: август дал 4,23%, и вместе с Premium
// модель занижала прибыль августа на 1 528 870 ₽ (25,6%). Решение продавца 17.09.2026:
// «то что шло и будет идти в отчетах то и считаешь» — ставка берётся из отчёта за период
// (scripts/ozon-unit-report.cjs → ozon.meta.unitReports[]), см. adRateFor() ниже.
// Premium 1,4% в отчёте не выделяется ни строкой; продавец: «вот ее нужно считать
// по умолчанию, там ее не будет» — поэтому она в фиксированной части ВСЕГДА.
//
// ТОТ ЖЕ ОТЧЁТ ЗАКРЫЛ СПОР О БАЗЕ ВЫРУЧКИ (август, наши товары): засчитано продавцу
// 3 208 ₽/шт против нашего потолка 3 300 ₽/шт = 97,2%, а «Выручка» (что заплатил
// покупатель) — 2 384 ₽/шт = 72,3%. Соинвест приходит продавцу ОТДЕЛЬНОЙ СТРОКОЙ
// «Баллы за скидки» (+7 251 808 ₽). Значит база «Предельная цена» верна и revBase
// остаётся выключенным. Комиссия в отчёте 30,02% при 30% в ИУ, эквайринг 1,30% при 1,3% —
// тариф подтверждён построчно.
//
// СОИНВЕСТ 22% НЕ ВЫЧИТАЕТСЯ — И ЭТО ОКОНЧАТЕЛЬНО (продавец 04.09.2026). В таблице есть строка
// «Соинвест 22%» и «Net тариф … New ИУ 18,7%» (= 40,7 − 22), но это НЕ скидка продавцу:
// «соинвест значит, что для клиента просто будет дешевле, по факту все расчёты идут с той цены,
// по которой я продаю, а Озон даёт соинвест за свой счёт». То есть покупателю Озон срезает цену
// из своего кармана, выручка продавца при этом не меняется. Вычесть 22% из расходов = раздуть
// прибыль на десятки миллионов из воздуха. Поле хранится справочно, применять не надо.

// ПЕРИОДЫ У ПЛОЩАДОК РАЗНЫЕ (правило продавца 04.09.2026):
//   Ozon — КАЛЕНДАРНЫЕ месяцы: август это 01.08–31.08;
//   ВБ   — месяц по неделям ВБ: август это 03.08–30.08 (см. wbMonthOfWeek в index.html).
// Поэтому здесь месяц календарный, и складывать месячные итоги двух площадок «в лоб» нельзя —
// они про разные отрезки. Для сводных цифр по бизнесу берите одинаковый диапазон дат явно.
//
// БАЗА — ВЫРУЧКА В ВЫКУПЕ. Заказано ₽ × % выкупа, как в model-finance.cjs у ВБ. Брать
// «выкуплено ₽» из orderSeries.money напрямую нельзя: у свежих дней доставка не дозрела
// (товар ещё едет), и выручка вышла бы заниженной тем сильнее, чем свежее день.
//
// Использование:
//   node scripts/ozon-finance.cjs                       — посчитать и показать
//   node scripts/ozon-finance.cjs --ads 10              — задать ставку рекламы вручную, %
//                                                         (перекрывает отчёты — только для прикидок)
//   node scripts/ozon-finance.cjs --from 2026-08-01 --to 2026-08-31
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');

const argv=process.argv.slice(2);
const arg=n=>{ const i=argv.indexOf('--'+n); return i>=0? argv[i+1] : null; };

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, O=RD.ozon;
if(!O) throw new Error('в снимке нет блока Озона');
O.meta=O.meta||{};

// тариф ИУ 2026; ставка рекламы отдельно — её продавец меняет
const adPct = arg('ads')!=null ? parseFloat(arg('ads'))
  : (O.meta.terms && O.meta.terms.ads!=null ? O.meta.terms.ads : 10);
const T={ acquiring:1.3, commission:30, logistics:0, returns:0, crossdock:0,
  placement:0, other:1.4, ads:adPct,
  source:'Ozon, ИУ 2026 («Сравнение условий», колонка «Новое ИУ 2026»)',
  adsNote:'ставка рекламы берётся ИЗ ОТЧЁТА юнит-экономики за период (решение продавца 17.09.2026); '
    +'это значение — запасное, для дат без отчёта',
  coinvest:22, coinvestApplied:false,
  coinvestNote:'строка «Net тариф … New ИУ 18,7%» = 40,7 − 22; продавец указал на 40,7% как на свои траты, соинвест не подтверждал — не вычитаем' };
T.total=+(T.acquiring+T.commission+T.logistics+T.returns+T.crossdock+T.placement+T.other+T.ads).toFixed(2);
O.meta.terms=T;

/* ВЕСЬ РАСЧЁТ ПРИБЫЛИ — calc/ozon-fin.js (с 30.10.2026): тот же файл подключает index.html, поэтому сайт и этот
   скрипт не могут разойтись. Раньше здесь жила вторая копия правил (adRateFor/boFor/costAt/adFact/calc)
   с пометками «ДЕРЖИ СИНХРОННО». Ниже — только то, что нужно для печати шапки, и сложение готовых строк.
   Правила (кратко): реклама до 01.10 — ставка зрелых отчётов «Юнит-экономика», с 01.10 — только факт «Оплаты
   за заказ» (РЕК-23); XWAY перекрывает ставку потоварно; % выкупа — по дате замера; себестоимость — каталог ВБ. */
const OzFin=require(path.join(__dirname,'..','calc','ozon-fin.js'));
const adForced = arg('ads')!=null;
const FEE_ONLY_FROM=OzFin.FEE_REPORT_ONLY_FROM;
// revBase (сейчас выключен) применяется к КОПИИ: этот скрипт записывает wb-data.js обратно, и пересчитанные
// суммы или флаг moneyRebased не должны попасть в снимок
const RDc = OzFin.revBase(RD)? JSON.parse(JSON.stringify(RD)) : RD;
if(RDc!==RD) OzFin.applyRevBase(RDc);
const C=OzFin.create(RDc, {forceAdRate: adForced? T.ads : null});
const FIXED=C.fixedRate, UR=C.unitReports, AP=C.parts, OFE=C.orderFee, BOH=C.buyoutHist;
const bo=O.meta.buyoutAll!=null? O.meta.buyoutAll : 1;   // справочно: для шапки, когда замеров нет
const S=O.orderSeries, dates=S.dates||[];
const from=arg('from')||dates[0], to=arg('to')||dates[dates.length-1];
const RBall=(O.meta.revBase&&Array.isArray(O.meta.revBase.history))? O.meta.revBase.history : [];
const RB=OzFin.revBase(RD)? RBall : [];

// свод за набор дат — сумма тех же подённых строк, что рисует сайт
function calc(ds){
  const a=C.aggregate(ds);
  return {ordRub:a.ordRub, ordQty:a.ordQty, rev:a.revenue, sold:a.qty, cogs:a.cogs, mp:a.mpFee, ads:a.ad, noCost:a.noCostQty,
    takePct: a.revenue? a.mpFee/a.revenue*100 : 0, profit:a.profit, margin:a.margin};
}
const f=n=>Math.round(n).toLocaleString('ru-RU');
const inRange=dates.filter(d=>d>=from&&d<=to);

console.log('ТАРИФ OZON (ИУ 2026), % от выручки в выкупе:');
[['эквайринг',T.acquiring],['комиссия категории',T.commission],['логистика',T.logistics],
 ['возвраты',T.returns],['кроссдокинг',T.crossdock],['платное размещение',T.placement],
 ['подписка Premium и прочее',T.other],['реклама',T.ads]]
 .forEach(([k,v])=>console.log('   '+k.padEnd(28)+String(v).padStart(6)+'%'));
console.log('   '+'фиксированная часть'.padEnd(28)+String(FIXED).padStart(6)+'%   (в т.ч. Premium и прочее '+T.other+'% — в отчёте Ozon её нет, считаем всегда)');
if(UR.length && !adForced){
  console.log('   реклама — ИЗ ОТЧЁТА юнит-экономики, по дате дня:');
  UR.forEach(r=>console.log('      '+r.from+'…'+r.to+' → '+r.adsRate.toFixed(2).replace('.',',')+'%   '+(r.src==='manual'
    ? '(ручная ставка'+(r.perOrderRate? ': '+String(r.perOrderRate).replace('.',',')+'% от заказа' : '')+' — не отчёт)'
    : '(засчитано '+Math.round(r.gross).toLocaleString('ru-RU')+' ₽, реклама '+Math.round(r.ads).toLocaleString('ru-RU')+' ₽)')));
  console.log('      дни после последнего отчёта считаются по нему же; дни раньше первого — по первому');
  console.log('      с '+FEE_ONLY_FROM+' ставки нет: плата за заказ — только отчёт «Оплата за заказ», день без отчёта — 0 (РЕК-23)');
}else{
  console.log('   '+'реклама (нет отчётов)'.padEnd(28)+String(T.ads).padStart(6)+'%'+(adForced?'   ← задана вручную --ads':''));
}
if(AP.length){
  console.log('   реклама ПО ФАКТУ (выгрузки XWAY) — перекрывает ставку только у этих товаров и дат:');
  AP.forEach(p=>{ const sk=Object.keys(p.bySup||{}).length;
    const sp=Object.values(p.bySup||{}).reduce((a,b)=>a+b,0);
    console.log('      '+p.from+'…'+p.to+' → товаров '+String(sk).padStart(3)+' · расход '
      +Math.round(sp).toLocaleString('ru-RU').padStart(10)+' ₽'+(p.src? '   ('+p.src+')':'')); });
  console.log('      остальные товары в эти дни считаются по ставке из отчёта юнит-экономики');
}else if(O.meta.adSpend){
  console.log('   (фактических выгрузок рекламы нет — вся площадка по ставке)');
}
if(OFE && OFE.periods.length){
  const t=OFE.periods.reduce((a,p)=>a+(p.total||0),0);
  console.log('   оплата за заказ ПО ФАКТУ (отчёт Ozon «Оплата за заказ (все товары)») — в эти дни вместо ставки:');
  console.log('      '+OFE.periods[0].from+'…'+OFE.periods[OFE.periods.length-1].to+' → '+OFE.periods.length
    +' дн. · списано '+Math.round(t).toLocaleString('ru-RU')+' ₽; реклама дня = выгрузка XWAY + это списание');
}
console.log('   (соинвест '+T.coinvest+'% не вычитается — см. комментарий в скрипте)');
if(BOH){ console.log('   % выкупа Озона — «доставлено ÷ (доставлено+отменено)», по истории замеров:');
  BOH.forEach(h=>console.log('      замер '+(h.builtAt||'').slice(0,10)+' (окно '+h.from+'…'+h.to+') → '
    +(h.all*100).toFixed(1)+'%  действует с этого дня и вперёд'));
  console.log('      дни раньше первого замера считаются по нему же'); }
else console.log('   % выкупа Озона: '+(bo*100).toFixed(1)+'%  (старая формула «не отменён ÷ все заказы»;'
  +' замеров нет — сделайте node scripts/ozon-buyout-window.cjs <отчёт за период.xlsx>)');
console.log('   себестоимость: общая с ВБ, по дате строки');
if(RB.length) RB.forEach(h=>console.log('   база выручки: с '+h.from+' — '+(h.k*100).toFixed(2)
  +'% от «Предельной цены» (новая методика Ozon); до этой даты — 100%'));
else console.log('   база выручки: «Предельная цена» на всей истории'
  +(RBall.length? '   (замер '+(RBall[RBall.length-1].k*100).toFixed(2)+'% есть, но НЕ применяется —'
    +' ждём финотчёт Ozon; включить: node scripts/ozon-revbase.cjs on)' : ''));

const A=calc(inRange);
console.log('\nOZON · '+from+' … '+to+' ('+inRange.length+' дн.)');
console.log('  заказано:            '+f(A.ordRub).padStart(14)+' ₽ · '+f(A.ordQty)+' шт');
console.log('  выручка (в выкупе):  '+f(A.rev).padStart(14)+' ₽ · '+f(A.sold)+' шт');
console.log('  − забирает Озон '+A.takePct.toFixed(1)+'%: '+f(A.mp).padStart(14)+' ₽   (в т.ч. реклама '+f(A.ads)+' ₽)');
console.log('  − себестоимость:     '+f(A.cogs).padStart(14)+' ₽');
console.log('  ──────────────────────────────────────');
console.log('  ПРИБЫЛЬ:             '+f(A.profit).padStart(14)+' ₽   маржа '+(A.margin*100).toFixed(1)+'%');
if(A.noCost) console.log('  ВНИМАНИЕ: у части товаров нет себестоимости — '+f(A.noCost)+' шт заказов посчитаны без неё, прибыль по ним завышена');

// по КАЛЕНДАРНЫМ месяцам — так продавец считает юнитку по Озону
const mkey=d=>d.slice(0,7);
const mo={}; inRange.forEach(d=>(mo[mkey(d)]||(mo[mkey(d)]=[])).push(d));
console.log('\nПО КАЛЕНДАРНЫМ МЕСЯЦАМ (у Озона месяц календарный, у ВБ — по неделям):');
console.log('  месяц      дн   выручка ₽    забирает Озон   себестоим.     прибыль   маржа');
Object.keys(mo).sort().reverse().forEach(k=>{
  const r=calc(mo[k]), full=mo[k].length;
  console.log('  '+k+String(full).padStart(6)+f(r.rev).padStart(12)+f(r.mp).padStart(16)
    +f(r.cogs).padStart(13)+f(r.profit).padStart(12)+(r.margin*100).toFixed(1).padStart(7)+'%'
    +(full<28? '   (неполный)':''));
});

// по неделям (пн–вс), как на «Главной» у ВБ
const mon=d=>{ const t=new Date(d+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()-((t.getUTCDay()+6)%7)); return t.toISOString().slice(0,10); };
const wk={}; inRange.forEach(d=>(wk[mon(d)]||(wk[mon(d)]=[])).push(d));
console.log('\nПО НЕДЕЛЯМ (пн–вс):');
console.log('  неделя                дн   выручка ₽    забирает Озон   себестоим.     прибыль   маржа');
Object.keys(wk).sort().reverse().slice(0,8).forEach(k=>{
  const r=calc(wk[k]);
  console.log('  '+k+' … '+wk[k][wk[k].length-1].slice(5)+String(wk[k].length).padStart(4)
    +f(r.rev).padStart(12)+f(r.mp).padStart(16)+f(r.cogs).padStart(13)+f(r.profit).padStart(12)
    +(r.margin*100).toFixed(1).padStart(7)+'%');
});

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nТариф записан в ozon.meta.terms. Дальше: node scripts/encrypt.cjs <код>');
