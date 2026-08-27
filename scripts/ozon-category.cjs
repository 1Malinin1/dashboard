// Ставит РОДНЫЕ категории Озона в `REAL_DATA.ozon.catalog[].category` из отчёта
// «Аналитика → По товарам» (там есть «Категория 1/2/3 уровня»).
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. До 27.08.2026 категория Озона ЗАМЕНЯЛАСЬ ВБ-категорией — чтобы фильтр работал
// одинаково на обеих площадках. Продавец попросил вернуть родные названия: одинаковые
// подписи на двух маркетплейсах мешали работать («и там и там „Пушкары“»).
//
// СВЯЗКА «ВСЕГО» ОТ ЭТОГО НЕ ЛОМАЕТСЯ. Категорий теперь две:
//   · `category`   — как называется у Озона («Каталка», «Игрушка для песочницы» …);
//   · `wbCategory` — категория из ВБ-каталога, она и есть КЛЮЧ СВЯЗКИ для режима «Всего».
// Озон-категории крупнее (одна «Каталка» = ВБ «Пушкары» + «Толокары»), поэтому каноничной
// для «Всего» остаётся ВБ-категория: она детальнее и покрывает обе площадки. `wbCategory`
// проставляет `ozon-build.cjs` по связке артикул Озона = supplierCode ВБ.
//
// Использование:
//   node scripts/ozon-category.cjs <отчёт_аналитики.xlsx> [1|2|3]
//     последний аргумент — какой уровень категории брать (по умолчанию 3, самый детальный)
//   node scripts/ozon-category.cjs list          — показать, что сейчас стоит
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');

const file=process.argv[2];
const level=parseInt(process.argv[3]||'3',10);
if(!file){ console.error('usage: node scripts/ozon-category.cjs <отчёт_аналитики.xlsx> [1|2|3]\n'
  +'       node scripts/ozon-category.cjs list'); process.exit(1); }

const S=v=>(''+(v==null?'':v)).replace(/ /g,' ').replace(/\s+/g,' ').trim();

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const ozCat=(RD.ozon&&RD.ozon.catalog)||[];
if(!ozCat.length){ console.error('в снимке нет каталога Озона'); process.exit(1); }

if(file==='list'){
  const c1={},c2={};
  ozCat.forEach(c=>{ c1[c.category||'—']=(c1[c.category||'—']||0)+1;
    c2[(c.category||'—')+'  ⟵  '+(c.wbCategory||'—')]=(c2[(c.category||'—')+'  ⟵  '+(c.wbCategory||'—')]||0)+1; });
  console.log('Категории Озона (как показывает дашборд на площадке «Озон»):');
  Object.entries(c1).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
  console.log('\nСвязка «категория Озона ⟵ категория ВБ» (ВБ — ключ режима «Всего»):');
  Object.entries(c2).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
  process.exit(0);
}
if(![1,2,3].includes(level)){ console.error('уровень категории — 1, 2 или 3'); process.exit(1); }

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const shName=wb.SheetNames.find(n=>/по товарам/i.test(n))||wb.SheetNames[0];
const rows=XLSX.utils.sheet_to_json(wb.Sheets[shName],{header:1,raw:false,defval:''});
// Шапка многоуровневая: ищем строку, где есть и «Артикул», и «Категория 1 уровня».
let hr=-1;
for(let i=0;i<Math.min(30,rows.length);i++){
  const H=(rows[i]||[]).map(S);
  if(H.indexOf('Артикул')>=0 && H.some(x=>/^Категория 1 уровня$/i.test(x))){ hr=i; break; }
}
if(hr<0){ console.error('не нашёл шапку с «Артикул» и «Категория 1 уровня» на листе «'+shName+'»'); process.exit(1); }
const H=rows[hr].map(S);
const iArt=H.indexOf('Артикул');
const iCat=H.findIndex(x=>x==='Категория '+level+' уровня');
if(iCat<0){ console.error('нет колонки «Категория '+level+' уровня»'); process.exit(1); }

// Артикул Озона = код 1С = supplierCode ВБ; берём только наши.
const byArt={};
for(let i=hr+1;i<rows.length;i++){
  const art=S(rows[i][iArt]); if(!art||art==='–') continue;
  const cat=S(rows[i][iCat]); if(!cat||cat==='–') continue;
  byArt[art]=cat;
}
let set=0, same=0, miss=[], changed=[];
ozCat.forEach(c=>{
  const cat=byArt[S(c.sku)];
  if(!cat){ miss.push(c.sku); return; }
  const was=S(c.category);
  if(was===cat){ same++; return; }
  c.category=cat; set++; if(changed.length<12) changed.push({sku:c.sku,was,now:cat});
});

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('Категории Озона (уровень '+level+') из «'+shName+'»: в файле '+Object.keys(byArt).length+' артикулов');
console.log('   проставлено/изменено: '+set+' · уже совпадало: '+same+' · нет в файле: '+miss.length
  +(miss.length? ' ('+miss.slice(0,8).join(', ')+(miss.length>8?' …':'')+')' : ''));
if(changed.length){ console.log('\nИзменения:');
  changed.forEach(x=>console.log('   '+x.sku+'  «'+x.was+'» → «'+x.now+'»')); }
const cnt={}; ozCat.forEach(c=>{ const k=S(c.category)||'—'; cnt[k]=(cnt[k]||0)+1; });
console.log('\nСтало на Озоне:');
Object.entries(cnt).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
const noLink=ozCat.filter(c=>!c.wbCategory).length;
console.log('\nСвязка «Всего» держится на wbCategory (категория ВБ): без неё '+noLink+' товаров.');
console.log('Дальше: node scripts/encrypt.cjs <код>');
