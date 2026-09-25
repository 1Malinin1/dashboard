// ОСТАТКИ OZON ИЗ ДЕТАЛЬНОГО ОТЧЁТА «по складам» — обновляет ozStock/ozTransit и остаток
// по кластерам. Принимает НЕСКОЛЬКО файлов: продавец дробит один отчёт на части, потому что
// целиком он не загружается (25.09.2026 — 142 892 строки двумя файлами). Части просто
// склеиваются: проверено, что между собой они НЕ ПЕРЕСЕКАЮТСЯ (0 общих строк).
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ ОБЫЧНОГО «Остатки на складах» (его читает ozon-build.cjs, лист «Товары»):
// здесь одна строка = артикул × SKU × кластер × склад × признак × зона, то есть видно,
// ГДЕ ИМЕННО лежит товар. Поэтому отсюда берётся и разрез по кластерам. Чего тут НЕТ —
// «Среднесуточные продажи за 28 дней»: спрос по кластерам живёт только в листе
// «Товар-кластер» обычного отчёта (ozon-clusters.cjs). См. ниже про перенос `spd`.
//
// ⚠ СТРОКИ НЕ ДЕДУПЛИЦИРУЮТСЯ, И ЭТО ВАЖНО. Один и тот же артикул на одном складе идёт
// НЕСКОЛЬКИМИ строками — различаются «Признак товара» и «Зона размещения» (сортируемый /
// несортируемый, маркируемый / нет). По ключу «артикул+SKU+кластер+склад» таких «дублей»
// 13 602, и если их схлопнуть, по кабинету теряется 87 421 шт, по нашим товарам — 2 шт.
// Каждая строка — свой физический остаток, их надо СКЛАДЫВАТЬ. Не вводи здесь дедуп.
//
// ОТЧЁТ — ПОЛНЫЙ СНИМОК: товар, которого в нём нет, лежит на Ozon в нуле, поэтому
// ozStock/ozTransit по таким кодам обнуляются (то же правило, что в ozon-build.cjs).
// Из-за этого частичную выгрузку заливать НЕЛЬЗЯ — скрипт требует подтверждения, если
// наш остаток падает больше чем на DROP_WARN.
//
// `spd` ПО КЛАСТЕРАМ ПЕРЕНОСИТСЯ ИЗ ПРЕЖНЕГО СНИМКА — в этом отчёте его нет ни колонкой.
// Записать кластеры без него значит молча обнулить спрос и сломать расчёт «сколько везти
// в какой округ». Тот же капкан, что с meta.terms в ozon-build.cjs.
//
// Использование:
//   node scripts/ozon-stock-detail.cjs <часть1.xlsx> [часть2.xlsx …] [--date ГГГГ-ММ-ДД] [--force]
// Дальше: node scripts/encrypt.cjs <код> && node scripts/resupply-report.cjs
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require(path.join(__dirname,'node_modules','xlsx'));
const OUT=path.join(__dirname,'..','decrypted');
const DROP_WARN=0.15;            // падение остатка больше 15% без --force не пишем

const argv=process.argv.slice(2);
const FORCE=argv.includes('--force');
let dateArg=null;
{ const i=argv.indexOf('--date'); if(i>=0) dateArg=argv[i+1]; }
const files=argv.filter((a,i)=>!a.startsWith('--') && argv[i-1]!=='--date');
if(!files.length){ console.error('usage: node scripts/ozon-stock-detail.cjs <часть1.xlsx> [часть2.xlsx …] [--date ГГГГ-ММ-ДД]'); process.exit(1); }
files.forEach(f=>{ if(!fs.existsSync(f)){ console.error('не найден файл: '+f); process.exit(1); } });
if(!dateArg) dateArg=new Date().toISOString().slice(0,10);

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const S=v=>(''+(v==null?'':v)).trim();
const F=n=>Math.round(n).toLocaleString('ru-RU');
const nb=s=>(''+(s==null?'':s)).replace(/[\s  -​  　﻿]+/g,' ').trim();
const num=v=>{ const n=parseFloat((''+(v==null?'':v)).replace(/[\s ]/g,'').replace(',','.')); return isNaN(n)?0:n; };
const code=v=>S(v).replace(/[\s ,]/g,'');

const supSet=new Set((RD.catalog||[]).map(c=>code(c.supplierCode)).filter(Boolean));
if(!supSet.size){ console.error('в каталоге ВБ нет supplierCode — сначала залейте каталог'); process.exit(1); }

/* ШАПКА ДВУХЭТАЖНАЯ: строка 0 — группа («Недоступно к продаже», «Товары в пути»), строка 1 —
   подколонка. Имя группы стоит только над ПЕРВОЙ колонкой группы, дальше пусто, поэтому
   тянем его вправо — иначе «В заявках на поставку» останется без группы и не найдётся. */
