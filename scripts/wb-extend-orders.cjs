// Продлевает REAL_DATA.orderSeries заказами ВБ из подённых выгрузок аналитики
// (лист «Товары»: «Заказали товаров, шт» кол.19; ₽ — «Заказали на сумму» кол.31,
// «Выкупили на сумму» кол.34; ключ «Артикул WB»; дата — из «Общей информации»).
// Строит: bySku (штуки по дням) + money = {дата:{sku:[заказано₽,выкуплено₽]}} по дням из файлов.
// Даты из файлов ПЕРЕЗАПИСЫВАЮТ те же дни; прочие дни сохраняются.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
let _av=process.argv.slice(2);
const _di=_av.indexOf('--date'); let DATE_ARG=null;
if(_di>=0){ DATE_ARG=_av[_di+1]; _av.splice(_di,2); }
const files=_av;
if(!files.length){console.error('usage: node scripts/wb-extend-orders.cjs [--date ГГГГ-ММ-ДД] <день1.xlsx> ...');process.exit(1);}
if(DATE_ARG && !/^\d{4}-\d{2}-\d{2}$/.test(DATE_ARG)){console.error('--date в формате ГГГГ-ММ-ДД');process.exit(1);}
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const catSet=new Set(RD.catalog.map(x=>x.sku));
function num(v){const n=parseFloat((''+v).replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n;}
// Ищет лист детального отчёта воронки: в шапке должны быть и «Артикул WB», и «Заказали
// товаров, шт». Лист «Промосервисы …» тоже содержит «Заказали товаров, шт», но в нём нет
// «Показы» — поэтому дополнительно требуем «Показы», чтобы не взять его по ошибке.
function findSheet(wb){
  for(const name of wb.SheetNames){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:false,defval:''});
    for(let i=0;i<Math.min(8,rows.length);i++){
      const H=(rows[i]||[]).map(x=>''+x);
      if(H.indexOf('Артикул WB')>=0 && H.indexOf('Показы')>=0) return {rows,hr:i,name};
    }
  }
  return {rows:null,hr:0,name:null};
}
/* ДАТА ДНЯ. Обычная подённая выгрузка несёт её на листе «Общая информация». Но продавец
   иногда шлёт ТОТ ЖЕ день в раскладке сводного отчёта (один лист «Товары», колонки
   «… (предыдущий период)») — там этого листа нет вовсе. Тогда берём дату из имени файла:
   в нём стоят начало и конец периода (ДДММГГГГ). Принимаем ТОЛЬКО если они совпадают —
   иначе это отчёт за диапазон, и раскидать его по дням нельзя; в таком случае просим --date.
   Колонки в обеих раскладках ищутся ПО ИМЕНИ, поэтому сам разбор одинаков. */
function dateFromName(f){
  const b=path.basename(f); const all=[...b.matchAll(/(\d{2})(\d{2})(20\d{2})/g)].map(m=>m[3]+'-'+m[2]+'-'+m[1]);
  if(!all.length) return null;
  const uniq=[...new Set(all)];
  return uniq.length===1? uniq[0] : null;
}
function readDay(f){
  const wb=XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false});
  let iso=DATE_ARG||null;
  if(!iso && wb.Sheets['Общая информация']){
    const oi=XLSX.utils.sheet_to_json(wb.Sheets['Общая информация'],{header:1,raw:false,defval:''});
    let per='';oi.forEach(r=>{ if((''+r[0]).toLowerCase().includes('текущий')) per=''+r[1]; });
    const m=per.match(/(\d{2})-(\d{2})-(\d{4})/); if(m) iso=m[3]+'-'+m[2]+'-'+m[1];
  }
  if(!iso){ iso=dateFromName(f);
    if(iso) console.log('  (дата взята из имени файла: '+iso+' — листа «Общая информация» в выгрузке нет)'); }
  if(!iso) throw new Error('не удалось определить дату для '+path.basename(f)
    +' — нет листа «Общая информация», и в имени файла даты периода не совпадают. Укажите --date ГГГГ-ММ-ДД');
  // Лист с товарами ищем ПО СОДЕРЖИМОМУ, а не по имени: он называется «Товары», но если
  // выгрузка отфильтрована по бренду — «Vulpes» (и «Промосервисы Vulpes» рядом, его надо
  // пропустить — там нет «Показы»). Берём первый лист, где в шапке есть «Артикул WB».
  const {rows,hr}=findSheet(wb);
  if(!rows) throw new Error('не нашёл лист с колонкой «Артикул WB» в '+f+' (листы: '+wb.SheetNames.join(', ')+')');
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
