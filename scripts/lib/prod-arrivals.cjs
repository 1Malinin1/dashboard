// ПРИХОД ПАРТИЙ ПРОИЗВОДСТВА ПО ОСТАТКАМ СВОИХ СКЛАДОВ (ЗАП-15, с 27.10.2026).
//
// ЗАЧЕМ. Продавец 27.10.2026: «когда партия придёт — тут нужно ловить и считать тебе, тк товар редко
// приходит сразу весь, может и дробно приходить, так что отмерить, когда придёт весь товар, нельзя, тут
// нужно тебе писать скрипт и отслеживать динамику по остаткам на моих складах». Файл заказов он
// присылает только при НОВЫХ заказах — строки уже пришедших партий в нём так и остаются «на МП 05.12».
// Значит, сколько пришло, знаем только мы, и только по ведомостям 1С (`RD.whHistory`).
// Реальный пример из октября: 519594 — +1 008 шт 15.10 и +1 512 шт 20.10; 512174 — +2 200 и +896.
//
// КАК СЧИТАЕМ.
//  · Остаток кода = сумма по ВСЕМ своим складам (Евросиб, FBS, Москва, Клин, «Ozon СФО/ЦФО») — перемещение
//    между своими складами приходом не считается. Склад, которого нет в очередной ведомости (файл пришёл
//    без колонки), держим на последнем известном значении — иначе его «возвращение» выглядело бы приходом.
//    Коды без карточки ВБ update-warehouse в склад не пишет («розничные»), поэтому для кодов из файла заказов
//    у него отдельная история `RD.prodStockHist` — она здесь складывается со `whHistory`.
//  · Приход = РОСТ остатка кода между двумя ведомостями подряд. Падения (отгрузка на площадку, продажа FBS)
//    приходом не считаются; рост меньше max(10 шт, 3% того, что ещё ждём по коду) — шум (возвраты, пересорт).
//    Отгрузка в те же дни может спрятать часть прихода — тогда пришедшее занижено и «ждём ещё» завышено;
//    точнее по ведомостям 1С не посчитать.
//  · Приход разносится по ОТКРЫТЫМ позициям кода от ранней к поздней: сначала прошлая партия, которой
//    не было видно (`missAt`, «ждём без срока»), потом идущие строки файла по дате на МП. Позиция получает
//    только приход ПОСЛЕ того, как появилась в файле (`since`): рост до заказа — не его товар.
//    Сверх всех позиций — `extra` (печатается: возврат или партия не из файла).
//  · Пересчёт каждый раз С НУЛЯ по всей истории — результат не зависит от того, сколько раз скрипт запускали.
//  · `inbound.p*` = заказано − пришло: «Закуп», «Приедет» в подсорте и resupply-report.cjs видят только то,
//    что ещё едет, а пришедшее — в остатке склада. Сайт (`prodBatches`) читает `got`/`gotLog` строк и `missAt`.
'use strict';
const LEAD=180;                        // от подачи заказа до прихода на МП, дней (ЗАП-14/15)
const RECEIPT_MIN=10, RECEIPT_SHARE=0.03;
/* Хвост «ждём ещё 4 шт из 3 100» — почти всегда отгрузка в тот же день, спрятавшая часть прихода, а не
   недовоз: позиция считается пришедшей целиком (`done`), если не хватает не больше max(10 шт, 2%). */
const DONE_TAIL=0.02;
const isDone=(got,qty)=>got>0 && qty-got<=Math.max(RECEIPT_MIN, DONE_TAIL*qty);
const addDays=(iso,n)=>{ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };
const S=v=>String(v==null?'':v).trim();

/* Итог своих складов по коду на каждую дату ведомости. */
function ownSeries(RD){
  const H=RD.whHistory||{}, X=RD.prodStockHist||{};
  const ds=[...new Set([...Object.keys(H),...Object.keys(X)])].sort();
  const last={}, at={};
  ds.forEach(d=>{
    const h=H[d]||{byWh:{},bySup:{}}, x=X[d]||{};
    const cur={};
    const put=src=>Object.entries(src||{}).forEach(([s,v])=>Object.entries((v&&v.wh)||{}).forEach(([w,q])=>{ (cur[w]=cur[w]||{})[s]=((cur[w]||{})[s]||0)+q; }));
    put(h.bySup); put(x);
    const known=new Set([...Object.keys(h.byWh||{}),...Object.keys(cur)]);
    known.forEach(w=>{ last[w]=cur[w]||{}; });
    const tot={}; Object.values(last).forEach(m=>Object.entries(m).forEach(([s,q])=>{ tot[s]=(tot[s]||0)+q; }));
    at[d]=tot;
  });
  return {dates:ds, at};
}

