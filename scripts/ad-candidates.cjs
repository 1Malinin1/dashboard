// Черновой отбор товаров под рекламу на Wildberries — повторяет ручную логику продавца.
// Это ИНСТРУМЕНТ ДЛЯ ОБСУЖДЕНИЯ: печатает расклад, чтобы согласовать правила до того,
// как они уедут в дашборд. Ничего в снимок не пишет.
//
// ЛОГИКА ПРОДАВЦА (со слов, 31.08.2026):
//   1) выбираем группу (Пушкары, Рули, Песок, Светофоры, Набор для бокса);
//   2) внутри неё товары разбиты на СКЛЕЙКИ (`adTag`) — карточки, слитые в одну;
//   3) смотрим остаток в МОСКВЕ по FBS: такие товары продаются лучше всего,
//      потому что лежат там, где основной спрос;
//   4) внутри склейки применяем правило Парето → категория A;
//   5) рекламу запускаем на A, остальные едут на ассоциативных конверсиях.
//
// Использование:
//   node scripts/ad-candidates.cjs                 — список групп
//   node scripts/ad-candidates.cjs Пушкары [дней]  — расклад по группе (по умолчанию 28 дней)
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const GROUP=process.argv[2]||null, DAYS=parseInt(process.argv[3]||'28',10);

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\n'
  +fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__O={REAL_DATA,BAKED_FUNNEL:(typeof BAKED_FUNNEL!=="undefined"?BAKED_FUNNEL:[])};',ctx);
const O=ctx.__O, RD=O.REAL_DATA;
const F=(n,d=0)=>Number(n||0).toLocaleString('ru-RU',{maximumFractionDigits:d});

const tagged=RD.catalog.filter(c=>c.adGroup);
if(!GROUP){
  const g={}; tagged.forEach(c=>g[c.adGroup]=(g[c.adGroup]||0)+1);
  console.log('Группы со склейками (всего товаров со склейкой: '+tagged.length+'):');
  Object.entries(g).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
  console.log('\nnode scripts/ad-candidates.cjs "<группа>" [дней]');
  process.exit(0);
}

// ---- окно дат ----
const S=RD.orderSeries, dates=S.dates, last=dates[dates.length-1];
const from=dates[Math.max(0,dates.length-DAYS)];
const win=dates.slice(Math.max(0,dates.length-DAYS));
const winSet=new Set(win);
const M=S.money||{};

// ---- склад в Москве по коду 1С (оба московских склада: СХ Солнечногорск + РЦ Солнечногорский) ----
const wh=(RD.warehouse&&RD.warehouse.bySup)||{};
const mskBySup={}, nsk1BySup={};
Object.entries(wh).forEach(([sup,v])=>{ let m=0,n=0;
  Object.entries(v.wh||{}).forEach(([n2,q])=>{
    if(/(^|\W)fbs(\W|$)|фбс/i.test(n2)) n+=q;
    else if(/солнечногор|москв/i.test(n2)) m+=q; });
  mskBySup[sup]=m; nsk1BySup[sup]=n; });

// ---- воронка по sku за окно (показы/переходы/корзина/заказы/выкуп) ----
const fun={};
O.BAKED_FUNNEL.forEach(r=>{ if(!winSet.has(r.date)) return;
  const e=fun[r.sku]||(fun[r.sku]={imp:0,cv:0,cart:0,ord:0,buy:0});
  e.imp+=r.impressions||0; e.cv+=r.cardViews||0; e.cart+=r.addCart||0;
  e.ord+=r.ordersQty||0; e.buy+=r.buyoutQty||0; });

// ---- метрики по товару ----
const idx={}; dates.forEach((d,i)=>idx[d]=i);
const rows=tagged.filter(c=>c.adGroup===GROUP).map(c=>{
  const sku=''+c.sku, sup=(''+(c.supplierCode||'')).trim();
  const arr=S.bySku[sku]||[];
  let qty=0; win.forEach(d=>{ qty+=arr[idx[d]]||0; });
  let rub=0; win.forEach(d=>{ const m=M[d]&&M[d][sku]; if(m) rub+=m[0]||0; });
  const f=fun[sku]||{imp:0,cv:0,cart:0,ord:0,buy:0};
  return {sku, sup, tag:c.adTag||'—', name:(c.name||'').slice(0,38),
    qty, rub, msk:mskBySup[sup]||0, nsk1:nsk1BySup[sup]||0, fbo:c.wbStock||0,
    imp:f.imp, ctr:f.imp? f.cv/f.imp*100:0, cr:f.cv? f.ord/f.cv*100:0,
    price:qty? rub/qty:0};
});
if(!rows.length){ console.error('в группе «'+GROUP+'» нет товаров'); process.exit(1); }

