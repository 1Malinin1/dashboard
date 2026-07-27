// Обновляет «в пути» (товар, который должен приехать на площадку) из рабочего файла продавца
// «на оптовых.xls» с вкладками: «вб», «озон», «в пути», «в пути 2».
//
// Логика (со слов продавца):
//   ВБ   «в пути» = вб.«Итог»   + «в пути».«Кол-во вб»   + «в пути 2».«Кол-во вб»
//   Озон «в пути» = озон.«Итог» + «в пути».«Кол-во озон» + «в пути 2».«Кол-во озон»
// Вкладки «вб»/«озон» — товар на своих складах, который ДОЛЖЕН уехать на площадку;
// «в пути»/«в пути 2» — партии, которые уже едут. Вместе = сколько всего придёт на площадку.
//
// Ключ везде — арт. поставщика («Номенклатура.Код» / «Артикул») = WB supplierCode = Озон sku.
// Пишет: ВБ → catalog[].pending.qty (source='на оптовых'); Озон → ozon.catalog[].ozIncoming.
// ВАЖНО: ozIncoming — ДОПОЛНИТЕЛЬНО к ozTransit (то, что Озон сам показывает по своим поставкам);
// это разные вещи и они складываются, не заменяют друг друга.
//
// Использование: node scripts/update-transit.cjs <на_оптовых.xls|xlsx> [YYYY-MM-DD]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2], asOf=process.argv[3]||new Date().toISOString().slice(0,10);
if(!file){console.error('usage: node scripts/update-transit.cjs <на_оптовых.xls> [YYYY-MM-DD]');process.exit(1);}

// Числа из Excel: raw:true даёт JS-число; строковый фолбэк — рус. формат «1 837,500»
function num(v){ if(typeof v==='number') return isFinite(v)?v:0;
  const n=parseFloat((''+v).replace(/[\s ]/g,'').replace(',','.')); return isNaN(n)?0:n; }
const norm=s=>(''+s).replace(/[\s ]/g,'').toLowerCase();

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
console.log('Вкладки файла:', wb.SheetNames.join(' | '));
function sheet(want){ const n=wb.SheetNames.find(s=>norm(s)===norm(want)); return n? wb.Sheets[n] : null; }

// читает вкладку: {код → сумма по колонке colPred}. hdrPred — как найти строку шапки.
function readTab(sh,tabName,colPred,keyPred){
  if(!sh) return {map:{},rows:0,total:0,missing:true};
  const rows=XLSX.utils.sheet_to_json(sh,{header:1,raw:true,defval:''});
  let hr=-1,iKey=-1,iVal=-1;
  for(let i=0;i<Math.min(10,rows.length);i++){
    const H=(rows[i]||[]).map(x=>''+x);
    const k=H.findIndex(h=>keyPred(norm(h))), v=H.findIndex(h=>colPred(norm(h)));
    if(k>=0&&v>=0){ hr=i;iKey=k;iVal=v;break; }
  }
  if(hr<0) throw new Error('вкладка «'+tabName+'»: не нашёл колонки (ключ/значение)');
  const map={}; let n=0,total=0;
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]; const key=(''+(r[iKey]||'')).replace(/[\s ]/g,'').trim();
    if(!key||/^итог/i.test(key)) continue;
    const v=num(r[iVal]); if(!v) continue;
    map[key]=(map[key]||0)+v; n++; total+=v;
  }
  console.log('  «'+tabName+'»: строк '+n+' · сумма '+Math.round(total).toLocaleString('ru-RU')+' (колонка ['+iVal+'], шапка row '+hr+')');
  return {map,rows:n,total};
}
const isItog=h=>h==='итог'||h==='итого';
// ключ-колонка: «Номенклатура.Код» (вкладки вб/озон), «Артикул» (в пути), «арт» (в пути 2)
const isKey=h=>h.includes('номенклатура')||h==='артикул'||h==='арт'||h==='код';
const isKeyNom=isKey, isKeyArt=isKey;
const isQtyWb=h=>h.includes('кол-во')&&(h.includes('вб')||h.includes('wb'));
const isQtyOz=h=>h.includes('кол-во')&&(h.includes('озон')||h.includes('ozon'));

