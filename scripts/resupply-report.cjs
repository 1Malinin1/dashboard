// Отчёт «нужен ли подсорт» — считает то же, что вид «Подсорт со склада» в дашборде,
// но в консоли. ЗАПУСКАТЬ ПОСЛЕ ЛЮБОГО ОБНОВЛЕНИЯ ОСТАТКОВ (ВБ, Озон, свой склад) —
// это правило продавца: после каждой заливки он хочет видеть, что и куда отгружать.
//
// Правила (совпадают с index.html):
//   покрытие ВБ   = остаток на складах WB + открытые отгрузки из журнала (REAL_DATA.shipments);
//   покрытие Озон = остаток + ozTransit (заявки и партии, которые показывает сам Озон);
//   продаж/дн     = заказы за 7 дней ÷ 7 × % выкупа;
//   нужно до цели = ceil(продаж/дн × RESUPPLY_DAYS) − покрытие;
//   склада не хватает на обе площадки → ПРИОРИТЕТ ОЗОНУ, ВБ получает остаток;
//   отгрузка только целыми ПАЛЛЕТАМИ (вместимость у площадок разная), стартовая партия
//   округляется вверх; PALLETS_PER_TRUCK=33 паллеты = машина с одного склада на одну площадку.
//
// Использование: node scripts/resupply-report.cjs [дней=30] [сколько строк показать=15]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DAYS=parseInt(process.argv[2],10)||30;
const LAUNCH_QTY=500;   // товара нет на площадке и продаж нет → стартовая партия
const TOP=parseInt(process.argv[3],10)||15;

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
// воронка ВБ нужна для % выкупа по окну (лежит в отчётах, а не в каталоге)
let FUNNEL_WB=[];
try{ const c2={};vm.createContext(c2);
  vm.runInContext(fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
    +'\nglobalThis.__F=(typeof BAKED_FUNNEL!=="undefined"? BAKED_FUNNEL:[]);',c2);
  FUNNEL_WB=c2.__F||[]; }catch(e){ FUNNEL_WB=[]; }
const F=n=>Math.round(n).toLocaleString('ru-RU');
const D=v=>v===Infinity?'∞':Math.round(v);

