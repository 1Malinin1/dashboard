// Проставляет производственный статус товара (`catalog[].productionStatus`) по списку кодов 1С.
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Продавец решает судьбу ассортимента пачками: «всё из этого списка, кроме вот этих
// шести, — на вывод». Руками такое не проставить, а `update-catalog-meta.cjs` требует
// его рабочий файл-справочник целиком.
//
// ЧТО ДЕЛАЕТ СТАТУС. Он СПРАВОЧНЫЙ и на дозаказ/закуп не влияет (см. CLAUDE.md) — кроме
// одного места: «Подсорт со склада» пропускает «На вывод», потому что везти на площадку
// выводимый товар незачем. Но если такой товар ЛЕЖИТ НА СКЛАДЕ, он в подсорте остаётся:
// продавцу нужно его распродать, а для этого он должен попасть на площадку.
// Ещё статус скрывает товар из отчёта «паллеты-заполнить» — чтобы не просить вместимость
// у того, что выводится.
//
// Использование:
//   node scripts/set-prod-status.cjs "На вывод" 429598,429597,311114
//   node scripts/set-prod-status.cjs "На вывод" --file коды.txt      (по коду в строке)
//   node scripts/set-prod-status.cjs "В работе" --file коды.txt --except 429598,429597
//   node scripts/set-prod-status.cjs list                            (сводка по статусам)
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const KNOWN=['В работе','Новинка','На вывод'];

let argv=process.argv.slice(2);
const take=k=>{ const i=argv.indexOf(k); if(i<0) return null; const v=argv[i+1]; argv.splice(i,2); return v; };
const fileArg=take('--file'), exceptArg=take('--except');
const status=argv[0], listArg=argv[1];

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
/* Код 1С у части товаров содержит пробелы («WY730A-WB белый синий»), а в списках он приходит
   уже без них. Поэтому индексируем и по исходному ключу, и по ключу без пробелов. */
const bySup={}; RD.catalog.forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(!s) return;
  (bySup[s]||(bySup[s]=[])).push(c);
  const k=s.replace(/[\s ,]/g,''); if(k!==s)(bySup[k]||(bySup[k]=[])).push(c); });

if(status==='list'){
  const cnt={}; RD.catalog.forEach(c=>{ const v=(''+(c.productionStatus||'—')).trim(); cnt[v]=(cnt[v]||0)+1; });
  console.log('Карточек ВБ по статусам:');
  Object.entries(cnt).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
  const sup={}; Object.entries(bySup).forEach(([s,cs])=>{ const all=cs.every(c=>(''+(c.productionStatus||'')).trim()==='На вывод');
    sup[all?'На вывод (все карточки)':'в работе хотя бы одна']=(sup[all?'На вывод (все карточки)':'в работе хотя бы одна']||0)+1; });
  console.log('\nКодов 1С:'); Object.entries(sup).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
  process.exit(0);
}
if(!status || !KNOWN.includes(status)){
  console.error('usage: node scripts/set-prod-status.cjs "<'+KNOWN.join('|')+'>" <коды|--file файл> [--except коды]\n'
    +'       node scripts/set-prod-status.cjs list'); process.exit(1); }

const norm=s=>(''+s).replace(/[\s ,]/g,'');
let codes=[];
if(fileArg) codes=fs.readFileSync(fileArg,'utf8').split(/\r?\n/).map(norm).filter(Boolean);
else if(listArg) codes=listArg.split(/[,;]/).map(norm).filter(Boolean);
if(!codes.length){ console.error('не передан ни один код'); process.exit(1); }
const except=new Set((exceptArg||'').split(/[,;]/).map(norm).filter(Boolean));
codes=[...new Set(codes)].filter(c=>!except.has(c));

let changed=0, same=0, cards=0; const miss=[], list=[];
codes.forEach(s=>{
  const cs=bySup[s];
  if(!cs){ miss.push(s); return; }
  let any=false;
  cs.forEach(c=>{ const was=(''+(c.productionStatus||'')).trim();
    if(was!==status){ c.productionStatus=status; cards++; any=true; } });
  if(any){ changed++; list.push({s,name:cs[0].name,was:'разный'}); } else same++;
});
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('Статус «'+status+'»: кодов в списке '+codes.length
  +(except.size? ' (исключено '+except.size+')':''));
console.log('   изменено: '+changed+' кодов ('+cards+' карточек ВБ)');
console.log('   уже стоял такой статус: '+same);
if(miss.length) console.log('   нет в каталоге ВБ: '+miss.length+' · '+miss.slice(0,10).join(', ')+(miss.length>10?' …':''));
if(list.length){ console.log('\nИзменены:');
  list.slice(0,20).forEach(x=>console.log('   '+x.s+'  '+(x.name||'').slice(0,44)));
  if(list.length>20) console.log('   … и ещё '+(list.length-20)); }
console.log('\nДальше: node scripts/encrypt.cjs <код>');
