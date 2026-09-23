// Кладёт в снимок разрез Озона ПО КЛАСТЕРАМ: где товар лежит, где он продаётся и где его нет.
//
// Зачем. Подсорт на Озон до сих пор считал площадку ОДНОЙ КУЧЕЙ: остаток + заявки + в пути
// одним числом. Из-за этого дашборд не видел, что товар лежит в Москве, а кончается в Ростове
// и Питере. Замер 23.09.2026: Ростов 32,9 продаж/день при остатке 8 шт, Санкт-Петербург 22,4
// при остатке 6 шт — это второй и третий кластеры по спросу, и они пустые.
//
// Источник — лист «Товар-кластер» обычного отчёта Ozon «Остатки на складах» (stocks_report.xlsx).
// Отдельный файл «Ликвидность» просить НЕ нужно: и статус ликвидности, и среднесуточные
// продажи по кластеру лежат в этом же листе.
//
// ШАПКА ДВУХЭТАЖНАЯ (строка 1 — группа, строка 2 — подзаголовок), данные с 5-й строки.
// В подписях стоят НЕРАЗРЫВНЫЕ И УЗКИЕ ПРОБЕЛЫ ( ,   и пр.) — без нормализации
// колонки «В заявках на поставку» и «В поставках в пути» не находятся и молча читаются нулём.
// Поэтому имена ищем по КУСКУ текста до первого пробела-разделителя, а пробелы нормализуем.
//
// Использование: node scripts/ozon-clusters.cjs <stocks_report.xlsx> [дата=сегодня]
// Дальше: node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2], dateArg=process.argv[3]||new Date().toISOString().slice(0,10);
if(!file){console.error('usage: node scripts/ozon-clusters.cjs <stocks_report.xlsx> [ГГГГ-ММ-ДД]');process.exit(1);}

// нормализация: любые «хитрые» пробелы и мусорные символы → обычный пробел
const nb=s=>(''+(s==null?'':s)).replace(/[\s  -​  　﻿�]+/g,' ').trim();
const num=v=>{const s=nb(v).replace(/\s/g,'').replace(/,/g,''); const n=parseFloat(s); return isNaN(n)?0:n;};
const code=v=>nb(v).replace(/[\s,]/g,'');

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const supSet=new Set(RD.catalog.map(c=>code(c.supplierCode)).filter(Boolean));
const nameBySup={}; RD.catalog.forEach(c=>{const s=code(c.supplierCode); if(s&&!nameBySup[s]) nameBySup[s]=c.name;});

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const SH='Товар-кластер';
if(!wb.Sheets[SH]){ console.error('нет листа «'+SH+'». Есть: '+wb.SheetNames.join(', ')); process.exit(1); }
const r=XLSX.utils.sheet_to_json(wb.Sheets[SH],{header:1,raw:false,defval:''});
const H1=(r[1]||[]).map(nb);
/* ШАПКА ОБЪЕДИНЁННАЯ: имя группы («Товары в пути», «Ликвидность») стоит ТОЛЬКО над первой
   колонкой группы, у остальных первая строка пустая. Поэтому протягиваем имя вправо —
   иначе «В поставках в пути» и «Дней до конца остатка» не находятся, и покрытие кластера
   молча занижается на весь товар, который уже едет. */
const H0raw=(r[0]||[]).map(nb); const H0=[]; let g='';
for(let i=0;i<Math.max(H0raw.length,H1.length);i++){ if(H0raw[i]) g=H0raw[i]; H0[i]=g; }
const has=(s,t)=>s.toLowerCase().includes(t.toLowerCase());
function col(group,sub){
  for(let i=0;i<40;i++){
    const a=H0[i]||'', b=H1[i]||'';
    if(group && !has(a,group)) continue;
    if(sub   && !has(b,sub))   continue;
    return i;
  }
  return -1;
}
const I={ art:col('Артикул',''), cluster:col('Кластер',''),
  liq:col('Ликвидность','Статус'), daysLeft:col('Ликвидность','Дней до'),
  spd:col('Среднесуточные',''), avail:col('Доступно к',''),
  req:col('Товары в пути','В заявках'), road:col('Товары в пути','В поставках') };
const missing=Object.entries(I).filter(([,v])=>v<0).map(([k])=>k);
if(missing.length){
  // молчаливый ноль опаснее падения: без «в заявках»/«в пути» покрытие кластера занижается
  console.error('не нашёл колонки: '+missing.join(', '));
  console.error('шапка строка 1: '+H0.map((h,i)=>i+':'+h).filter(x=>!/:$/.test(x)).join(' | '));
  console.error('шапка строка 2: '+H1.map((h,i)=>i+':'+h).filter(x=>!/:$/.test(x)).join(' | '));
  process.exit(1);
}