// % выкупа по окну «пропустить последнюю неделю, взять две предыдущие» — та же логика,
// что buyoutFromFunnel/buyoutOf в index.html (держи синхронно). Незрелому окну не верим:
// выкуп в снимке заморожен на момент выгрузки и задним числом не обновляется.
const BUYOUT_HOLD=7, BUYOUT_WIN=14, BUYOUT_MIN_ORD=10;
const addD=(d,n)=>{const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
function buyoutFromFunnel(funnel){
  if(!funnel||!funnel.length) return null;
  const ds=[...new Set(funnel.map(r=>r.date))].sort();
  const to=addD(ds[ds.length-1],-BUYOUT_HOLD), from=addD(to,-(BUYOUT_WIN-1));
  const rows=funnel.filter(r=>r.date>=from&&r.date<=to);
  if(!rows.length) return null;
  const bySku={}; let o=0,b=0;
  rows.forEach(r=>{ const e=bySku[r.sku]||(bySku[r.sku]={o:0,b:0});
    e.o+=r.ordersQty||0; e.b+=r.buyoutQty||0; o+=r.ordersQty||0; b+=r.buyoutQty||0; });
  if(!o) return null;
  // зрелость: день с заказами, но почти без выкупа = выкуп ещё не проставлен (см. index.html)
  const byDate={};
  rows.forEach(r=>{ const e=byDate[r.date]||(byDate[r.date]={o:0,b:0});
    e.o+=r.ordersQty||0; e.b+=r.buyoutQty||0; });
  const dead=Object.keys(byDate).filter(d=>byDate[d].o>=20&&byDate[d].b/byDate[d].o<0.15).sort();
  return {from,to,all:b/o,bySku,dead,mature:dead.length===0,days:Object.keys(byDate).length};
}
// У ВБ приоритет — измеренное окно из сводного отчёта (scripts/wb-buyout-window.cjs).
// См. buyoutInfo в index.html: держи синхронно.
function wbMeasured(){ const b=RD.meta&&RD.meta.buyoutWin;
  return (b&&b.all>0)? {from:b.from,to:b.to,all:b.all,pctBySku:b.bySku||{},dead:[],
    mature:true,measured:true,openPct:b.openPct,days:null} : null; }
const BW={ wb: wbMeasured()||buyoutFromFunnel(FUNNEL_WB),
           ozon: buyoutFromFunnel((RD.ozon&&RD.ozon.funnel)||[]) };
function buyoutOf(mp,sku,fallback){
  const bi=BW[mp];
  if(!bi || !bi.mature) return fallback;
  if(bi.pctBySku){ const p=bi.pctBySku[sku]; return p>0? p : bi.all; }
  const e=bi.bySku[sku];
  return (e && e.o>=BUYOUT_MIN_ORD) ? e.b/e.o : bi.all;
}
function mpStats(mp){
  const oz=mp==='ozon';
  const cat = oz? ((RD.ozon&&RD.ozon.catalog)||[]) : RD.catalog;
  const ser = oz? ((RD.ozon&&RD.ozon.orderSeries&&RD.ozon.orderSeries.byArt)||{}) : RD.orderSeries.bySku;
  const dates = oz? ((RD.ozon&&RD.ozon.orderSeries&&RD.ozon.orderSeries.dates)||[]) : RD.orderSeries.dates;
  const last=dates.length-1, days=Math.min(7,dates.length);
  const buyAvg = oz? ((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutAll)||1)
    : (()=>{const v=RD.catalog.map(c=>c.buyoutPct14d).filter(x=>x>0);return v.length? v.reduce((a,b)=>a+b,0)/v.length/100:1;})();
  const openShip={}; (RD.shipments||[]).forEach(s=>{ if(s.mp==='wb'&&s.left>0) openShip[s.sup]=(openShip[s.sup]||0)+s.left; });
  const out={}, done=new Set();
  cat.forEach(c=>{
    const sup = oz? (''+c.sku) : (''+(c.supplierCode||'')).trim(); if(!sup) return;
    const s=ser[c.sku]; let sum=0; if(s) for(let i=Math.max(0,last-6);i<=last;i++) sum+=s[i]||0;
    const avgD=days? sum/days:0;
    const buyout = buyoutOf(mp, c.sku,
      oz? (c.ozBuyout!=null?c.ozBuyout:buyAvg) : (c.buyoutPct14d>0? c.buyoutPct14d/100 : buyAvg));
    const stock = oz? (c.ozStock||0) : (c.wbStock||0);   // свой склад в покрытие НЕ входит
    let transit = oz? (c.ozTransit||0) : 0;
    if(!oz && !done.has(sup)){ transit+=(openShip[sup]||0); done.add(sup); }
    const e=out[sup]||(out[sup]={spd:0,stock:0,transit:0,name:c.name});
    e.spd+=avgD*buyout; e.stock+=stock; e.transit+=transit; if(!e.name) e.name=c.name;
  });
  Object.values(out).forEach(e=>{ e.covered=e.stock+e.transit;
    e.days = e.spd>0? e.covered/e.spd : (e.covered>0? Infinity:0); });
  return out;
}

const W=mpStats('wb'), O=mpStats('ozon');
const wh=(RD.warehouse&&RD.warehouse.bySup)||{};
const inb=RD.inbound||{};
const chinaBy=(inb.china&&inb.china.bySup)||{}, orderBy=(inb.order&&inb.order.bySup)||{};
const zero={spd:0,covered:0,days:0,name:''};
const PAL=(RD.pallets&&RD.pallets.bySup)||{};
const PALLETS_PER_TRUCK=33;
/* ТРИ СКЛАДА И МАРШРУТЫ (правила продавца 27.08.2026) — держи синхронно с index.html:
     Москва «СХ Солнечногорск» — только FBS для Wildberries, не отгружает никуда;
     Нск-1 «Склад FBS»         — FBS для Wildberries + поставки на Ozon;
     Нск-2 «Склад Евросиб»     — поставки на Ozon + перемещение на Нск-1.
   Поставок на склады Wildberries больше НЕТ: остаток FBO только убывает, дальше ВБ
   продаётся по FBS. Вместо отгрузки на ВБ считаем перемещение Евросиб → Нск-1. */
const WB_FBO_SUPPLY=false, NSK1_MIN_DAYS=30;
function whKey(n){ const s=''+n;
  if(/(^|\W)fbs(\W|$)|фбс/i.test(s)) return 'nsk1';
  if(/евросиб/i.test(s)) return 'nsk2';
  if(/солнечногор|москв|(^|\W)мск(\W|$)/i.test(s)) return 'msk';
  if(/новосиб|(^|\W)нск(\W|$)/i.test(s)) return 'nsk2';
  return 'other'; }
// «На вывод» исключаем из подсорта целиком (просьба продавца): товар выводится из
// ассортимента, везти его на площадку незачем. Считаем по ВСЕМ карточкам кода 1С —
// если хоть одна НЕ «На вывод», товар живой. В дозаказе/закупе статус по-прежнему справочный.
const outSup=new Set(); {
  const st={}; (RD.catalog||[]).forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(!s) return;
    const out=(''+(c.productionStatus||'')).trim()==='На вывод';
    st[s]=(st[s]===undefined)? out : (st[s]&&out); });
  // выводимый товар, который ЛЕЖИТ НА СКЛАДЕ, в подсорте остаётся — его надо распродать
  Object.keys(st).forEach(s=>{ if(st[s] && !((wh[s]&&wh[s].qty)>0)) outSup.add(s); });
}
const sups=[...new Set([...Object.keys(W),...Object.keys(O),...Object.keys(wh)])].filter(s=>!outSup.has(s));
let rows=sups.map(sup=>{
  const w=W[sup]||zero, o=O[sup]||zero, have=(wh[sup]&&wh[sup].qty)||0;
  const launchW = WB_FBO_SUPPLY && w.spd<=0 && w.covered<=0 && have>0;
  const launchO = o.spd<=0 && o.covered<=0 && have>0;
  const needW=!WB_FBO_SUPPLY? 0
    : (launchW? Math.min(LAUNCH_QTY,have) : Math.max(0,Math.ceil(w.spd*DAYS)-w.covered));
  const needO=launchO? Math.min(LAUNCH_QTY,have) : Math.max(0,Math.ceil(o.spd*DAYS)-o.covered);
  // отгрузка целыми паллетами: на Ozon — сначала Евросиб, потом Нск-1 (его бережём под FBS)
  const whB=(wh[sup]&&wh[sup].wh)||{}; const q={msk:0,nsk1:0,nsk2:0,other:0};
  Object.entries(whB).forEach(([n,v])=>{ q[whKey(n)]+=v; });
  const mMsk=q.msk, mNsk1=q.nsk1, mNsk2=q.nsk2;
  const P=PAL[sup]||null, palOz=P?(P.oz||0):0, palWb=P?(P.wb||0):0;
  let rNsk1=mNsk1, rNsk2=mNsk2;
  // Округляем ВВЕРХ (решение продавца 24.08) — округление вниз систематически не дотягивало
  // до цели 30 дней. Держи синхронно с takePallets в index.html.
  const take=(needQty,cap)=>{ if(cap<=0) return null;
    const want=Math.ceil(needQty/cap);
    if(want<=0) return {pal:0,nsk1:0,nsk2:0,qty:0};
    const b=Math.min(want,Math.floor(rNsk2/cap)), a=Math.min(want-b,Math.floor(rNsk1/cap));
    rNsk2-=b*cap; rNsk1-=a*cap; return {pal:a+b,nsk1:a,nsk2:b,qty:(a+b)*cap}; };
  let shipO=0,shipW=0,palO=0,palW=0,oN1=0,oN2=0,usedNsk1=0,usedNsk2=0;
  const tO=take(needO,palOz);
  if(tO){ palO=tO.pal; shipO=tO.qty; oN1=tO.nsk1; oN2=tO.nsk2; usedNsk1+=tO.nsk1*palOz; usedNsk2+=tO.nsk2*palOz; }
  else { shipO=Math.min(needO,rNsk1+rNsk2); const f=Math.min(shipO,rNsk2); rNsk2-=f; rNsk1-=(shipO-f);
         usedNsk2+=f; usedNsk1+=(shipO-f); }
  // перемещение Евросиб → Нск-1 вместо отгрузки на ВБ (FBS уходит покупателю с Нск-1)
  const nsk1Days = w.spd>0 ? mNsk1/w.spd : (mNsk1>0? Infinity : 0);
  const moveNeed = (!WB_FBO_SUPPLY && w.spd>0) ? Math.max(0, Math.ceil(w.spd*NSK1_MIN_DAYS)-mNsk1) : 0;
  const move = Math.min(moveNeed, Math.max(0,rNsk2));
  rNsk2-=move; usedNsk2+=move;
  /* ПОКРЫТИЕ ВБ = остаток на складах WB + свободный FBS-запас (вся Москва + Нск-1 минус
     то, что забрал Ozon). Держи синхронно с wbFbsBySup/resupplyRows в index.html. */
  const wbFbsFree = mMsk + Math.max(0, mNsk1-usedNsk1);
  const wCovAll = w.covered + wbFbsFree;
  const wDaysAll = w.spd>0 ? wCovAll/w.spd : (wCovAll>0? Infinity : 0);
  return {sup,name:(w.name||o.name||sup),have,palOz,palWb,palO,palW,oN1,oN2,
    whMsk:mMsk,whNsk1:mNsk1,whNsk2:mNsk2,whNsk:mNsk1+mNsk2,usedNsk1,usedNsk2,
    oCov:o.covered,wCov:w.covered,topUpO:0,
    noPal:(!P&&needO>0), move, moveNeed, nsk1Days, wbFbsFree, wCovAll, wDaysAll,
    wDays:w.days,oDays:o.days,wSpd:w.spd,oSpd:o.spd,needW,needO,shipW,shipO,
    rest:have-shipO-move, china:chinaBy[sup]||0, order:orderBy[sup]||0, launch:launchO,
    minDays:Math.min(w.spd>0?w.days:Infinity,o.spd>0?o.days:Infinity)};
});

