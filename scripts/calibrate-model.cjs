// Считает и ЗАПОМИНАЕТ в снимке финансовые коэффициенты, снятые с фактических отчётов
// «О реализации» + «История затрат». Пишет REAL_DATA.meta.model.
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Продавцу закрыли доступ к финансовым отчётам (24.08.2026), новых данных не будет.
// Значит эти коэффициенты — единственный мост от того, что ещё выгружается (аналитика:
// заказы, выкупы, средняя цена), к деньгам (к перечислению, удержания, прибыль).
// Их надо снять ОДИН раз с той истории, что есть, и хранить в снимке: пересчитать потом
// будет не из чего.
//
// ЧТО НАДЁЖНО, А ЧТО НЕТ (замер на 29.06–02.08, 5 недель):
//   payoutRate  = «итого к оплате» ÷ выручка = 62.0%, по неделям 61.8–62.6% → ошибка 0.3%.
//                 Это структурная величина (комиссия+логистика+удержания), ей можно верить.
//   avgTicket   = выручка ÷ проданных штук ≈ 1340 ₽, по неделям 1280–1391 (±4%).
//   soldPerOrd  = продано ÷ заказано за ту же неделю = 91.5% ±8.5 п.п. — ЗАВИСИТ ОТ ТРЕНДА:
//                 продажи недели закрываются заказами прошлых недель, поэтому на падении
//                 коэффициент задран, на росте будет занижен. В длинном окне он должен
//                 сходиться к % выкупа (75%). Для месяца годится, для одной недели — нет.
//   adRate      = реклама ÷ выручка = 1.1–8.2% — это НЕ коэффициент, а решение продавца.
//                 Прогноз обязан брать рекламу вводом, а не отсюда.
//
// Использование: node scripts/calibrate-model.cjs
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\n'
  +fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__O={REAL_DATA,BAKED_FINANCE,BAKED_ADS};',ctx);
const RD=ctx.__O.REAL_DATA, FIN=ctx.__O.BAKED_FINANCE, ADS=ctx.__O.BAKED_ADS||[];
if(!FIN.length){ console.error('нет BAKED_FINANCE — калибровать не от чего'); process.exit(1); }

const HOLD=r=>(r.logistics||0)+(r.penalty||0)+(r.storage||0)+(r.reimb||0)
  +(r.deduction||0)+(r.priyomka||0)+(r.loyalty||0)+(r.loyaltyPts||0);
const S=RD.orderSeries;
const ordQty=(from,to)=>{let s=0;S.dates.forEach((d,i)=>{if(d>=from&&d<=to)
  Object.values(S.bySku).forEach(r=>s+=r[i]||0);});return s;};

function agg(from,to){
  let rev=0,pay=0,hold=0,log=0,qty=0,ret=0,ad=0;
  FIN.forEach(r=>{ if(r.date<from||r.date>to) return;
    rev+=r.revenue||0; pay+=r.payout||0; hold+=HOLD(r); log+=r.logistics||0;
    qty+=r.qty||0; ret+=r.returnsQty||0; });
  ADS.forEach(r=>{ if(r.date>=from&&r.date<=to) ad+=r.spend||0; });
  const sold=qty-ret;
  return {from,to,rev,pay,net:pay-hold,hold,log,sold,ad,
    payoutRate: rev? (pay-hold)/rev : 0,
    commissionRate: rev? (rev-pay)/rev : 0,
    holdRate: rev? hold/rev : 0,
    logPerUnit: sold? log/sold : 0,
    avgTicket: sold? rev/sold : 0,
    adRate: rev? ad/rev : 0,
    ordered: ordQty(from,to)};
}
const dates=[...new Set(FIN.map(r=>r.date))].sort();
/* ПЕРИОДЫ ФАКТА (с 12.11.2026). Отчёты приходят не подряд: 29.06–02.08, потом перерыв (доступ закрыли
   24.08), потом неделя 02–08.11. Между ними ВБ менял условия (в ноябре появилась «Компенсация скидки по
   программе лояльности», комиссия выросла), поэтому один общий коэффициент на все недели — неправда.
   Считаем по каждому непрерывному куску дат отдельно и храним в `model.blocks`; `model-finance.cjs`
   берёт для дня коэффициенты ПОСЛЕДНЕГО куска, который закончился раньше этого дня (как % выкупа:
   действует с даты замера и вперёд, прошлое не трогаем). Верхние поля model.* — по последнему куску. */
