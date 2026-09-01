// Заливает статистику рекламных кампаний из выгрузки XWAY в REAL_DATA.adPerf.
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Продавец разбирает рекламу сверху вниз: общий ДРР → группа → склейка → товар,
// и правит там, где не попадает в цель. Цель — ДРР ≤7% (хорошо 6%, идеально ниже),
// причём ДРР он смотрит В ВЫКУПЕ, а не в заказах: заказ ещё может не выкупиться.
//
// БАЗА ДРР — «ОБЩАЯ СУММА ЗАКАЗОВ», А НЕ «ЗАКАЗЫ С РЕКЛАМЫ». Это была моя ошибка
// (найдена продавцом 31.08.2026): ДРР = доля рекламных расходов В ВЫРУЧКЕ ТОВАРА, а не
// окупаемость рекламных заказов. По рекламным заказам выходило 30.6%, по общей выручке —
// 7.7%, ровно как в кабинете XWAY. Сверка на «Пушкарах» 26-30.08: расход 355 470 ₽,
// общая сумма заказов 4 608 116 ₽, 1 311 заказов — цифра в цифру с экраном продавца.
// Не возвращай `rub` (заказы с рекламы) в знаменатель ДРР.
//
// ДВА ДРР, И ОБА НУЖНЫ:
//   · общий — расход ÷ вся выручка этого артикула;
//   · с ассоциативными — расход ÷ (вся выручка этого + заказы ДРУГИХ артикулов, пришедшие
//     с этой рекламы). Продавец рекламирует «лошадку» — источник трафика: если у неё
//     самой ДРР плохой, но с учётом всех пришедших продаж экономика сходится,
//     выключать её незачем.
//
// ФАЙЛ: выгрузка XWAY, лист «Страница 1». Колонки по имени: «Артикул WB» · «Расход, руб.» ·
// «Заказы, шт» · «Заказы, руб.» · «Показы» · «Клики» · «Корзины» · «Заказы др. артикулов, шт.»
// · «Заказы др. артикулов, руб.» · «Активных РК». Период — из имени файла (ДДММГГГГ x2).
//
// Использование: node scripts/update-ads-perf.cjs <выгрузка.xlsx> [с ГГГГ-ММ-ДД] [по ГГГГ-ММ-ДД]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2];
if(!file){console.error('usage: node scripts/update-ads-perf.cjs <выгрузка.xlsx> [с] [по]');process.exit(1);}
const S=v=>(''+(v==null?'':v)).replace(/ /g,' ').replace(/\s+/g,' ').trim();
// «10,000.00 ₽» → 10000 ; «26 459,00» → 26459
const num=v=>{ const t=S(v).replace(/[₽\s ]/g,'');
  if(!t) return 0;
  const s = /,\d{3}(\D|$)/.test(t) || /\.\d{2}$/.test(t) ? t.replace(/,/g,'') : t.replace(/,/g,'.');
  const n=parseFloat(s); return isNaN(n)?0:n; };

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const bySku={}; RD.catalog.forEach(c=>bySku[''+c.sku]=c);

/* Период из имени файла. Продавец шлёт даты В ДВУХ ФОРМАТАХ: XWAY пишет ГГГГММДД
   («…20260826__20260830»), а выгрузки аналитики ВБ — ДДММГГГГ («…27082026»).
   Различаем по первым двум цифрам: «20» + месяц 01-12 → это год, иначе день. */
function isoFrom8(t){
  if(/^20\d{6}$/.test(t)){ const mm=+t.slice(4,6), dd=+t.slice(6,8);
    if(mm>=1&&mm<=12&&dd>=1&&dd<=31) return t.slice(0,4)+'-'+t.slice(4,6)+'-'+t.slice(6,8); }
  const m=t.match(/^(\d{2})(\d{2})(20\d{2})$/);
  if(m && +m[2]>=1 && +m[2]<=12) return m[3]+'-'+m[2]+'-'+m[1];
  return null; }
function periodFromName(f){ const b=path.basename(f);
  const all=[...b.matchAll(/\d{8}/g)].map(m=>isoFrom8(m[0])).filter(Boolean);
  const u=[...new Set(all)].sort();
  return u.length>=2? {from:u[0],to:u[u.length-1]} : (u.length===1? {from:u[0],to:u[0]} : null); }