const bySup={}, byCluster={}; let ours=0, alien=0;
for(let i=4;i<r.length;i++){
  const x=r[i]||[]; const a=code(x[I.art]); if(!a) continue;
  if(!supSet.has(a)){ alien++; continue; }
  ours++;
  const cl=nb(x[I.cluster])||'(без кластера)';
  const rec={ avail:num(x[I.avail]), spd:num(x[I.spd]), req:num(x[I.req]), road:num(x[I.road]),
    liq:nb(x[I.liq])||'', daysLeft:nb(x[I.daysLeft])||'' };
  // один код может идти НЕСКОЛЬКИМИ строками в одном кластере (разные SKU/признаки) — складываем
  const s=bySup[a]||(bySup[a]={});
  if(s[cl]){ s[cl].avail+=rec.avail; s[cl].spd+=rec.spd; s[cl].req+=rec.req; s[cl].road+=rec.road;
    if(!s[cl].liq) s[cl].liq=rec.liq; }
  else s[cl]=rec;
  const e=byCluster[cl]||(byCluster[cl]={avail:0,spd:0,req:0,road:0,codes:0});
  e.avail+=rec.avail; e.spd+=rec.spd; e.req+=rec.req; e.road+=rec.road;
}
Object.keys(byCluster).forEach(cl=>{
  byCluster[cl].codes=Object.keys(bySup).filter(s=>bySup[s][cl]&&(bySup[s][cl].avail>0||bySup[s][cl].spd>0)).length; });

RD.ozon=RD.ozon||{};
RD.ozon.clusters={ date:dateArg, byCluster, bySup };
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const F=n=>Math.round(n).toLocaleString('ru-RU');
const list=Object.entries(byCluster).map(([cl,e])=>({cl,...e})).sort((a,b)=>b.spd-a.spd);
const tot=list.reduce((s,e)=>({avail:s.avail+e.avail,spd:s.spd+e.spd,req:s.req+e.req,road:s.road+e.road}),{avail:0,spd:0,req:0,road:0});
console.log('лист «'+SH+'» · наших строк '+ours+' · чужих пропущено '+alien);
console.log('кластеров: '+list.length+' · дата '+dateArg+'\n');
console.log('КЛАСТЕР                         остаток  продаж/дн  хватит,дн   заявки   в пути  кодов');
list.forEach(e=>{
  const cov=e.avail+e.req+e.road;
  const days=e.spd>0? Math.round(cov/e.spd) : null;
  console.log('  '+e.cl.padEnd(29).slice(0,29)+String(F(e.avail)).padStart(9)+String(e.spd.toFixed(1)).padStart(11)
    +String(days===null?'—':days).padStart(11)+String(F(e.req)).padStart(9)+String(F(e.road)).padStart(9)+String(e.codes).padStart(7));
});
console.log('  '+'ИТОГО'.padEnd(29)+String(F(tot.avail)).padStart(9)+String(tot.spd.toFixed(1)).padStart(11)
  +String(Math.round((tot.avail+tot.req+tot.road)/tot.spd)).padStart(11)+String(F(tot.req)).padStart(9)+String(F(tot.road)).padStart(9));

// сверка с листом «Товары», который читает ozon-build.cjs
const snapStock=((RD.ozon.catalog)||[]).reduce((s,x)=>s+(x.ozStock||0),0);
const snapTr=((RD.ozon.catalog)||[]).reduce((s,x)=>s+(x.ozTransit||0),0);
console.log('\nСВЕРКА с листом «Товары» (его читает ozon-build.cjs):');
console.log('  остаток:  кластеры '+F(tot.avail)+' · снимок '+F(snapStock)+(Math.abs(tot.avail-snapStock)<1?'  ✅':'  ⚠ расходится'));
console.log('  в пути:   кластеры '+F(tot.req+tot.road)+' · снимок '+F(snapTr)+(Math.abs(tot.req+tot.road-snapTr)<1?'  ✅':'  ⚠ расходится'));
const empty=list.filter(e=>e.spd>0 && (e.avail+e.req+e.road)/e.spd < 7);
if(empty.length){
  console.log('\nСПРОС ЕСТЬ, ТОВАРА НЕТ (покрытия меньше недели) — '+empty.length+' кластеров:');
  empty.forEach(e=>console.log('   '+e.cl.padEnd(29)+String(e.spd.toFixed(1)).padStart(7)+' продаж/дн при остатке '+F(e.avail)+' шт'));
}
console.log('\nДальше: node scripts/encrypt.cjs <код>');
