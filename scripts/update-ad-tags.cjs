// Заливает разбивку товаров по ГРУППАМ и СКЛЕЙКАМ (теги) из выгрузки XWAY.
// Пишет catalog[].adGroup / catalog[].adTag. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Продавец ведёт рекламу не по товарам поштучно, а по склейкам: карточки, слитые
// в одну (Land Rover, Мерс род/ручка, Бюджетные 2 …), конкурируют в выдаче как одна
// позиция, и реклама на них ставится тоже как на одну. Без этой разбивки дашборд не может
// повторить его отбор товаров под рекламу.
//
// ФАЙЛ: выгрузка XWAY, лист «Страница 1», колонки по имени:
//   «Артикул WB» · «Артикул продавца» · «Группа» (крупная группа) · «Теги» (склейка) · «Категория».
// «Группа» крупнее ВБ-категории (Пушкары, Рули, Набор для бокса, Песок, Светофоры),
// «Тег» — это и есть склейка внутри группы. У части строк тег пуст: вся группа = одна склейка.
//
// Товары, которых нет в ВБ-каталоге, пропускаются и печатаются списком: обычно это новые
// карточки, которых ещё нет в нашем снимке каталога (его надо обновить отдельно).
//
// Использование: node scripts/update-ad-tags.cjs <выгрузка.xlsx> [ГГГГ-ММ-ДД]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2], dateArg=process.argv[3]||new Date().toISOString().slice(0,10);
if(!file){console.error('usage: node scripts/update-ad-tags.cjs <выгрузка.xlsx> [ГГГГ-ММ-ДД]');process.exit(1);}
const S=v=>(''+(v==null?'':v)).replace(/ /g,' ').replace(/\s+/g,' ').trim();

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const bySku={}; RD.catalog.forEach(c=>bySku[''+c.sku]=c);

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const shName=wb.SheetNames[0];
const rows=XLSX.utils.sheet_to_json(wb.Sheets[shName],{header:1,raw:false,defval:''});
let hr=-1;
for(let i=0;i<Math.min(10,rows.length);i++){
  const H=(rows[i]||[]).map(S);
  if(H.indexOf('Артикул WB')>=0 && H.indexOf('Группа')>=0){ hr=i; break; }
}
if(hr<0){ console.error('не нашёл шапку с «Артикул WB» и «Группа» на листе «'+shName+'»'); process.exit(1); }
const H=rows[hr].map(S);
const iSku=H.indexOf('Артикул WB'), iGrp=H.indexOf('Группа'), iTag=H.indexOf('Теги');

let set=0, same=0; const miss=[], groups={}, tags={};
for(let i=hr+1;i<rows.length;i++){
  const sku=S(rows[i][iSku]); if(!sku) continue;
  const g=S(rows[i][iGrp]); if(!g) continue;
  // тег пуст → вся группа считается одной склейкой (так у «Рулей» и «Набора для бокса»)
  const t=S(iTag>=0? rows[i][iTag] : '') || g;
  groups[g]=(groups[g]||0)+1; tags[g+' / '+t]=(tags[g+' / '+t]||0)+1;
  const c=bySku[sku];
  if(!c){ miss.push({sku,sup:S(rows[i][2]),name:S(rows[i][0])}); continue; }
  if(S(c.adGroup)===g && S(c.adTag)===t){ same++; continue; }
  c.adGroup=g; c.adTag=t; set++;
}
RD.meta=RD.meta||{}; RD.meta.adTagsDate=dateArg;

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('Склейки на '+dateArg+' из «'+shName+'»: строк '+(set+same+miss.length));
console.log('   проставлено/изменено: '+set+' · уже совпадало: '+same+' · нет в каталоге ВБ: '+miss.length);
console.log('\nГруппы:');
Object.entries(groups).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
console.log('\nСклейки (группа / тег):');
Object.entries(tags).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
if(miss.length){
  console.log('\nНет в каталоге ВБ (карточки новее нашего снимка каталога) — '+miss.length+':');
  miss.slice(0,12).forEach(x=>console.log('   '+x.sku+' / 1С '+x.sup+'  '+x.name.slice(0,42)));
  if(miss.length>12) console.log('   … и ещё '+(miss.length-12));
}
const noTag=RD.catalog.filter(c=>!c.adGroup).length;
console.log('\nВ каталоге ВБ без склейки: '+noTag+' из '+RD.catalog.length);
console.log('Дальше: node scripts/encrypt.cjs <код>');
