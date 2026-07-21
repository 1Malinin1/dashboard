// Собирает блок REAL_DATA.ozon (каталог Озона + заказы по дням) и вписывает его
// в decrypted/wb-data.js. Источники:
//   - каталог: лист «Июль» рабочего файла Озона (Артикул + Наименование + Вид товара);
//   - заказы: decrypted/ozon-orders.json (свод byDateArt из отчётов «Заказы»).
// Артикул Озона = арт. поставщика = WB supplierCode → связка с ВБ (поле wbSku).
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const ROOT=path.join(__dirname,'..'), OUT=path.join(ROOT,'decrypted');
const catalogFile=process.argv[2]; // рабочий файл Озона с листом «Июль»
if(!catalogFile){console.error('usage: node scripts/ozon-build.cjs <файл_с_листом_Июль.xlsx>');process.exit(1);}

// 1) WB каталог → карта supplierCode → sku
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const supToWb={};RD.catalog.forEach(c=>{const s=(''+(c.supplierCode||'')).trim();if(s)supToWb[s]=c.sku;});

// 2) Озон-каталог из листа «Июль»
const wb=XLSX.read(fs.readFileSync(catalogFile),{type:'buffer',cellStyles:false,cellFormula:false});
const rows=XLSX.utils.sheet_to_json(wb.Sheets['Июль'],{header:1,raw:false,defval:''});
const ozCat=[]; const seen=new Set();
for(let i=1;i<rows.length;i++){
  const art=(''+(rows[i][0]||'')).trim(); if(!art||art==='Всего'||seen.has(art)) continue; seen.add(art);
  ozCat.push({sku:art, name:(''+(rows[i][1]||art)).trim(), category:(''+(rows[i][2]||'')).trim()||'Без категории', wbSku:supToWb[art]||null});
}

// 3) Заказы по дням из свода
const ord=JSON.parse(fs.readFileSync(path.join(OUT,'ozon-orders.json'),'utf8'));
const dates=[...new Set(Object.keys(ord.byDateArt).map(k=>k.split('_')[0]))].sort();
const dIdx={};dates.forEach((d,i)=>dIdx[d]=i);
const byArt={};
// добить каталог артикулами, у которых есть заказы, но нет в «Июле»
const artsInOrders=new Set(Object.keys(ord.byDateArt).map(k=>k.slice(11)));
artsInOrders.forEach(a=>{ if(!seen.has(a)){ seen.add(a); ozCat.push({sku:a,name:a,category:'Без категории',wbSku:supToWb[a]||null}); } });
// ряды
ozCat.forEach(c=>{ byArt[c.sku]=new Array(dates.length).fill(0); });
Object.entries(ord.byDateArt).forEach(([k,q])=>{ const d=k.slice(0,10),a=k.slice(11); if(!byArt[a]) byArt[a]=new Array(dates.length).fill(0); byArt[a][dIdx[d]]=q; });

RD.ozon={
  catalog:ozCat,
  orderSeries:{dates,byArt},
  ordersMeta:{period:dates[0]+'…'+dates[dates.length-1], totalOrdered:ord.statuses?Object.values(ord.statuses).reduce((a,b)=>a+b,0):0, cancelled:(ord.statuses&&ord.statuses['Отменён'])||0}
};

// 4) переписать wb-data.js
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const linked=ozCat.filter(c=>c.wbSku).length;
console.log('REAL_DATA.ozon собран:');
console.log('  каталог Озона:',ozCat.length,'товаров · связано с ВБ по арт.поставщика:',linked,'· без связки:',ozCat.length-linked);
console.log('  заказы: дней',dates.length,'('+dates[0]+'…'+dates[dates.length-1]+') · артикулов с рядами:',Object.keys(byArt).length);
console.log('  всего заказано (все статусы):',RD.ozon.ordersMeta.totalOrdered,'· отмен:',RD.ozon.ordersMeta.cancelled);
console.log('  товаров с хотя бы одним заказом:',ozCat.filter(c=>byArt[c.sku].some(x=>x>0)).length);