function header(rows){
  const H0=(rows[0]||[]).map(nb), H1=(rows[1]||[]).map(nb), H=[]; let g='';
  for(let i=0;i<Math.max(H0.length,H1.length);i++){ if(H0[i]) g=H0[i];
    H[i]= H1[i] ? (g+' / '+H1[i]) : g; }
  return H;
}
function cols(H,file){
  const find=(re,must)=>{ const i=H.findIndex(x=>re.test(x));
    if(i<0&&must){ console.error('НЕ НАЙДЕНА КОЛОНКА '+re+' в '+path.basename(file)
      +'\nшапка файла: '+H.filter(Boolean).join(' | ')); process.exit(1); }
    return i; };
  return { art:find(/^Артикул$/,true), sku:find(/Номер SKU|^SKU$/,false),
    cluster:find(/^Кластер$/,true), wh:find(/^Склад$/,true),
    avail:find(/^Доступно к продаже$/,true),
    req:find(/Товары в пути \/ В заявках на поставку/,true),
    road:find(/Товары в пути \/ В поставках в пути/,true) };
}

const byArt={}, byArtTr={}, bySup={}, byCluster={}, whs=new Set();
let rowsAll=0, ourRows=0, alienRows=0;
files.forEach(f=>{
  const wb=XLSX.readFile(f);
  const r=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});
  const H=header(r), I=cols(H,f);
  let n=0;
  for(let i=2;i<r.length;i++){
    const x=r[i]||[]; const a=code(x[I.art]); if(!a) continue;
    if(a==='Номерартикула'||/^Нередактируемое$/i.test(S(x[I.art]))) continue;   // строки-подписи шапки
    rowsAll++; n++;
    if(!supSet.has(a)){ alienRows++; continue; }
    ourRows++;
    const av=num(x[I.avail]), rq=num(x[I.req]), rd=num(x[I.road]);
    byArt[a]=(byArt[a]||0)+av; byArtTr[a]=(byArtTr[a]||0)+rq+rd;
    const cl=nb(x[I.cluster])||'(без кластера)';
    whs.add(nb(x[I.wh]));
    const s=bySup[a]||(bySup[a]={});
    const rec=s[cl]||(s[cl]={avail:0,spd:0,req:0,road:0});
    rec.avail+=av; rec.req+=rq; rec.road+=rd;
    const e=byCluster[cl]||(byCluster[cl]={avail:0,spd:0,req:0,road:0,codes:0});
    e.avail+=av; e.req+=rq; e.road+=rd;
  }
  console.log('  '+path.basename(f).slice(0,28)+': строк '+F(n));
});

RD.ozon=RD.ozon||{}; RD.ozon.catalog=RD.ozon.catalog||[];
const cat=RD.ozon.catalog;
const wasStock=cat.reduce((s,c)=>s+(c.ozStock||0),0);
const wasTr=cat.reduce((s,c)=>s+(c.ozTransit||0),0);
const nowStock=Object.values(byArt).reduce((s,v)=>s+v,0);
const nowTr=Object.values(byArtTr).reduce((s,v)=>s+v,0);

// страховка от частичной выгрузки
if(wasStock>0 && nowStock < wasStock*(1-DROP_WARN) && !FORCE){
  console.error('\n⚠ ОСТАТОК ПАДАЕТ С '+F(wasStock)+' ДО '+F(nowStock)+' шт ('
    +((1-nowStock/wasStock)*100).toFixed(1)+'%) — похоже на НЕПОЛНУЮ выгрузку.');
  console.error('   Отчёт считается полным снимком, поэтому товар вне его обнуляется.');
  console.error('   Если выгрузка действительно полная — повторите с --force. Снимок НЕ записан.');
  process.exit(1);
}

/* ПЕРЕНОС `spd`: среднесуточных продаж по кластерам в этом отчёте нет. Берём их из прежнего
   ozon.clusters, иначе спрос по кластерам молча обнулится. */
const prev=(RD.ozon.clusters&&RD.ozon.clusters.bySup)||{};
let spdKept=0;
Object.keys(bySup).forEach(a=>{ const p=prev[a]; if(!p)return;
  Object.keys(bySup[a]).forEach(cl=>{ if(p[cl]&&p[cl].spd){ bySup[a][cl].spd=p[cl].spd; spdKept++;
    byCluster[cl].spd+=p[cl].spd; } });
  Object.keys(p).forEach(cl=>{ if(!bySup[a][cl] && p[cl].spd){        // кластер выпал из остатка, спрос был
    bySup[a][cl]={avail:0,spd:p[cl].spd,req:0,road:0}; spdKept++;
    const e=byCluster[cl]||(byCluster[cl]={avail:0,spd:0,req:0,road:0,codes:0}); e.spd+=p[cl].spd; } });
});
Object.keys(byCluster).forEach(cl=>{
  byCluster[cl].codes=Object.keys(bySup).filter(s=>bySup[s][cl]&&(bySup[s][cl].avail>0||bySup[s][cl].spd>0)).length; });