/* Прошлые партии («должен был уже придти»), которых не видно: заказано > остаток сейчас + продано с даты
   готовности больше чем на max(50, 10%) — та же проверка, что сверка 27.10 и сайт до ЗАП-15. Считается ОДИН
   раз на дату файла и замораживается: дальше её уменьшает только приход (иначе один и тот же приход
   закрывал бы и её, и идущую партию). */
function freezeMissing(RD, date){
  const P=RD.prodOrders; if(!P) return;
  const old=P.missAt||{}; const out={};
  const wbBy={}; (RD.catalog||[]).forEach(c=>{ const s=S(c.supplierCode); if(s) (wbBy[s]=wbBy[s]||[]).push(c); });
  const ozBy={}; ((RD.ozon&&RD.ozon.catalog)||[]).forEach(c=>{ ozBy[S(c.sku)]=c; });
  const wh=(RD.warehouse&&RD.warehouse.bySup)||{};
  const os=RD.orderSeries||{dates:[],bySku:{}}, oz=(RD.ozon&&RD.ozon.orderSeries)||{dates:[],byArt:{}};
  const sumFrom=(dates,arr,from)=>{ let q=0; if(!arr) return 0; dates.forEach((d,i)=>{ if(d>=from) q+=arr[i]||0; }); return q; };
  const bw=(RD.meta&&RD.meta.buyoutWin&&RD.meta.buyoutWin.all)||0.8;
  const ozH=(RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutWin&&RD.ozon.meta.buyoutWin.history)||[];
  const bo=(ozH.length&&ozH[ozH.length-1].all)||(RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutAll)||0.8;
  const by={}; P.rows.filter(r=>r.st==='overdue').forEach(r=>{ (by[r.sup]=by[r.sup]||[]).push(r); });
  Object.entries(by).forEach(([sup,rows])=>{
    const ord=rows.reduce((a,r)=>a+r.qty,0), ready=rows.map(r=>r.ready||'9999-99-99').sort()[0];
    const o=old[sup];
    if(o && o.ord===ord && o.ready===(ready<'9999'? ready : null)){ out[sup]={ord:o.ord, ready:o.ready, qty:o.qty, since:o.since}; return; }
    const stock=(wbBy[sup]||[]).reduce((a,c)=>a+(c.wbStock||0),0)
      +(ozBy[sup]? (ozBy[sup].ozStock||0)+(ozBy[sup].ozTransit||0) : 0)+((wh[sup]&&wh[sup].qty)||0);
    let sold=0;
    if(ready<'9999'){
      const sw=(wbBy[sup]||[]).reduce((a,c)=>a+sumFrom(os.dates,os.bySku[c.sku],ready),0);
      const so=sumFrom(oz.dates,(oz.byArt||{})[sup],ready);
      sold=Math.round(sw*bw+so*bo);
    }
    const gap=ord-stock-sold;
    out[sup]={ord, ready:ready<'9999'? ready : null, qty:gap>Math.max(50,0.1*ord)? Math.min(ord,gap) : 0, since:date};
  });
  P.missAt=out;
}

/* Партии в `inbound` — из строк файла, за вычетом пришедшего. */
function rebuildInbound(RD){
  const P=RD.prodOrders; const keep={};
  if(RD.inbound && RD.inbound.china) keep.china=RD.inbound.china;      // «едет из Китая» — другой отчёт
  const dmy=iso=>iso.slice(8,10)+'.'+iso.slice(5,7)+'.'+iso.slice(0,4);
  const groups={};
  P.rows.filter(r=>r.st==='pending'||r.st==='manual').forEach(r=>{
    const rem=r.done? 0 : Math.max(0,r.qty-(r.got||0)); if(!rem) return;
    const k=r.mp? 'p'+r.mp.replace(/-/g,'') : 'pmanual';
    const g=groups[k]||(groups[k]={label:(r.mp? 'Заказ производству · на МП '+dmy(r.mp) : 'Заказано производству · срок не указан'),
      date:P.date, total:0, bySup:{}, eta:null, etaSale:r.mp||null, src:'prod-plan'});
    g.bySup[r.sup]=(g.bySup[r.sup]||0)+rem; g.total+=rem; });
  RD.inbound=Object.assign(keep,groups);
}

/* Главное: пересчитать приход с нуля, записать `got`/`gotLog`, `missAt[].got`, `extra`, пересобрать inbound.
   Возвращает журнал приходов [{d, sup, qty, alloc:[{what, qty, rem}], extra}] по всей истории. */
