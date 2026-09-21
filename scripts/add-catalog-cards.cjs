// Добавляет НОВЫЕ карточки в REAL_DATA.catalog (каталог ВБ).
//
// Зачем отдельный скрипт: `update-catalog-meta.cjs` только ОБНОВЛЯЕТ поля у карточек,
// которые уже есть, а неизвестные артикулы молча складывает в «нет в каталоге». Когда
// продавец заводит новую линейку (21.09.2026 — 25 рулей и 20 позиций бокса), добавить их
// было нечем, и в выгрузках XWAY они висели как «чужие».
//
// КОД 1С ОБЯЗАТЕЛЕН, И ЭТО НЕ ФОРМАЛЬНОСТЬ. `supplierCode` — единственная связка карточки
// ВБ со всем остальным: артикул Озона = код 1С, склад (`warehouse.bySup`), паллеты
// (`pallets.bySup`), «в пути», режим «Всего», подсорт (там ключ строки — именно код 1С).
// Карточка с пустым кодом не просто бесполезна — в подсорте все такие строки схлопнулись бы
// в ОДИН пустой ключ и перемешали бы товары между собой. Поэтому строка без кода 1С
// не добавляется, а печатается списком: лучше не добавить, чем добавить сломанным.
//
// Колонки ищутся ПО ИМЕНИ (регистр и пробелы неважны), лишние игнорируются:
//   «Артикул ВБ» / «Артикул Wb» / «Артикул WB»   — обязательна
//   «Код 1С» / «код поставщика» / «Код поставщика» — обязательна
//   «Наименование» / «Название» / «Товар»
//   «Категория»
//   «Код фабрики»
//   «Статус»                 (В работе | Новинка | На вывод; по умолчанию «Новинка»)
//   «Контейнер» / «Кратность» / «Кратность отгрузки»
//   «Себестоимость» / «Цена»
//
// Использование: node scripts/add-catalog-cards.cjs <файл.xlsx> [лист] [--apply]
// По умолчанию СУХОЙ ПРОГОН — печатает, что будет добавлено, и ничего не пишет.
// Дальше: node scripts/encrypt.cjs <код> && git add wb-secure.js
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const args=process.argv.slice(2).filter(a=>a!=='--apply');
const APPLY=process.argv.includes('--apply');
const file=args[0], sheetArg=args[1];
if(!file){console.error('usage: node scripts/add-catalog-cards.cjs <файл.xlsx> [лист] [--apply]');process.exit(1);}

const S=v=>(''+(v==null?'':v)).replace(/\s+/g,' ').trim();
const norm=v=>S(v).toLowerCase().replace(/[ёе]/g,'е');
// код 1С приходит и с пробелом («487 160»), и с запятой («474,092») — режем оба
const code=v=>S(v).replace(/[\s,]/g,'');
const normStatus=s=>{ s=S(s); return s? s[0].toUpperCase()+s.slice(1).toLowerCase() : ''; };
const num=v=>{ const n=parseFloat(S(v).replace(/\s/g,'').replace(',','.')); return isNaN(n)?null:n; };
// НОЛЬ В ЦЕНЕ/КРАТНОСТИ — ЭТО «НЕ ЗАПОЛНЕНО», А НЕ РЕАЛЬНОЕ ЗНАЧЕНИЕ. Продавец заполняет
// файл частями и в незаполненных клетках оставляет 0. Себестоимость 0 означала бы «товар
// достался бесплатно»: себестоимость проданного = 0, и карточка выглядела бы бесконечно
// прибыльной на «Главной» — молчаливая ошибка, которую никто не заметит. Кратность 0
// точно так же сломала бы округление дозаказа до контейнера.
const numPos=v=>{ const n=num(v); return (n==null||n<=0)? null : n; };

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const bySku={}, bySup={};
RD.catalog.forEach(c=>{ bySku[S(c.sku)]=c; const s=code(c.supplierCode); if(s)(bySup[s]||(bySup[s]=[])).push(c); });

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const sheet=sheetArg||wb.SheetNames[0];
if(!wb.Sheets[sheet]){console.error('нет листа «'+sheet+'». Есть: '+wb.SheetNames.join(', '));process.exit(1);}
const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,raw:false,defval:''});

// ---- шапка: ищем строку, где есть и артикул, и код 1С
const HDR={
  sku:['артикул вб','артикул wb','артикул'],
  sup:['код 1с','код поставщика','код постащика','1с'],
  name:['наименование','название','товар'],
  cat:['категория'],
  fac:['код фабрики','фабрика'],
  st:['статус'],
  cont:['контейнер','кратность','кратность отгрузки'],
  cost:['себестоимость','цена']
};
const findCol=(H,keys)=>H.findIndex(h=>keys.includes(norm(h)));
let hr=-1,I=null;
for(let i=0;i<Math.min(rows.length,15);i++){
  const H=(rows[i]||[]).map(S);
  const a=findCol(H,HDR.sku), s=findCol(H,HDR.sup);
  if(a>=0&&s>=0){ hr=i; I={}; Object.entries(HDR).forEach(([k,v])=>I[k]=findCol(H,v)); break; }
}
if(hr<0){
  console.error('не нашёл шапку: нужны колонки «Артикул ВБ» и «Код 1С».');
  console.error('в первой строке файла: '+(rows[0]||[]).map(S).join(' | '));
  process.exit(1);
}
console.log('лист «'+sheet+'» · шапка в строке '+(hr+1));

