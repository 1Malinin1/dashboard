// Генерит decrypted/паллеты-заполнить.xlsx — коды 1С, по которым НЕТ вместимости паллеты.
// Без неё товар не переводится в паллеты и не попадает в машины, поэтому едет «штуками».
// Сортировка — по важности: сначала то, что требует подсорта и лежит на складе.
// Отдать продавцу на заполнение → потом node scripts/update-pallets.cjs <файл>.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const DAYS=30, LAUNCH=500;
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const S=v=>(''+(v==null?'':v)).trim();

// продажи/покрытие по площадкам — как в подсорте
function mpStats(mp){
  const oz=mp==='ozon';
  const cat=oz? ((RD.ozon&&RD.ozon.catalog)||[]) : RD.catalog;
  const ser=oz? ((RD.ozon&&RD.ozon.orderSeries&&RD.ozon.orderSeries.byArt)||{}) : RD.orderSeries.bySku;
  const dates=oz? ((RD.ozon&&RD.ozon.orderSeries&&RD.ozon.orderSeries.dates)||[]) : RD.orderSeries.dates;
  const last=dates.length-1, days=Math.min(7,dates.length);
  const buyAvg= oz? ((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutAll)||1)
    : (()=>{const v=RD.catalog.map(c=>c.buyoutPct14d).filter(x=>x>0);return v.length? v.reduce((a,b)=>a+b,0)/v.length/100:1;})();
  const out={};
  cat.forEach(c=>{ const sup= oz? S(c.sku) : S(c.supplierCode); if(!sup) return;
    const s=ser[c.sku]; let sum=0; if(s) for(let i=Math.max(0,last-6);i<=last;i++) sum+=s[i]||0;
    const buyout= oz? (c.ozBuyout!=null?c.ozBuyout:buyAvg) : (c.buyoutPct14d>0? c.buyoutPct14d/100 : buyAvg);
    const stock= oz? (c.ozStock||0) : ((c.wbStock||0)+(c.ownWarehouseStock||0));
    const transit= oz? (c.ozTransit||0) : 0;
    const e=out[sup]||(out[sup]={spd:0,cov:0}); e.spd+=(days? sum/days:0)*buyout; e.cov+=stock+transit; });
  return out;
}
const W=mpStats('wb'), O=mpStats('ozon');
const wh=(RD.warehouse&&RD.warehouse.bySup)||{};
const pal=(RD.pallets&&RD.pallets.bySup)||{};
const wbBySup={}; RD.catalog.forEach(c=>{const s=S(c.supplierCode); if(s&&!wbBySup[s]) wbBySup[s]=c;});
const ozSet=new Set(((RD.ozon&&RD.ozon.catalog)||[]).map(c=>S(c.sku)));

const rows=[];
Object.keys(wbBySup).forEach(sup=>{
  if(pal[sup]) return;                                  // вместимость уже есть
  const c=wbBySup[sup], w=W[sup]||{spd:0,cov:0}, o=O[sup]||{spd:0,cov:0};
  const have=(wh[sup]&&wh[sup].qty)||0;
  const needW = (w.spd<=0&&w.cov<=0&&have>0)? Math.min(LAUNCH,have) : Math.max(0,Math.ceil(w.spd*DAYS)-w.cov);
  const needO = (o.spd<=0&&o.cov<=0&&have>0)? Math.min(LAUNCH,have) : Math.max(0,Math.ceil(o.spd*DAYS)-o.cov);
  const need=needW+needO;
  const why = (need>0&&have>0)? "НУЖЕН ПОДСОРТ — есть на складе"
    : (need>0)? "нужен подсорт, но склад пуст"
    : (have>0)? "лежит на складе" : (w.spd+o.spd>0? "продаётся" : "нет движения");
  const rank = (need>0&&have>0)? 0 : (need>0? 1 : (have>0? 2 : (w.spd+o.spd>0? 3 : 4)));
  rows.push({sup, sku:c.sku, ozSku:(ozSet.has(sup)? sup:""), name:c.name||"", cat:c.category||"",
    factory:S(c.factoryCode), status:S(c.productionStatus), have, needW, needO, need,
    spdW:+w.spd.toFixed(2), spdO:+o.spd.toFixed(2), why, rank});
});
rows.sort((a,b)=> a.rank-b.rank || b.need-a.need || b.have-a.have);

const head=["Код 1С","Артикул ВБ","Артикул Ozon","Название","Категория","Код фабрики","Статус товара",
  "На складе, шт","Нужно на ВБ, шт","Нужно на Ozon, шт","Продаж/дн ВБ","Продаж/дн Ozon","Почему важно",
  "Вместительность на паллете Озон","Вместительность на паллете Вб"];
const data=[head, ...rows.map(r=>[r.sup,r.sku,r.ozSku,r.name,r.cat,r.factory,r.status,
  r.have,r.needW||"",r.needO||"",r.spdW||"",r.spdO||"",r.why,"",""])];
const ws=XLSX.utils.aoa_to_sheet(data);
ws['!cols']=[{wch:11},{wch:13},{wch:13},{wch:46},{wch:20},{wch:14},{wch:13},{wch:13},{wch:15},{wch:16},
  {wch:13},{wch:14},{wch:32},{wch:30},{wch:30}];
const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Заполнить паллеты");
const file=path.join(OUT,'паллеты-заполнить.xlsx');
XLSX.writeFile(wb,file);

const grp={}; rows.forEach(r=>grp[r.why]=(grp[r.why]||0)+1);
console.log('Без вместимости паллеты: '+rows.length+' кодов 1С (из '+Object.keys(wbBySup).length+' в каталоге)');
Object.entries(grp).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+k+': '+v));
console.log('\nТоп-15 по важности:');
rows.slice(0,15).forEach(r=>console.log('  '+r.sup.padEnd(9)+'склад '+String(r.have).padStart(6)
  +' · нужно '+String(r.need).padStart(5)+'  '+r.why.padEnd(32)+' '+r.name.slice(0,34)));
console.log('\nФайл: '+file);