// ---- ABC внутри СКЛЕЙКИ по выручке (заказано ₽) ----
const byTag={}; rows.forEach(r=>(byTag[r.tag]||(byTag[r.tag]=[])).push(r));
const abc=(list,key)=>{ const tot=list.reduce((a,x)=>a+x[key],0);
  const sorted=[...list].sort((a,b)=>b[key]-a[key]); let acc=0;
  sorted.forEach(x=>{ acc+=x[key]; const sh=tot? acc/tot:1;
    x['abc_'+key] = sh<=0.8? 'A' : (sh<=0.95? 'B':'C'); x['share_'+key]=tot? x[key]/tot*100:0; });
  return tot; };

console.log('ГРУППА «'+GROUP+'» · окно '+from+'…'+last+' ('+win.length+' дн)');
console.log('склад: Москва (СХ Солнечногорск + РЦ Солнечногорский) на '+((RD.warehouse&&RD.warehouse.date)||'—'));
console.log('='.repeat(112));

const order=Object.entries(byTag).map(([t,l])=>({t,l,rub:l.reduce((a,x)=>a+x.rub,0)}))
  .sort((a,b)=>b.rub-a.rub);
order.forEach(({t,l,rub})=>{
  abc(l,'rub'); abc(l,'qty');
  const msk=l.reduce((a,x)=>a+x.msk,0), qty=l.reduce((a,x)=>a+x.qty,0);
  console.log('\nСКЛЕЙКА «'+t+'» · '+l.length+' карточек · заказано '+F(rub)+' ₽ · '+F(qty)+' шт · Москва '+F(msk)+' шт');
  console.log('  A/₽ A/шт  артикул      1С      заказано ₽   доля%   шт   Москва   Нск-1    FBO    показы   CTR%   CR%   чек');
  [...l].sort((a,b)=>b.rub-a.rub).forEach(x=>{
    console.log('   '+x.abc_rub+'    '+x.abc_qty+'   '+x.sku.padEnd(11)+String(x.sup).padEnd(8)
      +F(x.rub).padStart(11)+F(x.share_rub,1).padStart(7)+F(x.qty).padStart(6)
      +F(x.msk).padStart(8)+F(x.nsk1).padStart(8)+F(x.fbo).padStart(7)
      +F(x.imp).padStart(10)+F(x.ctr,1).padStart(7)+F(x.cr,1).padStart(6)+F(x.price).padStart(7)
      +'  '+x.name);
  });
});

// ---- итоговый список кандидатов: A по выручке И есть остаток в Москве ----
console.log('\n'+'='.repeat(112));
const cand=rows.filter(x=>x.abc_rub==='A').sort((a,b)=>b.rub-a.rub);
const withMsk=cand.filter(x=>x.msk>0), noMsk=cand.filter(x=>x.msk<=0);
console.log('КАНДИДАТЫ ПОД РЕКЛАМУ (категория A внутри своей склейки), по убыванию выручки:');
console.log('  #  артикул      склейка               заказано ₽    шт   Москва   показы   CTR%   CR%   товар');
withMsk.forEach((x,i)=>console.log('  '+String(i+1).padStart(2)+' '+x.sku.padEnd(12)+x.tag.slice(0,20).padEnd(22)
  +F(x.rub).padStart(11)+F(x.qty).padStart(6)+F(x.msk).padStart(8)+F(x.imp).padStart(9)
  +F(x.ctr,1).padStart(7)+F(x.cr,1).padStart(6)+'   '+x.name));
if(noMsk.length){
  console.log('\n  Категория A, но в Москве остатка НЕТ (по вашей логике — не берём):');
  noMsk.forEach(x=>console.log('     '+x.sku.padEnd(12)+x.tag.slice(0,20).padEnd(22)
    +F(x.rub).padStart(11)+F(x.qty).padStart(6)+'  Нск-1 '+F(x.nsk1)+' · FBO '+F(x.fbo)+'   '+x.name));
}
