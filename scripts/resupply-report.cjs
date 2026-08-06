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
const F=n=>Math.round(n).toLocaleString('ru-RU');
const D=v=>v===Infinity?'∞':Math.round(v);

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
    const buyout = oz? (c.ozBuyout!=null?c.ozBuyout:buyAvg) : (c.buyoutPct14d>0? c.buyoutPct14d/100 : buyAvg);
    const stock = oz? (c.ozStock||0) : ((c.wbStock||0)+(c.ownWarehouseStock||0));
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
// «На вывод» исключаем из подсорта целиком (просьба продавца): товар выводится из
// ассортимента, везти его на площадку незачем. Считаем по ВСЕМ карточкам кода 1С —
// если хоть одна НЕ «На вывод», товар живой. В дозаказе/закупе статус по-прежнему справочный.
const outSup=new Set(); {
  const st={}; (RD.catalog||[]).forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(!s) return;
    const out=(''+(c.productionStatus||'')).trim()==='На вывод';
    st[s]=(st[s]===undefined)? out : (st[s]&&out); });
  Object.keys(st).forEach(s=>{ if(st[s]) outSup.add(s); });
}
const sups=[...new Set([...Object.keys(W),...Object.keys(O),...Object.keys(wh)])].filter(s=>!outSup.has(s));
const rows=sups.map(sup=>{
  const w=W[sup]||zero, o=O[sup]||zero, have=(wh[sup]&&wh[sup].qty)||0;
  const launchW = w.spd<=0 && w.covered<=0 && have>0, launchO = o.spd<=0 && o.covered<=0 && have>0;
  const needW=launchW? Math.min(LAUNCH_QTY,have) : Math.max(0,Math.ceil(w.spd*DAYS)-w.covered);
  const needO=launchO? Math.min(LAUNCH_QTY,have) : Math.max(0,Math.ceil(o.spd*DAYS)-o.covered);
  // отгрузка целыми паллетами: сначала Озон (приоритет), из остатка склада — ВБ
  const whB=(wh[sup]&&wh[sup].wh)||{}; let mMsk=0,mNsk=0;
  Object.entries(whB).forEach(([n,q])=>{ if(/солнечногор/i.test(n)) mMsk+=q; else if(/евросиб/i.test(n)) mNsk+=q; });
  const P=PAL[sup]||null, palOz=P?(P.oz||0):0, palWb=P?(P.wb||0):0;
  let rMsk=mMsk, rNsk=mNsk;
  const take=(needQty,cap,up)=>{ if(cap<=0) return null;
    const want=up? Math.ceil(needQty/cap) : Math.floor(needQty/cap);
    if(want<=0) return {pal:0,msk:0,nsk:0,qty:0};
    const a=Math.min(want,Math.floor(rMsk/cap)), b=Math.min(want-a,Math.floor(rNsk/cap));
    rMsk-=a*cap; rNsk-=b*cap; return {pal:a+b,msk:a,nsk:b,qty:(a+b)*cap}; };
  let shipO=0,shipW=0,palO=0,palW=0,oM=0,oN=0,wM=0,wN=0;
  const tO=take(needO,palOz,launchO);
  if(tO){ palO=tO.pal; shipO=tO.qty; oM=tO.msk; oN=tO.nsk; }
  else { shipO=Math.min(needO,rMsk+rNsk); const f=Math.min(shipO,rMsk); rMsk-=f; rNsk-=(shipO-f); }
  const tW=take(needW,palWb,launchW);
  if(tW){ palW=tW.pal; shipW=tW.qty; wM=tW.msk; wN=tW.nsk; }
  else { shipW=Math.min(needW,rMsk+rNsk); const f=Math.min(shipW,rMsk); rMsk-=f; rNsk-=(shipW-f); }
  return {sup,name:(w.name||o.name||sup),have,palOz,palWb,palO,palW,oM,oN,wM,wN,
    noPal:(!P&&(needW+needO>0)),
    wDays:w.days,oDays:o.days,wSpd:w.spd,oSpd:o.spd,needW,needO,shipW,shipO,
    rest:have-shipW-shipO, china:chinaBy[sup]||0, order:orderBy[sup]||0, launch:(launchW||launchO),
    minDays:Math.min(w.spd>0?w.days:Infinity,o.spd>0?o.days:Infinity)};
}).filter(r=>r.needW>0||r.needO>0||r.have>0);

const needAny=rows.filter(r=>r.needW+r.needO>0);
const toShip=rows.filter(r=>r.shipW+r.shipO>0);
const noStock=needAny.filter(r=>r.have<=0);
const urgent=needAny.filter(r=>r.minDays<DAYS/3);