const p=periodFromName(file)||{};
const FROM=process.argv[3]||p.from, TO=process.argv[4]||p.to;
if(!FROM||!TO){ console.error('не понял период — укажите: <файл> <с ГГГГ-ММ-ДД> <по ГГГГ-ММ-ДД>'); process.exit(1); }

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false,defval:''});
let hr=-1;
for(let i=0;i<Math.min(8,rows.length);i++){
  const H=(rows[i]||[]).map(S);
  if(H.indexOf('Артикул WB')>=0 && H.some(x=>/^Расход/i.test(x))){ hr=i; break; } }
if(hr<0){ console.error('не нашёл шапку с «Артикул WB» и «Расход»'); process.exit(1); }
const H=rows[hr].map(S);
const col=re=>H.findIndex(x=>re.test(x));
const iSku=H.indexOf('Артикул WB'), iSpend=col(/^Расход/i), iOrd=col(/^Заказы, шт/i),
  iRub=col(/^Заказы, руб/i), iImp=col(/^Показы$/i), iClk=col(/^Клики$/i), iCart=col(/^Корзины$/i),
  iOthQ=col(/^Заказы др\. артикулов, шт/i), iOthR=col(/^Заказы др\. артикулов, руб/i),
  iRk=col(/^Активных РК/i),
  iTotQ=col(/^Общее количество заказов/i), iTotR=col(/^Общая сумма заказов/i);
if(iSpend<0||iRub<0){ console.error('нет колонок «Расход» / «Заказы, руб.»'); process.exit(1); }

const bySkuPerf={}; let n=0, noAd=0, miss=0, tSpend=0, tRub=0, tOth=0, tOrd=0, tTotRub=0, tTotOrd=0;
for(let i=hr+1;i<rows.length;i++){
  const sku=S(rows[i][iSku]); if(!sku) continue;
  const spend=num(rows[i][iSpend]);
  const rk=iRk>=0? num(rows[i][iRk]) : 0;
  if(!bySku[sku]){ miss++; continue; }                // карточки нет в снимке каталога
  /* КАРТОЧКИ БЕЗ РЕКЛАМЫ ТОЖЕ КЛАДЁМ В СНИМОК (решение продавца 01.09.2026).
     ДРР он смотрит по ВСЕЙ склейке, как в кабинете XWAY: знаменатель — выручка всех
     карточек склейки, включая нерекламируемые, потому что «лошадка» тянет продажи
     соседям. Раньше строки с нулевым расходом отбрасывались, и знаменатель выходил
     короче кабинета: по «Пушкарам» 26–30.08 получалось 3 143 218 ₽ и ДРР 11.3%
     против 4 608 116 ₽ и 7.7% на его экране. Не возвращай пропуск нулевых строк. */
  const e={spend, rk,
    imp:iImp>=0?num(rows[i][iImp]):0, clicks:iClk>=0?num(rows[i][iClk]):0,
    carts:iCart>=0?num(rows[i][iCart]):0,
    ord:iOrd>=0?num(rows[i][iOrd]):0, rub:num(rows[i][iRub]),
    othOrd:iOthQ>=0?num(rows[i][iOthQ]):0, othRub:iOthR>=0?num(rows[i][iOthR]):0,
    // ВСЯ выручка артикула за период — это и есть база ДРР
    totOrd:iTotQ>=0?num(rows[i][iTotQ]):0, totRub:iTotR>=0?num(rows[i][iTotR]):0};
  bySkuPerf[sku]=e; if(spend>0) n++; else noAd++;
  tSpend+=e.spend; tRub+=e.rub; tOth+=e.othRub; tOrd+=e.ord;
  tTotRub+=e.totRub; tTotOrd+=e.totOrd;
}
/* НАКОПИТЕЛЬ ПО ПЕРИОДАМ (просьба продавца 01.09.2026). Выгрузки приходят кусками —
   26–30.08, потом 31.08, потом следующий день. Раньше новая заливка ЗАМЕНЯЛА старую,
   и по одному дню ДРР получался шумный (расход сегодня, а заказы по этой рекламе
   приходят и завтра), а главное — нельзя было увидеть, что изменилось после наших
   действий: снизили ставку → что стало.
   Теперь каждая выгрузка ложится отдельной частью `parts[]`, а `bySku` — их сумма
   (периоды не пересекаются, поэтому расход/заказы/показы складываются честно).
   ПОВТОРНАЯ ЗАЛИВКА ТОГО ЖЕ ПЕРИОДА НЕ ДВОИТСЯ: часть с пересекающимися датами
   заменяется целиком, о чём скрипт печатает. */