const add=[], noSup=[], already=[], sameSup=[];
for(let i=hr+1;i<rows.length;i++){
  const r=rows[i]||[]; const sku=code(r[I.sku]); if(!sku) continue;
  const sup=I.sup>=0? code(r[I.sup]) : '';
  const name=I.name>=0? S(r[I.name]) : '';
  if(bySku[sku]){ already.push(sku+(name?' — '+name.slice(0,40):'')); continue; }
  if(!sup){ noSup.push(sku+(name?' — '+name.slice(0,44):'')); continue; }
  const st=I.st>=0? normStatus(r[I.st]) : '';
  const cost=I.cost>=0? numPos(r[I.cost]) : null;
  const c={
    sku, factoryCode:I.fac>=0? S(r[I.fac]):'', supplierCode:sup,
    name: name||sku, category: I.cat>=0? S(r[I.cat]):'',
    wbStock:0, inTransitToWB:0, ownWarehouseStock:0,
    buyoutPct14d:null,                       // неизвестен — не подставляем ноль, иначе «0% выкупа»
    containerQty: I.cont>=0? numPos(r[I.cont]) : null,
    productionStatus: st||'Новинка',          // новая карточка по умолчанию новинка, не «На вывод»
    pending:null,
    costPrice: cost,
    // costHistory заводим только вместе с ценой, и ПЕРВАЯ запись всегда from:null —
    // иначе costAt() не найдёт цену для прошлых дат (см. памятку)
    ...(cost!=null? {costHistory:[{from:null,cost}]} : {})
  };
  if(bySup[sup]) sameSup.push(sku+' → 1С '+sup+' (уже у '+bySup[sup].map(x=>x.sku).join(', ')+')');
  add.push(c);
}

console.log('');
if(noSup.length){
  console.log('⚠  НЕ ДОБАВЛЕНЫ — пустой код 1С ('+noSup.length+'):');
  noSup.slice(0,50).forEach(x=>console.log('     '+x));
  if(noSup.length>50) console.log('     … ещё '+(noSup.length-50));
  console.log('     Код 1С связывает карточку со складом, Озоном, паллетами и подсортом.');
  console.log('     Без него строка в подсорте склеилась бы с другими по пустому ключу.\n');
}
if(already.length){
  console.log('уже есть в каталоге, пропущены ('+already.length+'): '+already.slice(0,8).join(' · ')
    +(already.length>8?' … ещё '+(already.length-8):'')+'\n');
}
if(sameSup.length){
  console.log('код 1С уже встречается у другой карточки ВБ — это нормально (одна номенклатура, несколько карточек):');
  sameSup.slice(0,10).forEach(x=>console.log('     '+x));
  console.log('');
}
if(!add.length){ console.log('Добавлять нечего.'); process.exit(0); }

const byCat={}; add.forEach(c=>(byCat[c.category||'(без категории)']||(byCat[c.category||'(без категории)']=[])).push(c));
console.log('К ДОБАВЛЕНИЮ: '+add.length+' карточек');
Object.entries(byCat).sort((a,b)=>b[1].length-a[1].length).forEach(([cat,l])=>{
  console.log('  «'+cat+'» — '+l.length);
  l.forEach(c=>console.log('     ВБ '+c.sku.padEnd(12)+'1С '+c.supplierCode.padEnd(8)
    +(c.containerQty!=null? 'конт '+String(c.containerQty).padStart(5):'конт     —')
    +(c.costPrice!=null? ' · '+c.costPrice+' ₽':' · цены нет')
    +' · '+c.productionStatus.padEnd(9)+' '+c.name.slice(0,40)));
});

const noCost=add.filter(c=>c.costPrice==null).length;
const noCont=add.filter(c=>c.containerQty==null).length;
console.log('');
if(noCost) console.log('без себестоимости: '+noCost+' — прибыль по ним считаться не будет (update-cost.cjs)');
if(noCont) console.log('без размера контейнера: '+noCont+' — дозаказ не округлится до контейнера');

if(!APPLY){ console.log('\nСУХОЙ ПРОГОН. Ничего не записано. Повторите с --apply, чтобы применить.'); process.exit(0); }

RD.catalog.push(...add);
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nДобавлено '+add.length+' карточек · в каталоге теперь '+RD.catalog.length);
console.log('Дальше: node scripts/update-ad-tags.cjs <выгрузка XWAY>   (проставит склейки)');
console.log('        node scripts/encrypt.cjs <код>');