// ---- ДОБОР НЕПОЛНОЙ МАШИНЫ (та же логика, что в index.html — держи синхронно) ----
// Неполную машину от TRUCK_TOPUP_MIN паллет добиваем до полной: везти полупустую дороже.
// Добираем только тем, что на площадке продастся за TOPUP_SELL_DAYS, по одной паллете
// разным кодам. Не добили до полной — не добираем вообще.
const TRUCK_TOPUP_MIN=15, TOPUP_SELL_DAYS=90;
(function topUp(){
  const cnt={"Евросиб|ozon":0,"Нск-FBS|ozon":0};
  rows.forEach(r=>{ cnt["Евросиб|ozon"]+=r.oN2; cnt["Нск-FBS|ozon"]+=r.oN1; });
  const free={}, cap={};
  rows.forEach(r=>{ free[r.sup]={"Евросиб":Math.max(0,r.whNsk2-r.usedNsk2),"Нск-FBS":Math.max(0,r.whNsk1-r.usedNsk1)};
    cap[r.sup]={ozon:Math.max(0,Math.floor(r.oSpd*TOPUP_SELL_DAYS)-(r.oCov+r.shipO))}; });
  Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a]).forEach(k=>{
    const wh=k.split('|')[0], mp=k.split('|')[1];
    const restPal=cnt[k]%PALLETS_PER_TRUCK; if(restPal<TRUCK_TOPUP_MIN) return;
    const pal=r=> r.palOz;
    const cands=rows.filter(r=>pal(r)>0 && free[r.sup][wh]>=pal(r) && cap[r.sup][mp]>=pal(r))
      .sort((a,b)=>(a.oDays===Infinity?1e9:a.oDays)-(b.oDays===Infinity?1e9:b.oDays));
    const fr={},cp={},plan=new Map();
    cands.forEach(r=>{ fr[r.sup]=free[r.sup][wh]; cp[r.sup]=cap[r.sup][mp]; });
    let left=PALLETS_PER_TRUCK-restPal, moved=true;
    while(left>0&&moved){ moved=false;
      for(const r of cands){ if(left<=0) break; const p=pal(r);
        if(fr[r.sup]<p||cp[r.sup]<p) continue;
        fr[r.sup]-=p; cp[r.sup]-=p; plan.set(r,(plan.get(r)||0)+1); left--; moved=true; } }
    if(left>0) return;
    plan.forEach((pals,r)=>{ const qty=pals*pal(r);
      free[r.sup][wh]-=qty; cap[r.sup][mp]-=qty; cnt[k]+=pals;
      if(wh==='Евросиб'){ r.usedNsk2+=qty; r.oN2+=pals; } else { r.usedNsk1+=qty; r.oN1+=pals; }
      r.shipO+=qty; r.palO+=pals; r.topUpO+=qty; });
  });
  rows.forEach(r=>{ r.rest=r.have-r.shipO-r.move; });
})();
const _rows=rows.filter(r=>r.needO>0||r.move>0||r.moveNeed>0||r.have>0);
rows.length=0; _rows.forEach(r=>rows.push(r));

