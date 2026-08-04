// Обновляет справочные поля каталога ВБ из рабочего файла продавца:
//   «Артикул Wb» · «код поставщика» (= supplierCode, он же артикул 1С) ·
//   «код фабрики» (→ factoryCode) · «Статус» (→ productionStatus).
// Ключ — «Артикул Wb». `supplierCode` НЕ перезаписываем, только сверяем: он связывает
// товар с Озоном (арт. Озона = supplierCode), тихая правка порвала бы связку.
// Статус нормализуем по регистру («на вывод»/«На вывод» → «На вывод»).
//
// Использование: node scripts/update-catalog-meta.cjs <файл.xlsx> [имя_листа]
// Дальше: node scripts/encrypt.cjs <код> && git add wb-secure.js
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2], sheetArg=process.argv[3];
if(!file){console.error('usage: node scripts/update-catalog-meta.cjs <файл.xlsx> [лист]');process.exit(1);}

const S=v=>(''+(v==null?'':v)).replace(/\s+/g,' ').trim();
// «на вывод» → «На вывод», «в работе» → «В работе», «новинка» → «Новинка»
const normStatus=s=>{ s=S(s); return s? s[0].toUpperCase()+s.slice(1).toLowerCase() : ''; };

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, bySku={}; RD.catalog.forEach(c=>bySku[''+c.sku]=c);

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const sheet=sheetArg||wb.SheetNames[0];
const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,raw:false,defval:''});
// колонки ищем по имени — в рабочих файлах порядок и регистр плавают
const H=(rows[0]||[]).map(x=>S(x).toLowerCase());
const find=(...names)=>{ for(const n of names){ const i=H.findIndex(h=>h.includes(n)); if(i>=0) return i; } return -1; };
const iSku=find('артикул wb','артикул вб'), iSup=find('код поставщика','поставщик'),
      iFac=find('код фабрики','фабрик'), iSt=find('статус');
if(iSku<0){ console.error('не нашёл колонку «Артикул Wb» (шапка: '+H.join(' | ')+')'); process.exit(1); }
console.log('лист «'+sheet+'» · колонки: артикул '+iSku+' · поставщик '+iSup+' · фабрика '+iFac+' · статус '+iSt);

let seen=0, notFound=[], supMismatch=[], facNew=0, facChanged=[], stNew=0, stChanged=[], stCounts={};
for(let i=1;i<rows.length;i++){
  const r=rows[i], sku=S(r[iSku]); if(!sku) continue;
  const c=bySku[sku]; if(!c){ notFound.push(sku); continue; }
  seen++;
  if(iSup>=0){ const sup=S(r[iSup]), cur=S(c.supplierCode);
    if(sup && cur && sup!==cur) supMismatch.push(sku+': каталог '+cur+' ≠ файл '+sup);
    if(sup && !cur) c.supplierCode=sup; }              // проставляем только если пусто
  if(iFac>=0){ const fac=S(r[iFac]), cur=S(c.factoryCode);
    if(fac && !cur){ c.factoryCode=fac; facNew++; }
    else if(fac && fac!==cur){ facChanged.push(sku+': '+cur+' → '+fac); c.factoryCode=fac; } }
  if(iSt>=0){ const st=normStatus(r[iSt]), cur=S(c.productionStatus);
    if(st){ stCounts[st]=(stCounts[st]||0)+1;
      if(!cur){ c.productionStatus=st; stNew++; }
      else if(st!==cur){ stChanged.push(sku+': '+cur+' → '+st); c.productionStatus=st; } } }
}

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('\nОбработано строк файла: '+seen+' · нет в каталоге: '+notFound.length+(notFound.length?' ('+notFound.slice(0,10).join(', ')+(notFound.length>10?' …':'')+')':''));
console.log('Код фабрики: заполнен впервые '+facNew+' · изменён '+facChanged.length);
facChanged.slice(0,15).forEach(x=>console.log('   '+x));
console.log('Статус: проставлен впервые '+stNew+' · изменён '+stChanged.length+' · в файле: '+JSON.stringify(stCounts));
console.log('Расхождений по коду поставщика: '+supMismatch.length);
supMismatch.slice(0,10).forEach(x=>console.log('   '+x));

const inFile=new Set(); for(let i=1;i<rows.length;i++){ const s=S(rows[i][iSku]); if(s) inFile.add(s); }
const missing=RD.catalog.filter(c=>!inFile.has(''+c.sku));
console.log('\nВ каталоге, но НЕ в файле: '+missing.length);
missing.forEach(c=>console.log('   '+c.sku+' · 1С '+(c.supplierCode||'—')+' · статус '+(c.productionStatus||'—')+' · '+c.name));
const tot={}; RD.catalog.forEach(c=>{ const s=S(c.productionStatus)||'(не задан)'; tot[s]=(tot[s]||0)+1; });
console.log('\nИтог по каталогу ('+RD.catalog.length+' товаров): '+JSON.stringify(tot));
console.log('Код фабрики заполнен у '+RD.catalog.filter(c=>S(c.factoryCode)).length+' товаров');
