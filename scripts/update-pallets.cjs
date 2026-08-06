// Заливает вместимость паллеты в REAL_DATA.pallets из файла продавца.
// Отгрузка со своего склада на площадку идёт ТОЛЬКО кратно паллете, а паллеты собираются
// в машину (33 паллеты) и только с ОДНОГО склада — отсюда расчёт в подсорте.
// Вместимость у ВБ и Озона РАЗНАЯ, поэтому в файле две колонки.
//
// Лист с данными ищем по шапке: ключ («Код 1С»/«Артикул»/«Код») + «…паллете Озон» + «…паллете Вб».
// Файл можно слать частями — вместимости МЕРЖАТСЯ в снимок, а не заменяют его целиком.
// Ключ — арт. поставщика (код 1С), в 1С печатается с разделителем разрядов («512,190»).
//
// Использование: node scripts/update-pallets.cjs <файл.xls> [дата]
// Дальше: node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2], dateArg=process.argv[3]||new Date().toISOString().slice(0,10);
if(!file){console.error('usage: node scripts/update-pallets.cjs <файл.xls> [ГГГГ-ММ-ДД]');process.exit(1);}

const S=v=>(''+(v==null?'':v)).replace(/ /g,' ').replace(/\s+/g,' ').trim();
const code=v=>S(v).replace(/[\s ,]/g,'');
const num=v=>{ const s=S(v).replace(/[\s ]/g,'').replace(/,/g,''); if(!s) return 0;
  const n=parseFloat(s); return isNaN(n)?0:n; };

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const supSet=new Set(RD.catalog.map(c=>S(c.supplierCode)).filter(Boolean));
const nameBySup={}; RD.catalog.forEach(c=>{const s=S(c.supplierCode); if(s&&!nameBySup[s]) nameBySup[s]=c.name;});

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
let rows=null, hr=-1, iKey=-1, iOz=-1, iWb=-1, sheetName='';
for(const sh of wb.SheetNames){
  const r=XLSX.utils.sheet_to_json(wb.Sheets[sh],{header:1,raw:false,defval:''});
  for(let i=0;i<Math.min(10,r.length);i++){
    const H=(r[i]||[]).map(x=>S(x).toLowerCase());
    // ключ ищем по приоритету: «Код 1С» (наш отчёт на заполнение) → «Артикул» → «Код» →
    // «код поставщика». Важно не схватить «Артикул ВБ»/«Артикул Ozon» из нашего же файла.
    let k=-1;
    for(const re of [/^код 1с$/,/^артикул$/,/^код$/,/код поставщ/]){ k=H.findIndex(x=>re.test(x)); if(k>=0) break; }
    const o=H.findIndex(x=>/паллет/.test(x)&&/озон|ozon/.test(x));
    const w=H.findIndex(x=>/паллет/.test(x)&&/вб|wildberries|wb/.test(x));
    if(k>=0&&o>=0&&w>=0){ rows=r; hr=i; iKey=k; iOz=o; iWb=w; sheetName=sh; break; }
  }
  if(rows) break;
}
if(!rows){ console.error('не нашёл лист с колонками «Артикул» + «паллет Озон» + «паллет Вб»'); process.exit(1); }
console.log('лист «'+sheetName+'» · шапка в строке '+(hr+1)+' · колонки: ключ '+iKey+' · Озон '+iOz+' · ВБ '+iWb);

const bySup={}; let taken=0, unknown=[], noQty=[];
for(let i=hr+1;i<rows.length;i++){
  const r=rows[i]; const k=code(r[iKey]);
  if(!k||!/^\d+$/.test(k)) continue;
  const oz=num(r[iOz]), w=num(r[iWb]);
  if(!supSet.has(k)){ if(oz||w) unknown.push(k); continue; }
  if(!oz && !w){ noQty.push(k); continue; }
  bySup[k]={wb:w||0, oz:oz||0};
  taken++;
}
// МЕРЖ, а не замена: продавец присылает файл частями (сначала общий, потом «дозаполненные»
// коды). Полная замена стёрла бы уже загруженные вместимости.
const prev=(RD.pallets&&RD.pallets.bySup)||{};
let updated=0, kept=0;
Object.keys(prev).forEach(k=>{ if(!bySup[k]){ bySup[k]=prev[k]; kept++; }
  else if(prev[k].wb!==bySup[k].wb||prev[k].oz!==bySup[k].oz) updated++; });
RD.pallets={date:dateArg, bySup};
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('\nВместимость паллеты на '+dateArg+': из файла '+taken+' позиций · было раньше и сохранено '+kept
  +' · изменено '+updated+' · ИТОГО в снимке '+Object.keys(bySup).length);
console.log('  без вместимости в файле (пропущено): '+noQty.length+(noQty.length?' · '+noQty.slice(0,12).join(', ')+(noQty.length>12?' …':''):''));
console.log('  кодов не из нашего каталога: '+unknown.length);
// сколько наших товаров осталось без паллеты — по ним подсорт не переведётся в паллеты
const missing=RD.catalog.filter(c=>{const s=S(c.supplierCode); return s && !bySup[s];});
const uniqMissing=[...new Set(missing.map(c=>S(c.supplierCode)))];
console.log('  БЕЗ вместимости паллеты в каталоге: '+uniqMissing.length+' кодов 1С');
const dif=Object.entries(bySup).filter(([,v])=>v.wb&&v.oz&&v.wb!==v.oz).length;
console.log('  вместимость ВБ ≠ Озон у '+dif+' позиций (у остальных совпадает)');
console.log('\nПримеры:');
Object.entries(bySup).slice(0,8).forEach(([k,v])=>console.log('   1С '+k+' · паллета ВБ '+v.wb+' · Озон '+v.oz+'  · '+(nameBySup[k]||'').slice(0,38)));
console.log('\nДальше: node scripts/encrypt.cjs <код>');