const needAny=rows.filter(r=>r.needO>0);
const toShip=rows.filter(r=>r.shipO>0);
const noStock=needAny.filter(r=>r.have<=0);
const urgent=needAny.filter(r=>r.minDays<DAYS/3);
// перемещение Евросиб → Нск-1 (вместо отгрузки на ВБ: поставок на склады WB больше нет)
const movers=rows.filter(r=>r.moveNeed>0).sort((a,b)=>(a.nsk1Days===Infinity?1e9:a.nsk1Days)-(b.nsk1Days===Infinity?1e9:b.nsk1Days));
const moveGap=movers.filter(r=>r.move<=0);

['wb','ozon'].forEach(mp=>{ const b=BW[mp]; const nm=mp==='wb'?'ВБ  ':'Озон';
  if(!b){ console.log('% выкупа '+nm+': воронки нет → прежний источник'); return; }
  console.log('% выкупа '+nm+': окно '+b.from+'…'+b.to
    +(b.measured? ' (замер сводным отчётом, в пути '+b.openPct+'%)' : ' ('+b.days+'/'+BUYOUT_WIN+' дн по воронке)')
    +' → '+(b.all*100).toFixed(1)+'%'
    +(b.mature? ' · ПРИМЕНЕНО'
      : ' · НЕ ЗРЕЛО (выкуп не проставлен за '+b.dead.length+' дн: '
        +b.dead.join(', ')+') → взят прежний источник'));
});
console.log('');
console.log('ПОДСОРТ НА '+DAYS+' ДНЕЙ · остатки ВБ на '+((RD.meta&&RD.meta.stockSnapshotDate)||'—')
  +' · Озон на '+((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.stockDate)||'—')
  +' · склад на '+((RD.warehouse&&RD.warehouse.date)||'не загружен'));