const today=new Date().toISOString().slice(0,10);
const prev=RD.adPerf||null;
let parts = prev && prev.parts ? prev.parts.slice()
          : (prev && prev.bySku ? [{from:prev.from,to:prev.to,loadedAt:prev.loadedAt,bySku:prev.bySku}] : []);
const replaced = parts.filter(p=>!(p.to<FROM || p.from>TO));
parts = parts.filter(p=>(p.to<FROM || p.from>TO));
parts.push({from:FROM,to:TO,loadedAt:today,bySku:bySkuPerf});
parts.sort((a,b)=>a.from<b.from?-1:1);
const SUMK=['spend','imp','clicks','carts','ord','rub','othOrd','othRub','totOrd','totRub'];
const merged={};
parts.forEach(p=>Object.entries(p.bySku).forEach(([sku,e])=>{
  const m=merged[sku]||(merged[sku]={spend:0,rk:0,imp:0,clicks:0,carts:0,ord:0,rub:0,othOrd:0,othRub:0,totOrd:0,totRub:0});
  SUMK.forEach(k=>m[k]+=e[k]||0);
  m.rk=Math.max(m.rk,e.rk||0);                       // «активных РК» не складываем
}));
RD.adPerf={from:parts[0].from, to:parts[parts.length-1].to, loadedAt:today,
  bySku:merged, parts};

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const F=v=>Math.round(v).toLocaleString('ru-RU');
console.log('Реклама за '+FROM+' … '+TO+': карточек с кампанией '+n
  +' · без рекламы (идут в знаменатель ДРР склейки): '+noAd
  +(miss? ' · нет в каталоге ВБ: '+miss : ''));
if(replaced.length) console.log('  ВНИМАНИЕ: этот период пересёкся с уже залитым — заменено: '
  +replaced.map(p=>p.from+'…'+p.to).join(', '));
console.log('\nНакоплено выгрузок: '+parts.length+' (сумма идёт в расчёт ДРР и CPO)');
parts.forEach(p=>{ const sp=Object.values(p.bySku).reduce((a,e)=>a+(e.spend||0),0);
  const rb=Object.values(p.bySku).reduce((a,e)=>a+(e.totRub||0),0);
  console.log('   '+p.from+' … '+p.to+'  расход '+F(sp).padStart(9)+' ₽ · выручка '+F(rb).padStart(11)
    +' ₽ · ДРР в заказах '+(rb? (sp/rb*100).toFixed(1):'—')+'%'
    +(p.from===FROM&&p.to===TO? '   ← этот файл':'')); });
for(let i=1;i<parts.length;i++){
  const prevEnd=new Date(parts[i-1].to), curStart=new Date(parts[i].from);
  const gap=Math.round((curStart-prevEnd)/864e5)-1;
  if(gap>0) console.log('   ПРОПУСК '+gap+' дн между '+parts[i-1].to+' и '+parts[i].from+' — расход за них не учтён');
}
console.log('');
console.log('  расход:                 '+F(tSpend)+' ₽');
console.log('  ВСЯ выручка товаров:    '+F(tTotOrd)+' шт · '+F(tTotRub)+' ₽');
console.log('  ОБЩИЙ ДРР в заказах:    '+(tTotRub? (tSpend/tTotRub*100).toFixed(1):'—')+'%   ← как в кабинете XWAY');
console.log('  + заказы др. артикулов: '+F(tOth)+' ₽ · ДРР с ними '+((tTotRub+tOth)? (tSpend/(tTotRub+tOth)*100).toFixed(1):'—')+'%');
console.log('  (справочно: заказы С РЕКЛАМЫ '+F(tOrd)+' шт · '+F(tRub)+' ₽)');
const bw=RD.meta&&RD.meta.buyoutWin&&RD.meta.buyoutWin.all;
if(bw) console.log('  ДРР В ВЫКУПЕ (цель ≤7%): общий '+(tTotRub? (tSpend/(tTotRub*bw)*100).toFixed(1):'—')
  +'% · с другими артикулами '+((tTotRub+tOth)? (tSpend/((tTotRub+tOth)*bw)*100).toFixed(1):'—')
  +'%   (выкуп '+(bw*100).toFixed(0)+'%)');
console.log('\nДальше: node scripts/encrypt.cjs <код>');
