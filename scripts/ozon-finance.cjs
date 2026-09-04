// Финансы Озона: сколько остаётся после расходов площадки и себестоимости.
// Пишет REAL_DATA.ozon.meta.terms (тариф) и печатает P&L по неделям/периоду.
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. До 04.09.2026 прибыль Озона не считалась вообще: «Главная»/«Финансы»/«Аналитика» —
// только Wildberries. Не хватало одного — сколько площадка забирает себе. Продавец прислал
// свои индивидуальные условия («Сравнение условий», Ozon, ИУ 2026) и подтвердил: колонка
// «Новое ИУ 2026» — это его траты, которые забирает Озон.
//
// ТАРИФ (ИУ 2026), % от выручки:
//   эквайринг 1,3 · комиссия категории 30 · логистика 0 · возвраты 0 · кроссдокинг 0 ·
//   платное размещение 0 · подписка Premium и прочее 1,4 · реклама 10
//   ИТОГО 42,7%
// Реклама в самой таблице стоит 8%, но продавец попросил считать 10% (03–04.09.2026,
// сначала называл 9%). Поэтому ставка лежит отдельным полем и меняется одной командой.
//
// СОИНВЕСТ 22% НЕ ПРИМЕНЯЕТСЯ. В таблице есть строка «Соинвест (все типы товаров, без крышки)
// 22%» и «Net тариф … New ИУ 18,7%», то есть 40,7 − 22. Продавец указал на колонку 40,7% как
// на свои траты, про соинвест ничего не сказал, а разница между 42,7% и 20,7% — это ДЕСЯТКИ
// МИЛЛИОНОВ на его оборотах. Молча вычитать нельзя: занизим расходы вдвое и раздуем прибыль.
// Хранится справочно (coinvest/coinvestApplied) — включается явно, когда продавец подтвердит.
//
// БАЗА — ВЫРУЧКА В ВЫКУПЕ. Заказано ₽ × % выкупа, как в model-finance.cjs у ВБ. Брать
// «выкуплено ₽» из orderSeries.money напрямую нельзя: у свежих дней доставка не дозрела
// (товар ещё едет), и выручка вышла бы заниженной тем сильнее, чем свежее день.
//
// Использование:
//   node scripts/ozon-finance.cjs                       — посчитать и показать
//   node scripts/ozon-finance.cjs --ads 10              — сменить ставку рекламы, %
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
  adsNote:'в таблице 8%, продавец попросил считать '+adPct+'% (04.09.2026)',
  coinvest:22, coinvestApplied:false,
  coinvestNote:'строка «Net тариф … New ИУ 18,7%» = 40,7 − 22; продавец указал на 40,7% как на свои траты, соинвест не подтверждал — не вычитаем' };
T.total=+(T.acquiring+T.commission+T.logistics+T.returns+T.crossdock+T.placement+T.other+T.ads).toFixed(2);
O.meta.terms=T;

// ---- себестоимость по коду 1С (общая с ВБ; на Озоне артикул = код 1С)
const costHist={}, costNow={};
(RD.catalog||[]).forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(!s) return;
  if(c.costPrice!=null && costNow[s]==null) costNow[s]=c.costPrice;
  if(c.costHistory && c.costHistory.length && !costHist[s]) costHist[s]=c.costHistory; });
function costAt(sup,date){
  const h=costHist[sup];
  if(h){ let v=null; for(const e of h){ if(!e.from || e.from<=date) v=e.cost; } if(v!=null) return v; }
  return costNow[sup]!=null? costNow[sup] : null;
}

const bo=O.meta.buyoutAll!=null? O.meta.buyoutAll : 1;
const S=O.orderSeries, dates=S.dates||[], byArt=S.byArt||{}, money=S.money||{};
const from=arg('from')||dates[0], to=arg('to')||dates[dates.length-1];

function calc(ds){
  let ordRub=0, ordQty=0, cogs=0, noCost=0;
  ds.forEach(d=>{
    const i=dates.indexOf(d); if(i<0) return;
    const m=money[d]||{};
    Object.entries(m).forEach(([a,v])=>ordRub+=v[0]||0);
    Object.entries(byArt).forEach(([a,s])=>{
      const q=s[i]||0; if(!q) return;
      ordQty+=q;
      const c=costAt(a,d);
      if(c!=null) cogs+=q*bo*c; else noCost+=q;
    });
  });
  const rev=ordRub*bo, sold=ordQty*bo;
  const mp=rev*T.total/100, ads=rev*T.ads/100;
  return {ordRub,ordQty,rev,sold,cogs,mp,ads,noCost,
    profit:rev-mp-cogs, margin: rev? (rev-mp-cogs)/rev : 0};
}
const f=n=>Math.round(n).toLocaleString('ru-RU');
const inRange=dates.filter(d=>d>=from&&d<=to);

console.log('ТАРИФ OZON (ИУ 2026), % от выручки в выкупе:');
[['эквайринг',T.acquiring],['комиссия категории',T.commission],['логистика',T.logistics],
 ['возвраты',T.returns],['кроссдокинг',T.crossdock],['платное размещение',T.placement],
 ['подписка Premium и прочее',T.other],['реклама',T.ads]]
 .forEach(([k,v])=>console.log('   '+k.padEnd(28)+String(v).padStart(6)+'%'));
console.log('   '+'ИТОГО забирает Озон'.padEnd(28)+String(T.total).padStart(6)+'%');
console.log('   (соинвест '+T.coinvest+'% не вычитается — см. комментарий в скрипте)');
console.log('   % выкупа Озона: '+(bo*100).toFixed(1)+'%   себестоимость: общая с ВБ, по дате строки');

const A=calc(inRange);
console.log('\nOZON · '+from+' … '+to+' ('+inRange.length+' дн.)');
console.log('  заказано:            '+f(A.ordRub).padStart(14)+' ₽ · '+f(A.ordQty)+' шт');
console.log('  выручка (в выкупе):  '+f(A.rev).padStart(14)+' ₽ · '+f(A.sold)+' шт');
console.log('  − забирает Озон '+T.total+'%: '+f(A.mp).padStart(14)+' ₽   (в т.ч. реклама '+f(A.ads)+' ₽)');
console.log('  − себестоимость:     '+f(A.cogs).padStart(14)+' ₽');
console.log('  ──────────────────────────────────────');
console.log('  ПРИБЫЛЬ:             '+f(A.profit).padStart(14)+' ₽   маржа '+(A.margin*100).toFixed(1)+'%');
if(A.noCost) console.log('  ВНИМАНИЕ: у части товаров нет себестоимости — '+f(A.noCost)+' шт заказов посчитаны без неё, прибыль по ним завышена');

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
