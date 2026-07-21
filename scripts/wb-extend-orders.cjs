// Продлевает REAL_DATA.orderSeries заказами ВБ из подённых выгрузок аналитики
// (лист «Товары», колонка «Заказали товаров, шт», ключ «Артикул WB»; дата — из
// листа «Общая информация», строка «...текущий период» → «С DD-MM-YYYY ...»).
// Даты из файлов ПЕРЕЗАПИСЫВАЮТ те же даты ряда; прочие дни сохраняются.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const files=process.argv.slice(2);
if(!files.length){console.error('usage: node scripts/wb-extend-orders.cjs <день1.xlsx> ...');process.exit(1);}
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const catSet=new Set(RD.catalog.map(x=>x.sku));
function num(v){const n=parseFloat((''+v).replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n;}
function readDay(f){
  const wb=XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false});
  const oi=XLSX.utils.sheet_to_json(wb.Sheets['Общая информация'],{header:1,raw:false,defval:''});
  let per='';oi.forEach(r=>{ if((''+r[0]).toLowerCase().includes('текущий')) per=''+r[1]; });
  const m=per.match(/(\d{2})-(\d{2})-(\d{4})/); if(!m) throw new Error('не нашёл дату в "'+per+'" ('+f+')');
  const iso=m[3]+'-'+m[2]+'-'+m[1];
  const rows=XLSX.utils.sheet_to_json(wb.Sheets['Товары'],{header:1,raw:false,defval:''});
  const H=rows[0],iA=H.indexOf('Артикул WB'),iO=H.indexOf('Заказали товаров, шт');
  const bySku={};let tot=0;
  for(let i=1;i<rows.length;i++){const sku=(''+rows[i][iA]).trim();if(!catSet.has(sku))continue;const q=num(rows[i][iO]);bySku[sku]=(bySku[sku]||0)+q;tot+=q;}
  return {iso,bySku,tot};
}
const dayData={};
for(const f of files){const d=readDay(f);dayData[d.iso]=d.bySku;console.log('  '+d.iso+': заказано '+d.tot+' шт ('+Object.keys(d.bySku).length+' арт.)');}
// пересобрать ряд
const oldDates=RD.orderSeries.dates, oldBy=RD.orderSeries.bySku, oldIdx={};oldDates.forEach((d,i)=>oldIdx[d]=i);
const newDates=[...new Set([...oldDates,...Object.keys(dayData)])].sort();
const allSkus=new Set([...Object.keys(oldBy), ...Object.values(dayData).flatMap(o=>Object.keys(o))]);
const newBy={};
allSkus.forEach(sku=>{ newBy[sku]=newDates.map(d=>{
  if(dayData[d]) return dayData[d][sku]||0;                 // обновлённый день — из файла
  const oi=oldIdx[d]; return (oi!=null && oldBy[sku])? (oldBy[sku][oi]||0) : 0;  // старый день
}); });
RD.orderSeries={dates:newDates,bySku:newBy};
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nРяд заказов ВБ: дней '+newDates.length+' (по '+newDates[newDates.length-1]+'), было по '+oldDates[oldDates.length-1]);