console.log('─'.repeat(96));
console.log('Требуют подсорта: '+needAny.length+' позиций (из них СРОЧНО, покрытие < '+Math.round(DAYS/3)+' дн: '+urgent.length+')');
console.log('К отгрузке на Ozon: '+F(rows.reduce((a,r)=>a+r.shipO,0))+' шт'
  +'  (Евросиб и Нск-1; Москва на Ozon не отгружает)');
console.log('Нечем закрыть (на складе пусто): '+noStock.length+' позиций, не хватает '
  +F(noStock.reduce((a,r)=>a+r.needO,0))+' шт');
const launches=needAny.filter(r=>r.launch);
if(launches.length) console.log('Стартовые партии (товара нет на площадке): '+launches.length+' позиций · '
  +F(launches.reduce((a,r)=>a+r.shipO,0))+' шт');
console.log('ПЕРЕМЕСТИТЬ Евросиб → Нск-1 (FBS на ВБ): '+F(rows.reduce((a,r)=>a+r.move,0))+' шт по '
  +movers.filter(r=>r.move>0).length+' кодам'+(moveGap.length? '  ·  нечем закрыть '+moveGap.length+' кодов':''));
console.log('Покрытие ВБ: FBO '+F(rows.reduce((a,r)=>a+(r.wCov||0),0))+' шт + FBS со своих складов '
  +F(rows.reduce((a,r)=>a+r.wbFbsFree,0))+' шт (Москва целиком + Нск-1 без того, что забрал Ozon)');
console.log('Останется на складе: '+F(rows.reduce((a,r)=>a+r.rest,0))+' шт из '+F(Object.values(wh).reduce((a,v)=>a+v.qty,0)));

// ---- план машин: паллеты по (склад × площадка), машина = 33 паллеты, ассортимент round-robin ----
const buckets={};
const addB=(whn,mp,r,pal,days)=>{ if(pal<=0) return; const k=whn+'|'+mp;
  (buckets[k]||(buckets[k]=[])).push({sup:r.sup,name:r.name,pal,days}); };