console.log('\nЧитаю вкладки:');
const tWb  = readTab(sheet('вб'),   'вб',   isItog, isKeyNom);
const tOz  = readTab(sheet('озон'), 'озон', isItog, isKeyNom);
const p1   = sheet('в пути'), p2 = sheet('в пути 2');
const p1Wb = readTab(p1,'в пути · вб',   isQtyWb, isKeyArt);
const p1Oz = readTab(p1,'в пути · озон', isQtyOz, isKeyArt);
const p2Wb = readTab(p2,'в пути 2 · вб', isQtyWb, isKeyArt);
const p2Oz = readTab(p2,'в пути 2 · озон',isQtyOz, isKeyArt);

// суммируем по площадкам
const sumMaps=(...ms)=>{ const o={}; ms.forEach(m=>Object.entries(m.map||{}).forEach(([k,v])=>o[k]=(o[k]||0)+v)); return o; };
const wbInc = sumMaps(tWb,p1Wb,p2Wb);
const ozInc = sumMaps(tOz,p1Oz,p2Oz);
const t=o=>Math.round(Object.values(o).reduce((a,b)=>a+b,0));
console.log('\nИтого «в пути» по файлу: ВБ '+t(wbInc).toLocaleString('ru-RU')+' шт ('+Object.keys(wbInc).length+' кодов)'
  +' · Озон '+t(ozInc).toLocaleString('ru-RU')+' шт ('+Object.keys(ozInc).length+' кодов)');

// ---- применяем к ВБ (ключ: supplierCode) ----
const bySup={}; RD.catalog.forEach(c=>{const s=(''+(c.supplierCode||'')).replace(/[\s ]/g,'').trim(); if(s)(bySup[s]||(bySup[s]=[])).push(c);});
let wbHit=0, wbMiss=[], wbOld=0, wbNew=0;
RD.catalog.forEach(c=>{ wbOld += (c.pending&&c.pending.qty)||0; });
// снимаем старое «в пути» у всех — файл является полным списком того, что едет
RD.catalog.forEach(c=>{ c.pending=null; });
Object.entries(wbInc).forEach(([code,qty])=>{
  const arr=bySup[code]; if(!arr){ wbMiss.push({code,qty}); return; }
  const q=Math.round(qty/arr.length);   // один код → несколько sku: делим поровну (обычно 1:1)
  arr.forEach(c=>{ c.pending={qty:q, asOf, source:'на оптовых'}; wbNew+=q; });
  wbHit++;
});

// ---- применяем к Озону (ключ: ozon.catalog.sku = арт. поставщика) ----
const ozBySku={}; (RD.ozon&&RD.ozon.catalog||[]).forEach(c=>ozBySku[(''+c.sku).replace(/[\s ]/g,'').trim()]=c);
let ozHit=0, ozMiss=[], ozNew=0;
(RD.ozon&&RD.ozon.catalog||[]).forEach(c=>{ c.ozIncoming=0; });
Object.entries(ozInc).forEach(([code,qty])=>{
  const c=ozBySku[code]; if(!c){ ozMiss.push({code,qty}); return; }
  c.ozIncoming=Math.round(qty); ozNew+=c.ozIncoming; ozHit++;
});
if(RD.ozon){ RD.ozon.meta=RD.ozon.meta||{}; RD.ozon.meta.incomingDate=asOf; }
RD.meta=RD.meta||{}; RD.meta.transitDate=asOf;

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('\nВБ  «в пути»: было '+wbOld.toLocaleString('ru-RU')+' → стало '+wbNew.toLocaleString('ru-RU')+' шт · сопоставлено кодов '+wbHit);
if(wbMiss.length) console.log('  НЕ найдено в ВБ-каталоге: '+wbMiss.length+' кодов ('+Math.round(wbMiss.reduce((a,x)=>a+x.qty,0)).toLocaleString('ru-RU')+' шт): '
  +wbMiss.slice(0,10).map(x=>x.code+'='+Math.round(x.qty)).join(', ')+(wbMiss.length>10?' …':''));
console.log('Озон «в пути» (доп. к ozTransit): '+ozNew.toLocaleString('ru-RU')+' шт · сопоставлено кодов '+ozHit);
if(ozMiss.length) console.log('  НЕ найдено в Озон-каталоге: '+ozMiss.length+' кодов ('+Math.round(ozMiss.reduce((a,x)=>a+x.qty,0)).toLocaleString('ru-RU')+' шт): '
  +ozMiss.slice(0,10).map(x=>x.code+'='+Math.round(x.qty)).join(', ')+(ozMiss.length>10?' …':''));
console.log('\nДальше: node scripts/encrypt.cjs <код> → git add wb-secure.js');