/* АРТИКУЛ ЕСТЬ В ОТЧЁТЕ OZON, НО НЕТ В КАТАЛОГЕ ОЗОНА — ЗАВОДИМ КАРТОЧКУ (25.09.2026).
   Каталог Озона собирается по связке с ВБ, а `ozon-prune.cjs` выкидывает из него коды без
   единого следа на площадке. Когда продавец ВПЕРВЫЕ отправляет такой товар на Ozon, в отчёте
   появляются «заявки на поставку», а записать их некуда — карточки нет, и штуки молча
   пропадают. Поймано на 512178 (60 шт) и 512193 (96 шт) в Новосибирск: скрипт насчитал
   2 102 шт в пути, а в каталог легло 1 946. Раз Ozon отчитывается по артикулу — товар на
   площадке есть, заводим. Имя и категорию берём из каталога ВБ по коду 1С. */
let added=0;
Object.keys(byArt).forEach(a=>{
  if(cat.some(c=>code(c.sku)===a)) return;
  if(!(byArt[a]>0 || byArtTr[a]>0)) return;                 // ни остатка, ни поставок — не заводим
  const w=(RD.catalog||[]).find(c=>code(c.supplierCode)===a);
  cat.push({ sku:a, name:(w&&w.name)||a, category:'Без категории',
    wbCategory:(w&&w.category)||'', wbSku:(w? ''+w.sku : null),
    ozStock:0, ozTransit:0, ozIncoming:0 });
  added++;
});

// запись в каталог Озона: отчёт — ПОЛНЫЙ снимок, товар вне него = 0
let touched=0, zeroed=0;
cat.forEach(c=>{ const a=code(c.sku);
  const av=byArt[a]||0, tr=byArtTr[a]||0;
  if((c.ozStock||0)!==av || (c.ozTransit||0)!==tr) touched++;
  if(byArt[a]===undefined && ((c.ozStock||0)>0||(c.ozTransit||0)>0)) zeroed++;
  c.ozStock=av; c.ozTransit=tr;
});
RD.ozon.meta=RD.ozon.meta||{};
RD.ozon.meta.stockDate=dateArg;
RD.ozon.clusters={ date:dateArg, byCluster, bySup,
  src:'детальный отчёт по складам ('+files.length+' ч.)',
  note:'spd перенесён из прежнего снимка — в этом отчёте его нет' };

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const notInCat=Object.keys(byArt).filter(a=>!cat.some(c=>code(c.sku)===a));
console.log('\nОСТАТКИ OZON ИЗ ДЕТАЛЬНОГО ОТЧЁТА · дата снимка '+dateArg);
console.log('  строк во всех частях: '+F(rowsAll)+' (наших '+F(ourRows)+', чужих '+F(alienRows)+')');
console.log('  СТРОКИ НЕ ДЕДУПЛИЦИРОВАНЫ — один артикул на складе идёт несколькими строками (признак/зона), это разный товар');
console.log('  доступно к продаже: '+F(wasStock)+' → '+F(nowStock)+' шт  ('+(nowStock-wasStock>=0?'+':'')+F(nowStock-wasStock)+')');
console.log('  в пути (заявки + поставки): '+F(wasTr)+' → '+F(nowTr)+' шт  ('+(nowTr-wasTr>=0?'+':'')+F(nowTr-wasTr)+')');
console.log('  артикулов с остатком: '+Object.keys(byArt).filter(a=>byArt[a]>0).length
  +' · обновлено карточек: '+touched+' · обнулено (нет в отчёте): '+zeroed);
console.log('  кластеров: '+Object.keys(byCluster).length+' · складов: '+whs.size
  +' · перенесено значений spd: '+spdKept);
if(added) console.log('  ЗАВЕДЕНО НОВЫХ КАРТОЧЕК В КАТАЛОГЕ ОЗОНА: '+added
  +' — товар впервые поехал на площадку, без этого его «в пути» было некуда записать');
if(notInCat.length) console.log('  ⚠ есть в отчёте, но НЕТ в каталоге Озона ('+notInCat.length+'): '+notInCat.slice(0,10).join(', ')+(notInCat.length>10?' …':''));

console.log('\nПО КЛАСТЕРАМ (наши товары):');
Object.entries(byCluster).sort((a,b)=>b[1].avail-a[1].avail).forEach(([cl,e])=>{
  if(e.avail<=0 && e.req<=0 && e.road<=0) return;
  console.log('   '+cl.padEnd(34)+String(F(e.avail)).padStart(7)+' шт'
    +(e.req+e.road? ' · в пути '+String(F(e.req+e.road)).padStart(6) : '')
    +' · кодов '+e.codes+(e.spd? ' · продаж/дн '+e.spd.toFixed(1):''));
});
console.log('\nДальше: node scripts/encrypt.cjs <код> && node scripts/resupply-report.cjs');
