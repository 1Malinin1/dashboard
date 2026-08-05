// Отчёт «нужен ли подсорт» — считает то же, что вид «Подсорт со склада» в дашборде,
// но в консоли. ЗАПУСКАТЬ ПОСЛЕ ЛЮБОГО ОБНОВЛЕНИЯ ОСТАТКОВ (ВБ, Озон, свой склад) —
// это правило продавца: после каждой заливки он хочет видеть, что и куда отгружать.
//
// Правила (совпадают с index.html):
//   покрытие ВБ   = остаток на складах WB + открытые отгрузки из журнала (REAL_DATA.shipments);
//   покрытие Озон = остаток + ozTransit (заявки и партии, которые показывает сам Озон);
//   продаж/дн     = заказы за 7 дней ÷ 7 × % выкупа;
//   нужно до цели = ceil(продаж/дн × RESUPPLY_DAYS) − покрытие;
//   склада не хватает на обе площадки → ПРИОРИТЕТ ОЗОНУ, ВБ получает остаток.
//
// Использование: node scripts/resupply-report.cjs [дней=30] [сколько строк показать=15]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DAYS=parseInt(process.argv[2],10)||30;
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
const sups=[...new Set([...Object.keys(W),...Object.keys(O),...Object.keys(wh)])];
const rows=sups.map(sup=>{
  const w=W[sup]||zero, o=O[sup]||zero, have=(wh[sup]&&wh[sup].qty)||0;
  const needW=Math.max(0,Math.ceil(w.spd*DAYS)-w.covered);
  const needO=Math.max(0,Math.ceil(o.spd*DAYS)-o.covered);
  let shipO=0,shipW=0; const total=needW+needO;
  if(total<=have){ shipW=needW; shipO=needO; }
  else if(total>0){ shipO=Math.min(needO,have); shipW=Math.min(needW,have-shipO); }   // приоритет Озону
  return {sup,name:(w.name||o.name||sup),have,
    wDays:w.days,oDays:o.days,wSpd:w.spd,oSpd:o.spd,needW,needO,shipW,shipO,
    rest:have-shipW-shipO, china:chinaBy[sup]||0, order:orderBy[sup]||0,
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
console.log('Останется на складе: '+F(rows.reduce((a,r)=>a+r.rest,0))+' шт из '+F(Object.values(wh).reduce((a,v)=>a+v.qty,0)));

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
