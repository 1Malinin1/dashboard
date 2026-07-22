// Продлевает REAL_DATA.orderSeries заказами ВБ из подённых выгрузок аналитики
// (лист «Товары»: «Заказали товаров, шт» кол.19; ₽ — «Заказали на сумму» кол.31,
// «Выкупили на сумму» кол.34; ключ «Артикул WB»; дата — из «Общей информации»).
// Строит: bySku (штуки по дням) + money = {дата:{sku:[заказано₽,выкуплено₽]}} по дням из файлов.
// Даты из файлов ПЕРЕЗАПИСЫВАЮТ те же дни; прочие дни сохраняются.
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
  const m=per.match(/(\d{2})-(\d{2})-(\d{4})/); if(!m) throw new Error('нет даты в "'+per+'" ('+f+')');
  const iso=m[3]+'-'+m[2]+'-'+m[1];
  const rows=XLSX.utils.sheet_to_json(wb.Sheets['Товары'],{header:1,raw:false,defval:''});
  // шапка не всегда в row 0: в новом формате row 0 — заголовок отчёта, а шапка в row 1
  // (плюс появился лишний столбец «Артикул продавца» — читаем по ИМЕНИ, так что сдвиг не важен).
  let hr=0; for(let i=0;i<Math.min(8,rows.length);i++){ if(rows[i].map(x=>''+x).indexOf('Артикул WB')>=0){ hr=i; break; } }
  const H=rows[hr].map(x=>''+x),iA=H.indexOf('Артикул WB'),iQ=H.indexOf('Заказали товаров, шт'),
    iOrdR=H.indexOf('Заказали на сумму, ₽'),iBuyR=H.indexOf('Выкупили на сумму, ₽');
  const bySku={},money={};let tot=0,ordR=0,buyR=0;
  for(let i=hr+1;i<rows.length;i++){const sku=(''+rows[i][iA]).trim();if(!catSet.has(sku))continue;
    const q=num(rows[i][iQ]),o=num(rows[i][iOrdR]),b=num(rows[i][iBuyR]);
    bySku[sku]=(bySku[sku]||0)+q; tot+=q;
    if(o||b){ money[sku]=[Math.round(o),Math.round(b)]; ordR+=o; buyR+=b; }
  }
  return {iso,bySku,money,tot,ordR,buyR};
}
const dayData={},dayMoney={};
for(const f of files){const d=readDay(f);dayData[d.iso]=d.bySku;dayMoney[d.iso]=d.money;
  console.log('  '+d.iso+': '+d.tot+' шт · заказано '+Math.round(d.ordR).toLocaleString('ru-RU')+' ₽ · выкуплено '+Math.round(d.buyR).toLocaleString('ru-RU')+' ₽');}
// пересобрать ряд штук
const oldDates=RD.orderSeries.dates, oldBy=RD.orderSeries.bySku, oldIdx={};oldDates.forEach((d,i)=>oldIdx[d]=i);
const newDates=[...new Set([...oldDates,...Object.keys(dayData)])].sort();
const allSkus=new Set([...Object.keys(oldBy), ...Object.values(dayData).flatMap(o=>Object.keys(o))]);
const newBy={};
allSkus.forEach(sku=>{ newBy[sku]=newDates.map(d=>{
  if(dayData[d]) return dayData[d][sku]||0;
  const oi=oldIdx[d]; return (oi!=null && oldBy[sku])? (oldBy[sku][oi]||0) : 0;
}); });
// деньги: сохраняем старые дни (если были), перезаписываем дни из файлов
const money=Object.assign({}, RD.orderSeries.money||{}, dayMoney);
RD.orderSeries={dates:newDates,bySku:newBy,money};
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nРяд заказов ВБ: дней '+newDates.length+' (по '+newDates[newDates.length-1]+') · дней с ₽: '+Object.keys(money).length);