const addD=(d,n)=>{const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
const runs=[]; dates.forEach(d=>{ const last=runs[runs.length-1];
  if(last && addD(last.to,1)===d) last.to=d; else runs.push({from:d,to:d}); });
const logShareOf=(from,to)=>{ let log=0,hold=0; FIN.forEach(r=>{ if(r.date<from||r.date>to) return; log+=r.logistics||0; hold+=HOLD(r); }); return hold? log/hold : 0; };
const blocks=runs.map(r=>{ const a=agg(r.from,r.to);
  return {from:r.from,to:r.to,days:Math.round((Date.parse(r.to)-Date.parse(r.from))/864e5)+1,
    payoutRate:+a.payoutRate.toFixed(4),commissionRate:+a.commissionRate.toFixed(4),holdRate:+a.holdRate.toFixed(4),
    logShare:+logShareOf(r.from,r.to).toFixed(4),avgTicket:Math.round(a.avgTicket),rev:Math.round(a.rev),net:Math.round(a.net)}; });
const lastRun=runs[runs.length-1];
const total=agg(lastRun.from,lastRun.to);
const weeks=[];
for(const run of runs){ const ds=dates.filter(d=>d>=run.from&&d<=run.to);
  for(let i=ds.length;i>0;i-=7){
    const w=ds.slice(Math.max(0,i-7),i);
    const a=agg(w[0],w[w.length-1]); if(a.rev>0) weeks.push(a);
  } }
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)));};
const st=f=>{const v=weeks.map(f);return {mean:+mean(v).toFixed(4),sd:+sd(v).toFixed(4),
  min:+Math.min(...v).toFixed(4),max:+Math.max(...v).toFixed(4)};};

const soldPerOrd = weeks.filter(w=>w.ordered>0).map(w=>w.sold/w.ordered);
RD.meta=RD.meta||{};
RD.meta.model={
  from:total.from, to:total.to, weeks:weeks.length, blocks,
  lag:(RD.meta.model&&RD.meta.model.lag)||null,   // срок «заказ → продажа» из последнего отчёта, пишет wb-fin-compare.cjs
  payoutRate:+total.payoutRate.toFixed(4),      // «итого к оплате» ÷ выручка — главный коэффициент
  commissionRate:+total.commissionRate.toFixed(4),
  holdRate:+total.holdRate.toFixed(4),
  logPerUnit:+total.logPerUnit.toFixed(2),
  avgTicket:Math.round(total.avgTicket),
  soldPerOrdered: soldPerOrd.length? +mean(soldPerOrd).toFixed(4) : null,
  spread:{ payoutRate:st(w=>w.payoutRate), avgTicket:st(w=>w.avgTicket),
           adRate:st(w=>w.adRate),
           soldPerOrdered: soldPerOrd.length? {mean:+mean(soldPerOrd).toFixed(4),
             sd:+sd(soldPerOrd).toFixed(4), min:+Math.min(...soldPerOrd).toFixed(4),
             max:+Math.max(...soldPerOrd).toFixed(4)} : null },
  note:'снято с фактических отчётов WB по периодам факта (blocks); верхние поля — по последнему периоду',
  builtAt:new Date().toISOString()
};
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const R=n=>Math.round(n).toLocaleString('ru-RU')+' ₽';
const P=n=>(n*100).toFixed(1)+'%';
console.log('ПЕРИОДЫ ФАКТА (коэффициент действует с конца периода и вперёд, до следующего):');
blocks.forEach(b=>console.log('  '+b.from+' … '+b.to+' ('+b.days+' дн.)  к оплате ÷ выручка '+P(b.payoutRate)
  +' · комиссия '+P(b.commissionRate)+' · удержания '+P(b.holdRate)+' · чек '+b.avgTicket+' ₽ · выручка '+R(b.rev)));
console.log('');
console.log('ПОСЛЕДНИЙ ПЕРИОД '+total.from+' … '+total.to+' (недель всего в факте: '+weeks.length+')');
console.log('  выручка '+R(total.rev)+' · итого к оплате '+R(total.net)+' · продано '+total.sold.toLocaleString('ru-RU')+' шт');
console.log('');
console.log('  «итого к оплате» ÷ выручка : '+P(total.payoutRate)
  +'   по неделям '+P(st(w=>w.payoutRate).min)+'…'+P(st(w=>w.payoutRate).max)+'  ← НАДЁЖНО');
console.log('  комиссия WB ÷ выручка      : '+P(total.commissionRate));
console.log('  удержания ÷ выручка        : '+P(total.holdRate));
console.log('  логистика на шт            : '+total.logPerUnit.toFixed(1)+' ₽');
console.log('  средний чек проданного     : '+Math.round(total.avgTicket)+' ₽/шт'
  +'   по неделям '+Math.round(st(w=>w.avgTicket).min)+'…'+Math.round(st(w=>w.avgTicket).max));
if(soldPerOrd.length) console.log('  продано ÷ заказано (та же неделя): '+P(mean(soldPerOrd))
  +'   по неделям '+P(Math.min(...soldPerOrd))+'…'+P(Math.max(...soldPerOrd))+'  ← зависит от тренда');
console.log('  реклама ÷ выручка          : '+P(st(w=>w.adRate).min)+'…'+P(st(w=>w.adRate).max)
  +'  ← НЕ коэффициент, вводится руками');
console.log('\nЗаписано в REAL_DATA.meta.model. Дальше: node scripts/encrypt.cjs <код>');