function computeArrivals(RD){
  const P=RD.prodOrders; if(!P) return [];
  if(!P.missAt) freezeMissing(RD, P.date);
  const ser=ownSeries(RD), ds=ser.dates;
  const dmy=iso=>iso? iso.slice(8,10)+'.'+iso.slice(5,7)+'.'+iso.slice(2,4) : '—';
  const items={};
  Object.entries(P.missAt||{}).forEach(([sup,m])=>{ m.got=0; m.gotLog=[]; m.done=false;
    if(m.qty>0) (items[sup]=items[sup]||[]).push({ref:m, qty:m.qty, due:m.ready||'0000-00-00', since:m.since||P.date,
      what:'прошлая партия'+(m.ready? ' (готовность '+dmy(m.ready)+')' : '')}); });
  P.rows.forEach(r=>{ if(r.st!=='pending'&&r.st!=='manual') return; r.got=0; r.gotLog=[]; r.done=false;
    const since=r.since||P.date;
    (items[r.sup]=items[r.sup]||[]).push({ref:r, qty:r.qty, due:r.mp||addDays(since,LEAD), since,
      what:r.mp? 'партия на МП '+dmy(r.mp) : 'заказ без срока'}); });
  P.extra={};
  const log=[];
  Object.entries(items).forEach(([sup,list])=>{
    list.sort((a,b)=>a.due.localeCompare(b.due));
    const from=list.map(x=>x.since).sort()[0];
    for(let i=1;i<ds.length;i++){
      const d0=ds[i-1], d=ds[i]; if(d0<from) continue;
      const dl=(ser.at[d][sup]||0)-(ser.at[d0][sup]||0); if(dl<=0) continue;
      const elig=list.filter(x=>x.since<=d0 && x.ref.got<x.qty);
      const open=elig.reduce((a,x)=>a+x.qty-x.ref.got,0);
      if(dl<Math.max(RECEIPT_MIN, RECEIPT_SHARE*open)) continue;          // возвраты, пересорт — шум
      let left=dl; const alloc=[];
      for(const x of elig){ if(!left) break;
        const t=Math.min(left, x.qty-x.ref.got); if(t<=0) continue;
        x.ref.got+=t; x.ref.gotLog.push([d,t]); left-=t;
        alloc.push({what:x.what, qty:t, of:x.qty, rem:x.qty-x.ref.got}); }
      if(left>0) (P.extra[sup]=P.extra[sup]||[]).push([d,left]);
      log.push({d, sup, qty:dl, alloc, extra:left});
    }
    list.forEach(x=>{ x.ref.done=isDone(x.ref.got,x.qty); });
  });
  P.arrivalsAt=ds[ds.length-1]||null;
  rebuildInbound(RD);
  return log;
}

/* Печать для продавца: приходы после даты `after` (null — все). */
function printArrivals(log, RD, after){
  const F=n=>Math.round(n||0).toLocaleString('ru-RU');
  const dmy=iso=>iso.slice(8,10)+'.'+iso.slice(5,7);
  const name={}; (RD.catalog||[]).forEach(c=>{ const s=S(c.supplierCode); if(s&&!name[s]) name[s]=c.name; });
  (RD.prodOrders.rows||[]).forEach(r=>{ if(!name[r.sup]&&r.name) name[r.sup]=r.name; });
  const L=log.filter(x=>!after || x.d>after);
  if(!L.length){ console.log('Приход партий производства'+(after? ' после '+dmy(after) : '')+': не было (рост остатков своих складов по кодам из файла не найден).'); return L; }
  console.log('\nПРИХОД ПАРТИЙ ПРОИЗВОДСТВА (по росту остатков своих складов)'+(after? ' после '+dmy(after) : '')+':');
  L.forEach(x=>{
    console.log('   '+dmy(x.d)+' · 1С '+x.sup+' +'+F(x.qty)+' шт · '+String(name[x.sup]||'').slice(0,40));
    x.alloc.forEach(a=>console.log('        → '+a.what+': пришло '+F(a.of-a.rem)+' из '+F(a.of)+(isDone(a.of-a.rem,a.of)? ' · пришла целиком' : ' · ждём ещё '+F(a.rem))));
    if(x.extra>0) console.log('        → сверх заказов '+F(x.extra)+' шт (возврат или партия не из файла)');
  });
  return L;
}

module.exports={computeArrivals, freezeMissing, rebuildInbound, ownSeries, printArrivals, isDone, LEAD, RECEIPT_MIN, RECEIPT_SHARE, DONE_TAIL};
