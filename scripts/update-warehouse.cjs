// Заливает остатки СВОЕГО склада продавца в REAL_DATA.warehouse.
// Это отдельный слой: в покрытие площадок он НЕ входит (см. simpleTurnList) — из него
// считается подсорт «куда и сколько отгрузить», чтобы держать на ВБ/Озоне ≥30 дней запаса.
//
// Колонки ищутся ПО ИМЕНИ (порядок в рабочих файлах плавает):
//   ключ   — «код»/«код поставщика»/«арт»/«артикул» (это арт. поставщика = код 1С = артикул Озона);
//   кол-во — «кол-во»/«количество»/«остаток»/«итог».
// Если в файле ДВЕ колонки количества с пометкой площадки («вб»/«озон») — читаем обе,
// тогда товар уже физически разделён и подсорт считается по каждой площадке отдельно.
//
// Использование: node scripts/update-warehouse.cjs <файл.xlsx> [лист] [дата]
// Дальше: node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2];
let sheetArg=process.argv[3], dateArg=process.argv[4];
if(sheetArg && /^\d{4}-\d{2}-\d{2}$/.test(sheetArg)){ dateArg=sheetArg; sheetArg=null; }
if(!file){console.error('usage: node scripts/update-warehouse.cjs <файл.xlsx> [лист] [ГГГГ-ММ-ДД]');process.exit(1);}

const S=v=>(''+(v==null?'':v)).replace(/\s+/g,' ').trim();
const num=v=>{ let s=S(v).replace(/[\s ]/g,''); if(!s) return 0;
  if(s.includes(',')&&s.includes('.')) s=s.replace(/,/g,''); else if(s.includes(',')) s=s.replace(',','.');
  const n=parseFloat(s); return isNaN(n)?0:n; };

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const supSet=new Set(RD.catalog.map(c=>S(c.supplierCode)).filter(Boolean));
const nameBySup={}; RD.catalog.forEach(c=>{ const s=S(c.supplierCode); if(s&&!nameBySup[s]) nameBySup[s]=c.name; });

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const sheet=sheetArg||wb.SheetNames[0];
if(!wb.Sheets[sheet]){console.error('нет листа «'+sheet+'» (есть: '+wb.SheetNames.join(', ')+')');process.exit(1);}
const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,raw:false,defval:''});
// шапка — первая строка, где есть и ключ, и количество
let hr=-1,H=[];
for(let i=0;i<Math.min(8,rows.length);i++){
  const h=(rows[i]||[]).map(x=>S(x).toLowerCase());
  const k=h.findIndex(x=>/^код|поставщик|^арт|артикул/.test(x));
  const q=h.findIndex(x=>/кол-?во|количест|остат|итог/.test(x));
  if(k>=0&&q>=0){ hr=i; H=h; break; }
}
if(hr<0){console.error('не нашёл шапку с колонками ключа и количества. Первая строка: '+JSON.stringify(rows[0]));process.exit(1);}
const iKey=H.findIndex(x=>/^код|поставщик|^арт|артикул/.test(x));
const qCols=[]; H.forEach((h,i)=>{ if(/кол-?во|количест|остат|итог/.test(h)) qCols.push({i,h}); });
const iWb=(qCols.find(c=>/вб|wb/.test(c.h))||{}).i;
const iOz=(qCols.find(c=>/озон|ozon/.test(c.h))||{}).i;
const split = iWb!=null && iOz!=null;
const iAll = split? null : qCols[0].i;
console.log('лист «'+sheet+'» · шапка в строке '+(hr+1)+' · ключ: «'+rows[hr][iKey]+'»');
console.log(split? ('раздельно по площадкам: ВБ «'+rows[hr][iWb]+'» · Озон «'+rows[hr][iOz]+'»')
                 : ('общее количество: «'+rows[hr][iAll]+'»'));

const bySup={}; let rowsRead=0, unknown={}, totalAll=0, totalWb=0, totalOz=0;
for(let i=hr+1;i<rows.length;i++){
  const r=rows[i]; const key=S(r[iKey]).replace(/,/g,'');
  if(!key||/^итог|^всего/i.test(key)) continue;
  const w=split? num(r[iWb]) : 0, o=split? num(r[iOz]) : 0, a=split? 0 : num(r[iAll]);
  if(!(w||o||a)) continue;
  if(!supSet.has(key)){ unknown[key]=(unknown[key]||0)+(w+o+a); continue; }
  const e=bySup[key]||(bySup[key]={qty:0,wb:0,oz:0});
  e.qty+=w+o+a; e.wb+=w; e.oz+=o;
  rowsRead++; totalAll+=w+o+a; totalWb+=w; totalOz+=o;
}
RD.warehouse={ date: dateArg||new Date().toISOString().slice(0,10), split, bySup };

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const uk=Object.keys(unknown);
console.log('\nСклад на '+RD.warehouse.date+': строк принято '+rowsRead+' · позиций '+Object.keys(bySup).length
  +' · всего '+totalAll.toLocaleString('ru-RU')+' шт'+(split? (' (ВБ '+totalWb.toLocaleString('ru-RU')+' · Озон '+totalOz.toLocaleString('ru-RU')+')') : ''));
console.log('Кодов не из нашего каталога (пропущено): '+uk.length
  +(uk.length? ' · '+uk.slice(0,15).map(k=>k+'('+unknown[k]+')').join(', ')+(uk.length>15?' …':'') : ''));
const top=Object.entries(bySup).sort((a,b)=>b[1].qty-a[1].qty).slice(0,10);
if(top.length){ console.log('\nТоп по количеству:');
  top.forEach(([k,v])=>console.log('  1С '+k+' · '+v.qty+' шт'+(split? (' (ВБ '+v.wb+' / Озон '+v.oz+')'):'')+'  · '+(nameBySup[k]||'').slice(0,40))); }
console.log('\nДальше: node scripts/encrypt.cjs <код>');