rows.forEach(r=>{ addB('Евросиб','Ozon',r,r.oN2,r.oDays); addB('Нск-FBS','Ozon',r,r.oN1,r.oDays); });
const plan=Object.entries(buckets).map(([k,items])=>{
  const [whn,mp]=k.split('|'); const total=items.reduce((a,x)=>a+x.pal,0);
  const pool=items.map(x=>({...x,left:x.pal})).sort((a,b)=>(a.days===Infinity?1e9:a.days)-(b.days===Infinity?1e9:b.days));
  // машины заводим ЗАРАНЕЕ (целые + остаток) и раздаём паллеты каждого кода СРАЗУ ПО ВСЕМ:
  // в приоритете машина, где кода ещё нет, при равенстве — где больше свободного места.
  // Так ассортимент размазан по всем машинам, а не только по первой (см. index.html).
  const nFull=Math.floor(total/PALLETS_PER_TRUCK), rest=total%PALLETS_PER_TRUCK;
  const caps=[]; for(let i=0;i<nFull;i++) caps.push(PALLETS_PER_TRUCK);
  if(rest>0) caps.push(rest);
  const trucks=caps.map(c=>({pallets:0,free:c,items:[]}));
  pool.forEach(it=>{ while(it.left>0){
    let best=null,bestHas=2,bestFree=-1;
    trucks.forEach(t=>{ if(t.free<=0) return;
      const has=t.items.some(x=>x.sup===it.sup)?1:0;
      if(has<bestHas || (has===bestHas && t.free>bestFree)){ best=t; bestHas=has; bestFree=t.free; } });
    if(!best) break;
    const ex=best.items.find(x=>x.sup===it.sup);
    if(ex) ex.pal++; else best.items.push({sup:it.sup,pal:1});
    best.free--; best.pallets++; it.left--; } });
  return {whn,mp,total,trucks,full:trucks.filter(t=>t.pallets>=PALLETS_PER_TRUCK).length,
    tail:trucks.filter(t=>t.pallets<PALLETS_PER_TRUCK).reduce((a,t)=>a+t.pallets,0),codes:items.length};
}).sort((a,b)=>b.total-a.total);
if(plan.length){
  console.log('\nПЛАН МАШИН ('+PALLETS_PER_TRUCK+' паллет, сборка с одного склада на одну площадку):');
  plan.forEach(p=>{ console.log('  '+(p.whn+' → '+p.mp).padEnd(14)+String(p.total).padStart(4)+' палл · '
    +p.full+' маш'+(p.tail? ' + остаток '+p.tail+' палл':'')+' · '+p.codes+' кодов');
    p.trucks.forEach((t,i)=>console.log('      '+(t.pallets>=PALLETS_PER_TRUCK? 'Машина '+(i+1):'Остаток').padEnd(11)
      +t.pallets+' палл · '+t.items.length+' кодов: '+t.items.slice(0,10).map(x=>x.sup+'×'+x.pal).join(', ')
      +(t.items.length>10?' …':''))); });
}
const noPalCnt=needAny.filter(r=>r.noPal).length;
if(noPalCnt) console.log('\nБез вместимости паллеты (везём штуками): '+noPalCnt+' позиций');
if(toShip.length){
  console.log('\nЧТО ОТГРУЗИТЬ НА OZON (топ-'+TOP+' по количеству):');
  console.log('  код 1С    склад   →Озон  Евросиб  Нск-1   ост.   дней Оз   товар');
  toShip.sort((a,b)=>b.shipO-a.shipO).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+String(r.have).padStart(6)+String(r.shipO||'-').padStart(8)
      +String(r.whNsk2).padStart(8)+String(r.whNsk1).padStart(7)+String(r.rest).padStart(7)
      +('  '+D(r.oDays)).padStart(10)+'   '+(r.name||'').slice(0,38)));
}
if(urgent.length){
  console.log('\nСРОЧНО (покрытие меньше '+Math.round(DAYS/3)+' дней):');
  urgent.sort((a,b)=>a.minDays-b.minDays).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+'Оз '+String(D(r.oDays)).padStart(4)+' дн · ВБ '+String(D(r.wDays)).padStart(4)+' дн'
      +' · нужно '+String(r.needO).padStart(6)+' · на складе '+String(r.have).padStart(6)
      +(r.have<=0? (r.china||r.order? '  (едет: '+(r.china?'Китай '+r.china:'')+(r.china&&r.order?' + ':'')+(r.order?'произв. '+r.order:'')+')' : '  (взять негде)') : '')
      +'  '+(r.name||'').slice(0,34)));
}
if(movers.length){
  console.log('\nПЕРЕМЕЩЕНИЕ ЕВРОСИБ → НСК-1 (на Нск-1 нужно '+NSK1_MIN_DAYS+' дней продаж ВБ по FBS):');
  console.log('  код 1С   на Нск-1  дней  переместить  на Евросибе   товар');
  movers.slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+String(r.whNsk1).padStart(8)+String(D(r.nsk1Days)).padStart(6)
      +String(r.move||'нечем').padStart(13)+String(r.whNsk2).padStart(13)+'   '+(r.name||'').slice(0,34)));
}
console.log('\nПодробности и выгрузка — вкладка «Оборачиваемость» → «Подсорт со склада».');
