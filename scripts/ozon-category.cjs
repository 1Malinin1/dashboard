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
// ДОБИВКА ПО СВЯЗКЕ. Товар, которого нет в отчёте (не было показов за период), остался бы
// с ВБ-названием — а таких категорий на Озоне не существует, и продавец видит в фильтре
// «Пушкары» рядом с «Каталкой». Поэтому после разбора отчёта достраиваем остальных по уже
// известной связке «категория ВБ → категория Озона» (её строим из тех, кого отчёт покрыл:
// Пушкары→Каталка на 269 товарах, Парковки→Сюжетно-ролевые игрушки и т.д.). Если по
// ВБ-категории связки нет вообще — ставим «Без категории»: честнее, чем показывать
// несуществующее на площадке название.
//
// Использование:
//   node scripts/ozon-category.cjs <отчёт_аналитики.xlsx> [1|2|3]
//     последний аргумент — какой уровень категории брать (по умолчанию 3, самый детальный)
//   node scripts/ozon-category.cjs fill          — только добивка по связке, без файла
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
const FILL_ONLY = file==='fill';
if(!FILL_ONLY && ![1,2,3].includes(level)){ console.error('уровень категории — 1, 2 или 3'); process.exit(1); }

/* Родные категории Озона — те, что реально встречались в отчётах. Всё остальное в поле
   `category` — это ВБ-название, доставшееся по фолбэку, и его надо заменить. */
function nativeSet(){ const c={};
  ozCat.forEach(x=>{ const v=S(x.category); if(v && v!==S(x.wbCategory)) c[v]=(c[v]||0)+1; });
  return new Set(Object.keys(c)); }
function fillByLink(){
  const nat=nativeSet();
  // связка «категория ВБ → категория Озона» по тем, у кого родная категория уже стоит
  const map={};
  ozCat.forEach(x=>{ const o=S(x.category), w=S(x.wbCategory);
    if(!w || !nat.has(o)) return;
    (map[w]||(map[w]={}))[o]=(map[w][o]||0)+1; });
  const best={}; Object.entries(map).forEach(([w,o])=>{
    best[w]=Object.entries(o).sort((a,b)=>b[1]-a[1])[0][0]; });
  let done=0, none=0; const log=[], noneList=[];
  ozCat.forEach(x=>{ const o=S(x.category); if(nat.has(o)) return;      // уже родная
    const w=S(x.wbCategory);
    if(best[w]){ if(o!==best[w]){ log.push({sku:x.sku,was:o,now:best[w]}); x.category=best[w]; done++; } }
    else if(o!=='Без категории'){ noneList.push({sku:x.sku,was:o}); x.category='Без категории'; none++; }
  });
  return {best,done,none,log,noneList};
}
if(FILL_ONLY){
  const r=fillByLink();
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
  console.log('Связка «категория ВБ → категория Озона» (по товарам, которые есть в отчётах):');
  Object.entries(r.best).forEach(([w,o])=>console.log('   '+w.padEnd(26)+' → '+o));
  console.log('\nДобито по связке: '+r.done+' товаров');
  r.log.slice(0,20).forEach(x=>console.log('   '+x.sku+'  «'+x.was+'» → «'+x.now+'»'));
  if(r.none){ console.log('\nСвязки нет — поставлено «Без категории»: '+r.none);
    r.noneList.slice(0,20).forEach(x=>console.log('   '+x.sku+'  было «'+x.was+'»')); }
  const cnt={}; ozCat.forEach(c=>{ const k=S(c.category)||'—'; cnt[k]=(cnt[k]||0)+1; });
  console.log('\nСтало на Озоне:');
  Object.entries(cnt).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
  console.log('\nДальше: node scripts/encrypt.cjs <код>'); process.exit(0);
}

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

// добиваем тех, кого в отчёте не было, — по связке с ВБ-категорией (см. шапку файла)
const fill=fillByLink();

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('Категории Озона (уровень '+level+') из «'+shName+'»: в файле '+Object.keys(byArt).length+' артикулов');
if(fill.done||fill.none) console.log('   добито по связке с ВБ-категорией: '+fill.done
  +(fill.none? ' · без связки → «Без категории»: '+fill.none : ''));
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