console.log('ПОДСОРТ НА '+DAYS+' ДНЕЙ · остатки ВБ на '+((RD.meta&&RD.meta.stockSnapshotDate)||'—')
  +' · Озон на '+((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.stockDate)||'—')
  +' · склад на '+((RD.warehouse&&RD.warehouse.date)||'не загружен'));
console.log('─'.repeat(96));
console.log('Требуют подсорта: '+needAny.length+' позиций (из них СРОЧНО, покрытие < '+Math.round(DAYS/3)+' дн: '+urgent.length+')');
console.log('К отгрузке со склада: '+F(toShip.reduce((a,r)=>a+r.shipW+r.shipO,0))+' шт'
  +'  ·  на Озон '+F(rows.reduce((a,r)=>a+r.shipO,0))+'  ·  на ВБ '+F(rows.reduce((a,r)=>a+r.shipW,0)));
console.log('Нечем закрыть (на складе пусто): '+noStock.length+' позиций, не хватает '
  +F(noStock.reduce((a,r)=>a+r.needW+r.needO,0))+' шт');
const launches=needAny.filter(r=>r.launch);
if(launches.length) console.log('Стартовые партии (товара нет на площадке): '+launches.length+' позиций · '
  +F(launches.reduce((a,r)=>a+r.shipW+r.shipO,0))+' шт');
console.log('Останется на складе: '+F(rows.reduce((a,r)=>a+r.rest,0))+' шт из '+F(Object.values(wh).reduce((a,v)=>a+v.qty,0)));

// ---- план машин: паллеты по (склад × площадка), машина = 33 паллеты, ассортимент round-robin ----
const buckets={};
const addB=(whn,mp,r,pal,days)=>{ if(pal<=0) return; const k=whn+'|'+mp;
  (buckets[k]||(buckets[k]=[])).push({sup:r.sup,name:r.name,pal,days}); };
rows.forEach(r=>{ addB('Мск','Ozon',r,r.oM,r.oDays); addB('Нск','Ozon',r,r.oN,r.oDays);
                  addB('Мск','ВБ',r,r.wM,r.wDays);  addB('Нск','ВБ',r,r.wN,r.wDays); });
const plan=Object.entries(buckets).map(([k,items])=>{
  const [whn,mp]=k.split('|'); const total=items.reduce((a,x)=>a+x.pal,0);
  const pool=items.map(x=>({...x,left:x.pal})).sort((a,b)=>(a.days===Infinity?1e9:a.days)-(b.days===Infinity?1e9:b.days));
  const trucks=[]; let cur=[],cp=0;
  const flush=()=>{ if(cp>0) trucks.push({pallets:cp,items:cur}); cur=[];cp=0; };
  while(pool.some(x=>x.left>0)){ let any=false;
    for(const it of pool){ if(it.left<=0) continue; if(cp>=PALLETS_PER_TRUCK) flush();
      const ex=cur.find(c=>c.sup===it.sup); if(ex) ex.pal++; else cur.push({sup:it.sup,pal:1});
      it.left--; cp++; any=true; }
    if(!any) break; }
  flush();
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
  console.log('\nЧТО ОТГРУЗИТЬ (топ-'+TOP+' по количеству):');
  console.log('  код 1С    склад   →Озон    →ВБ   ост.   дней Оз/ВБ   товар');
  toShip.sort((a,b)=>(b.shipW+b.shipO)-(a.shipW+a.shipO)).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+String(r.have).padStart(6)+String(r.shipO||'-').padStart(8)
      +String(r.shipW||'-').padStart(7)+String(r.rest).padStart(7)
      +('  '+D(r.oDays)+'/'+D(r.wDays)).padStart(12)+'   '+(r.name||'').slice(0,40)));
}
if(urgent.length){
  console.log('\nСРОЧНО (покрытие меньше '+Math.round(DAYS/3)+' дней):');
  urgent.sort((a,b)=>a.minDays-b.minDays).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+'Оз '+String(D(r.oDays)).padStart(4)+' дн · ВБ '+String(D(r.wDays)).padStart(4)+' дн'
      +' · нужно '+String(r.needW+r.needO).padStart(6)+' · на складе '+String(r.have).padStart(6)
      +(r.have<=0? (r.china||r.order? '  (едет: '+(r.china?'Китай '+r.china:'')+(r.china&&r.order?' + ':'')+(r.order?'произв. '+r.order:'')+')' : '  (взять негде)') : '')
      +'  '+(r.name||'').slice(0,34)));
}
console.log('\nПодробности и выгрузка — вкладка «Оборачиваемость» → «Подсорт со склада».');
