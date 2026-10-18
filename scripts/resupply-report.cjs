// Отчёт «нужен ли подсорт» — считает то же, что вид «Подсорт со склада» в дашборде,
// но в консоли. ЗАПУСКАТЬ ПОСЛЕ ЛЮБОГО ОБНОВЛЕНИЯ ОСТАТКОВ (ВБ, Озон, свой склад) —
// это правило продавца: после каждой заливки он хочет видеть, что и куда отгружать.
//
// Правила (совпадают с index.html):
//   покрытие ВБ   = остаток на складах WB + открытые отгрузки из журнала (REAL_DATA.shipments);
//   покрытие Озон = остаток + ozTransit (заявки и партии, которые показывает сам Озон);
//   продаж/дн     = заказы за 7 дней ÷ 7 × % выкупа;
//   нужно до цели = ceil(продаж/дн × RESUPPLY_DAYS) − покрытие;
//   склада не хватает на обе площадки → ПРИОРИТЕТ ОЗОНУ, ВБ получает остаток;
//   отгрузка только целыми ПАЛЛЕТАМИ (вместимость у площадок разная), стартовая партия
//   округляется вверх; PALLETS_PER_TRUCK=33 паллеты = машина с одного склада на одну площадку.
//
// Использование: node scripts/resupply-report.cjs [дней=30] [сколько строк показать=15]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DAYS=parseInt(process.argv[2],10)||30;
const LAUNCH_QTY=500;   // товара нет на площадке и продаж нет → стартовая партия
const TOP=parseInt(process.argv[3],10)||15;

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
// воронка ВБ нужна для % выкупа по окну (лежит в отчётах, а не в каталоге)
let FUNNEL_WB=[];
try{ const c2={};vm.createContext(c2);
  vm.runInContext(fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
    +'\nglobalThis.__F=(typeof BAKED_FUNNEL!=="undefined"? BAKED_FUNNEL:[]);',c2);
  FUNNEL_WB=c2.__F||[]; }catch(e){ FUNNEL_WB=[]; }
const F=n=>Math.round(n).toLocaleString('ru-RU');
const D=v=>v===Infinity?'∞':Math.round(v);

// % выкупа по окну «пропустить последнюю неделю, взять две предыдущие» — та же логика,
// что buyoutFromFunnel/buyoutOf в index.html (держи синхронно). Незрелому окну не верим:
// выкуп в снимке заморожен на момент выгрузки и задним числом не обновляется.
const BUYOUT_HOLD=7, BUYOUT_WIN=14, BUYOUT_MIN_ORD=10;
const addD=(d,n)=>{const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
function buyoutFromFunnel(funnel){
  if(!funnel||!funnel.length) return null;
  const ds=[...new Set(funnel.map(r=>r.date))].sort();
  const to=addD(ds[ds.length-1],-BUYOUT_HOLD), from=addD(to,-(BUYOUT_WIN-1));
  const rows=funnel.filter(r=>r.date>=from&&r.date<=to);
  if(!rows.length) return null;
  const bySku={}; let o=0,b=0;
  rows.forEach(r=>{ const e=bySku[r.sku]||(bySku[r.sku]={o:0,b:0});
    e.o+=r.ordersQty||0; e.b+=r.buyoutQty||0; o+=r.ordersQty||0; b+=r.buyoutQty||0; });
  if(!o) return null;
  // зрелость: день с заказами, но почти без выкупа = выкуп ещё не проставлен (см. index.html)
  const byDate={};
  rows.forEach(r=>{ const e=byDate[r.date]||(byDate[r.date]={o:0,b:0});
    e.o+=r.ordersQty||0; e.b+=r.buyoutQty||0; });
  const dead=Object.keys(byDate).filter(d=>byDate[d].o>=20&&byDate[d].b/byDate[d].o<0.15).sort();
  return {from,to,all:b/o,bySku,dead,mature:dead.length===0,days:Object.keys(byDate).length};
}
// У ВБ приоритет — измеренное окно из сводного отчёта (scripts/wb-buyout-window.cjs).
// См. buyoutInfo в index.html: держи синхронно.
function wbMeasured(){ const b=RD.meta&&RD.meta.buyoutWin;
  return (b&&b.all>0)? {from:b.from,to:b.to,all:b.all,pctBySku:b.bySku||{},dead:[],
    mature:true,measured:true,openPct:b.openPct,days:null} : null; }
/* ОЗОН — ТО ЖЕ ПРАВИЛО, ЧТО У ВБ (решение продавца 21.09.2026). Замер из отчёта аналитики
   за период бьёт подённую воронку: воронка заморожена на момент выгрузки и занижает выкуп
   у свежих дней. Берём ПОСЛЕДНИЙ замер — подсорт смотрит вперёд, ему нужен действующий
   процент. Дубль buyoutInfo из index.html, держи синхронно. */
function ozMeasured(){ const H=(RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutWin&&RD.ozon.meta.buyoutWin.history)||null;
  if(!H||!H.length) return null;
  const last=H.slice().sort((a,b)=>(a.builtAt||'')<(b.builtAt||'')?-1:1).pop();
  return (last&&last.all>0)? {from:last.from,to:last.to,all:last.all,pctBySku:last.bySku||{},
    dead:[],mature:true,measured:true,days:null} : null; }
const BW={ wb: wbMeasured()||buyoutFromFunnel(FUNNEL_WB),
           ozon: ozMeasured()||buyoutFromFunnel((RD.ozon&&RD.ozon.funnel)||[]) };
function buyoutOf(mp,sku,fallback){
  const bi=BW[mp];
  if(!bi || !bi.mature) return fallback;
  if(bi.pctBySku){ const p=bi.pctBySku[sku]; return p>0? p : bi.all; }
  const e=bi.bySku[sku];
  return (e && e.o>=BUYOUT_MIN_ORD) ? e.b/e.o : bi.all;
}
function mpStats(mp){
  const oz=mp==='ozon';
  const cat = oz? ((RD.ozon&&RD.ozon.catalog)||[]) : RD.catalog;
  const ser = oz? ((RD.ozon&&RD.ozon.orderSeries&&RD.ozon.orderSeries.byArt)||{}) : RD.orderSeries.bySku;
  const dates = oz? ((RD.ozon&&RD.ozon.orderSeries&&RD.ozon.orderSeries.dates)||[]) : RD.orderSeries.dates;
  const last=dates.length-1, days=Math.min(7,dates.length);
  const buyAvg = oz? ((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutAll)||1)
    : (()=>{const v=RD.catalog.map(c=>c.buyoutPct14d).filter(x=>x>0);return v.length? v.reduce((a,b)=>a+b,0)/v.length/100:1;})();
  const openShip={}; (RD.shipments||[]).forEach(s=>{ if(s.mp==='wb'&&s.left>0) openShip[s.sup]=(openShip[s.sup]||0)+s.left; });
  /* «РВБ Клин» — товар собран и назначен к отправке на ВБ (продавец 05.10.2026). Физически
     ещё лежит на Клине, но распоряжён, поэтому идёт в ту же строку, что журнал отгрузок:
     в `transit` у ВБ, и тем самым уменьшает потребность подсорта. Синхронно с index.html. */
  if(!oz){ const kl=klinBySup(); Object.keys(kl).forEach(k=>{ openShip[k]=(openShip[k]||0)+kl[k]; }); }
  /* Симметрично для Ozon — виртуальные склады «Ozon СФО»/«Ozon ЦФО» (13.10.2026): товар
     уже распределён на площадку и ждёт машину, значит он тоже «в пути». НО это НЕ слагаемое
     к `ozTransit`: заявка Озона и виртуальный склад — ОДНА партия в двух отчётах (правка
     продавца 13.10, см. `ozTransitEff` в index.html). Арифметика:
     `в пути = «в поставках в пути» + max(«в заявках», виртуальный склад)`. Синхронно с index.html. */
  const ozAsg = oz? ozAssignedBySup() : {};
  const out={}, done=new Set();
  cat.forEach(c=>{
    const sup = oz? (''+c.sku) : (''+(c.supplierCode||'')).trim(); if(!sup) return;
    const s=ser[c.sku]; let sum=0; if(s) for(let i=Math.max(0,last-6);i<=last;i++) sum+=s[i]||0;
    const avgD=days? sum/days:0;
    const buyout = buyoutOf(mp, c.sku,
      oz? (c.ozBuyout!=null?c.ozBuyout:buyAvg) : (c.buyoutPct14d>0? c.buyoutPct14d/100 : buyAvg));
    const stock = oz? (c.ozStock||0) : (c.wbStock||0);   // свой склад в покрытие НЕ входит
    let transit = oz? (c.ozTransit||0) : 0;
    if(!done.has(sup)){
      if(oz){ const az=ozAsg[sup]; transit=ozTransitEff(c, az? az.all : 0); }
      else transit+=(openShip[sup]||0);
      done.add(sup);
    }
    const e=out[sup]||(out[sup]={spd:0,stock:0,transit:0,name:c.name});
    e.spd+=avgD*buyout; e.stock+=stock; e.transit+=transit; if(!e.name) e.name=c.name;
  });
  /* Код уже распределён на Ozon, а карточки Озона ещё нет (519571/519588 на 13.10.2026):
     цикл выше идёт по каталогу площадки и такой код пропустил бы, покрытие вышло бы 0,
     и подсорт отправил бы стартовую партию поверх назначенного. Синхронно с index.html. */
  if(oz) Object.keys(ozAsg).forEach(sup=>{ if(out[sup]) return;
    out[sup]={spd:0,stock:0,transit:ozAsg[sup].all,name:sup}; done.add(sup); });
  Object.values(out).forEach(e=>{ e.covered=e.stock+e.transit;
    e.days = e.spd>0? e.covered/e.spd : (e.covered>0? Infinity:0); });
  return out;
}

const W=mpStats('wb'), O=mpStats('ozon');
const wh=(RD.warehouse&&RD.warehouse.bySup)||{};
const inb=RD.inbound||{};
/* Партий производства несколько, у каждой свой срок прихода (см. `inbKeys()` в index.html
   и `scripts/prod-order.cjs`). Перечисляем ВСЕ ключи кроме `china`, а не имя `order`, —
   иначе скрипт разойдётся с дашбордом на величину второй партии. */
const chinaBy=(inb.china&&inb.china.bySup)||{}, orderBy={};
Object.keys(inb).filter(k=>k!=='china'&&inb[k]&&inb[k].bySup)
  .forEach(k=>Object.entries(inb[k].bySup).forEach(([s,q])=>orderBy[s]=(orderBy[s]||0)+q));
const zero={spd:0,covered:0,days:0,name:''};
const PAL=(RD.pallets&&RD.pallets.bySup)||{};
const PALLETS_PER_TRUCK=33;
/* ТРИ СКЛАДА И МАРШРУТЫ (редакция 21.09.2026) — держи синхронно с index.html:
     Москва «СХ Солнечногорск» — FBS для Wildberries + поставки на Ozon и на ВБ FBO;
     Нск-1 «Склад FBS»         — FBS для Wildberries + поставки на Ozon и на ВБ FBO;
     Нск-2 «Склад Евросиб»     — поставки на Ozon и на ВБ FBO (позиции от NSK2_MIN_TAKE шт).
   До 21.09 Москва не отгружала никуда, а поставок на склады WB не было вовсе — обе
   отмены сделал сам продавец, не «чини» обратно. Машина по-прежнему собирается
   с ОДНОГО склада на ОДНУ площадку: «машины я буду набивать в разрезе определенного склада».
   Оборачиваемость и решение по цене по-прежнему считаются по ВСЕМУ запасу. */
/* ПОСТАВКИ НА ВБ FBO СНОВА ИДУТ (правило продавца 21.09.2026, отменяет запрет от 27.08):
   «я могу отправить с Евросиба так же товар на Ozon и на вб Fbo». Тогда же снят запрет
   «Москва на Ozon» (стоял с 11.09). Все ТРИ склада отгружают на ОБЕ площадки; порядок
   разбора — Евросиб → Нск-1 → Москва, сначала Ozon целиком, остатком — ВБ FBO.
   На Евросибе позиции с остатком меньше NSK2_MIN_TAKE не берём. Держи синхронно с index.html. */
/* «РВБ Клин» — ПЯТЫЙ СВОЙ СКЛАД (05.10.2026), и он НЕ ОТГРУЖАЕТ НИЧЕГО. Продавец:
   «я уже отправил товары, которые находятся там, на Wb … его в подсорт считать не нужно,
   просто учитывай этот остаток при расчёте поставок с других складов». Поэтому Клин — это
   товар В ПУТИ НА ВБ: он складывается в `transit` у ВБ и уменьшает потребность, которую
   закрывают остальные склады; в отгрузочный запас (`have`) и в «останется на складе»
   не входит. Правило ловит именно «Клин»: общее /рвб/ поймало бы «Склад РВБ ПФО» —
   баг выгрузки, который считать нельзя. Держи синхронно с index.html. */
const WB_FBO_SUPPLY=true, NSK1_MIN_DAYS=14, NSK2_MIN_TAKE=100;
/* РОЗНИЧНЫЙ РЕЗЕРВ 250 ШТ НА АРТИКУЛ, ОБЩИЙ ДЛЯ ЕВРОСИБА И НСК-1 (правило продавца 08.10.2026):
   своб.Евросиб = max(0, Евросиб − 250); держим на FBS = max(0, 250 − Евросиб);
   своб.FBS = max(0, FBS − держим). НЕ БОЛЬШЕ 6 КОДОВ В МАШИНЕ (он же, тогда же).
   До 15.10.2026 оба правила жили только в памятке. Держи синхронно с index.html. */
// Розничный резерв ОТМЕНЁН 18.10.2026 (ЗАП-04): выгрузка складов — уже свободный остаток. Держи синхронно с index.html.
const RETAIL_RESERVE=0, MAX_CODES_PER_TRUCK=6;
const SRC_WB=['nsk2','nsk1','msk'], SRC_OZ=['nsk2','nsk1','msk'];
function klinBySup(){ const wh=(RD.warehouse&&RD.warehouse.bySup)||{}, out={};
  Object.keys(wh).forEach(s=>{ let q=0;
    Object.entries(wh[s].wh||{}).forEach(([n,v])=>{ if(whKey(n)==='klin') q+=v; });
    if(q>0) out[s]=q; });
  return out; }
/* Назначено на Ozon (виртуальные склады СФО/ЦФО) — то же, что klinBySup, но направление Ozon. */
function ozAssignedBySup(){ const wh=(RD.warehouse&&RD.warehouse.bySup)||{}, out={};
  Object.keys(wh).forEach(s=>{ let sfo=0,cfo=0;
    Object.entries(wh[s].wh||{}).forEach(([n,v])=>{ const k=whKey(n);
      if(k==='ozsfo') sfo+=v; else if(k==='ozcfo') cfo+=v; });
    if(sfo+cfo>0) out[s]={sfo,cfo,all:sfo+cfo}; });
  return out; }
/* «В пути на Ozon» по карточке: «в поставках в пути» + max(«в заявках», назначенное у нас).
   Две стадии хранятся порознь (`ozReq`/`ozWay`), потому что виртуальный склад ведомости 1С
   и заявка Озона — один и тот же товар, увиденный двумя отчётами с разной скоростью.
   Карточка без разделения (старый снимок) → считаем весь `ozTransit` заявками: осторожный
   max, без задвоения. ДЕРЖИ СИНХРОННО с `ozTransitEff` в index.html. */
function ozTransitEff(card, assigned){
  const tot=(card&&card.ozTransit)||0;
  const split=card && card.ozReq!=null && card.ozWay!=null;
  const req=split? (card.ozReq||0) : tot, way=split? (card.ozWay||0) : 0;
  return way + Math.max(req, assigned||0); }
function whKey(n){ const s=''+n;
  // виртуальные склады Ozon — первыми и по ПАРЕ слов: общее /озон/ поймало бы «Склад ОЗОН ПФО»
  if(/(озон|ozon)/i.test(s) && /сфо/i.test(s)) return 'ozsfo';
  if(/(озон|ozon)/i.test(s) && /цфо/i.test(s)) return 'ozcfo';
  if(/клин/i.test(s)) return 'klin';
  if(/(^|\W)fbs(\W|$)|фбс/i.test(s)) return 'nsk1';
  if(/евросиб/i.test(s)) return 'nsk2';
  if(/солнечногор|москв|(^|\W)мск(\W|$)/i.test(s)) return 'msk';
  if(/новосиб|(^|\W)нск(\W|$)/i.test(s)) return 'nsk2';
  return 'other'; }
// «На вывод» исключаем из подсорта целиком (просьба продавца): товар выводится из
// ассортимента, везти его на площадку незачем. Считаем по ВСЕМ карточкам кода 1С —
// если хоть одна НЕ «На вывод», товар живой. В дозаказе/закупе статус по-прежнему справочный.
const outSup=new Set(); {
  const st={}; (RD.catalog||[]).forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(!s) return;
    const out=(''+(c.productionStatus||'')).trim()==='На вывод';
    st[s]=(st[s]===undefined)? out : (st[s]&&out); });
  // выводимый товар, который ЛЕЖИТ НА СКЛАДЕ, в подсорте остаётся — его надо распродать
  Object.keys(st).forEach(s=>{ if(st[s] && !((wh[s]&&wh[s].qty)>0)) outSup.add(s); });
}
const sups=[...new Set([...Object.keys(W),...Object.keys(O),...Object.keys(wh)])].filter(s=>!outSup.has(s));
let rows=sups.map(sup=>{
  const w=W[sup]||zero, o=O[sup]||zero;
  // раскладку склада считаем ДО потребности: Клин надо вычесть из отгрузочного запаса
  const whB=(wh[sup]&&wh[sup].wh)||{}; const q={msk:0,nsk1:0,nsk2:0,klin:0,ozsfo:0,ozcfo:0,other:0};
  Object.entries(whB).forEach(([n,v])=>{ q[whKey(n)]+=v; });
  const mMsk=q.msk, mNsk1=q.nsk1, mNsk2=q.nsk2, mKlin=q.klin, mOzAsg=q.ozsfo+q.ozcfo;
  // `have` — то, что РЕАЛЬНО можно отгрузить: склад МИНУС Клин МИНУС назначенное на Ozon
  const have=Math.max(0, ((wh[sup]&&wh[sup].qty)||0) - mKlin - mOzAsg);
  // розничный резерв: сначала на Евросибе, недостающее до RETAIL_RESERVE — на Нск-1
  const holdNsk2=Math.min(mNsk2,RETAIL_RESERVE), holdNsk1=Math.min(mNsk1,Math.max(0,RETAIL_RESERVE-mNsk2));
  const availNsk2=(mNsk2>=NSK2_MIN_TAKE? mNsk2-holdNsk2 : 0), availNsk1=mNsk1-holdNsk1;
  const retailHold=holdNsk2+holdNsk1, haveShip=Math.max(0,have-retailHold);
  const launchW = WB_FBO_SUPPLY && w.spd<=0 && w.covered<=0 && haveShip>0;
  const launchO = o.spd<=0 && o.covered<=0 && haveShip>0;
  const needW=!WB_FBO_SUPPLY? 0
    : (launchW? Math.min(LAUNCH_QTY,haveShip) : Math.max(0,Math.ceil(w.spd*DAYS)-w.covered));
  const needO=launchO? Math.min(LAUNCH_QTY,haveShip) : Math.max(0,Math.ceil(o.spd*DAYS)-o.covered);
  const P=PAL[sup]||null, palOz=P?(P.oz||0):0, palWb=P?(P.wb||0):0;
  // леджер остатка по складам: из него берут ОБА прохода, порядок задают SRC_OZ / SRC_WB
  const pool={nsk2:availNsk2, nsk1:availNsk1, msk:mMsk};
  // Округляем ВВЕРХ (решение продавца 24.08) — округление вниз систематически не дотягивало
  // до цели 30 дней. Держи синхронно с takePallets в index.html.
  const take=(needQty,cap,src)=>{ if(cap<=0) return null;
    const want=Math.ceil(needQty/cap);
    const pals={nsk1:0,nsk2:0,msk:0}, pcs={nsk1:0,nsk2:0,msk:0};
    if(want<=0) return {pal:0,pals,pcs,qty:0};
    let left=want;
    for(const k of src){ const p=Math.min(left,Math.floor(pool[k]/cap));
      pals[k]=p; pcs[k]=p*cap; pool[k]-=p*cap; left-=p; }
    const pal=src.reduce((a,k)=>a+pals[k],0);
    return {pal,pals,pcs,qty:pal*cap}; };
  const takePcs=(needQty,src)=>{
    const pals={nsk1:0,nsk2:0,msk:0}, pcs={nsk1:0,nsk2:0,msk:0};
    let left=needQty, qty=0;
    for(const k of src){ const q=Math.min(left,pool[k]); pcs[k]=q; pool[k]-=q; left-=q; qty+=q; }
    return {pal:0,pals,pcs,qty}; };
  let shipO=0,shipW=0,palO=0,palW=0,oN1=0,oN2=0,oM=0,wN1=0,wN2=0,wM=0;
  let usedNsk1=0,usedNsk2=0,usedMsk=0;
  const takeFor=(need,cap,src)=>{ const t = cap>0? take(need,cap,src) : takePcs(need,src);
    usedNsk2+=t.pcs.nsk2; usedNsk1+=t.pcs.nsk1; usedMsk+=t.pcs.msk; return t; };
  const tO=takeFor(needO,palOz,SRC_OZ);
  palO=tO.pal; shipO=tO.qty; oN1=tO.pals.nsk1; oN2=tO.pals.nsk2; oM=tO.pals.msk;
  if(WB_FBO_SUPPLY && needW>0){ const tW=takeFor(needW,palWb,SRC_WB);
    palW=tW.pal; shipW=tW.qty; wN1=tW.pals.nsk1; wN2=tW.pals.nsk2; wM=tW.pals.msk; }
  // перемещение Евросиб → Нск-1 вместо отгрузки на ВБ (FBS уходит покупателю с Нск-1)
  // на Нск-1 смотрим то, что там РЕАЛЬНО останется: минус паллеты, забранные Озоном
  const nsk1Free = Math.max(0, mNsk1-usedNsk1);
  const nsk1Days = w.spd>0 ? nsk1Free/w.spd : (nsk1Free>0? Infinity : 0);
  const moveNeed = (!WB_FBO_SUPPLY && w.spd>0 && nsk1Days<NSK1_MIN_DAYS)
    ? Math.max(0, Math.ceil(w.spd*NSK1_MIN_DAYS)-nsk1Free) : 0;
  const move = Math.min(moveNeed, Math.max(0,pool.nsk2));
  pool.nsk2-=move; usedNsk2+=move;
  /* ПОКРЫТИЕ ВБ = остаток на складах WB + свободный FBS-запас (вся Москва + Нск-1 минус
     то, что забрал Ozon). Держи синхронно с wbFbsBySup/resupplyRows в index.html. */
  const mskFree = Math.max(0, mMsk-usedMsk);
  const wbFbsFree = mskFree + nsk1Free;
  const wCovAll = w.covered + wbFbsFree;
  const wDaysAll = w.spd>0 ? wCovAll/w.spd : (wCovAll>0? Infinity : 0);
  return {sup,name:(w.name||o.name||sup),have,haveShip,retailHold,availNsk1,availNsk2,palOz,palWb,palO,palW,oN1,oN2,oM,wN1,wN2,wM,
    whMsk:mMsk,whNsk1:mNsk1,whNsk2:mNsk2,whKlin:mKlin,whNsk:mNsk1+mNsk2,usedNsk1,usedNsk2,usedMsk,
    oCov:o.covered,wCov:w.covered,topUpO:0,topUpW:0,
    noPal:(!P&&needO>0), move, moveNeed, nsk1Days, nsk1Free, mskFree, wbFbsFree, wCovAll, wDaysAll,
    wDays:w.days,oDays:o.days,wSpd:w.spd,oSpd:o.spd,needW,needO,shipW,shipO,
    rest:have-shipO-shipW-move, china:chinaBy[sup]||0, order:orderBy[sup]||0, launch:launchO,
    minDays:Math.min(w.spd>0?w.days:Infinity,o.spd>0?o.days:Infinity)};
});

// ---- НЕПОЛНЫХ МАШИН НЕ БЫВАЕТ, УПАКОВКА (та же логика, что в index.html — держи синхронно) ----
// Правило продавца 09.09.2026, внесено в дашборд 15.10.2026: каждую неполную машину направления
// добиваем до 33 паллет свободным товаром ТОГО ЖЕ склада (после резерва): по паллете коду, у
// которого запас на площадке кончится раньше; новый код — только если с ним машину ещё можно
// добить и кодов ≤ MAX_CODES_PER_TRUCK. Потолка по сроку продажи нет. Добить нечем — машина не
// едет ЦЕЛИКОМ (паллеты возвращаются на склад, rollO/rollW). Сначала Ozon, внутри — где паллет больше.
const TRUCK_WH=['Евросиб','Нск-FBS','Мск'];
const truckPal=(r,wh,mp)=>r[(mp==='ozon'?'o':'w')+({'Евросиб':'N2','Нск-FBS':'N1','Мск':'M'})[wh]]||0;
const truckItems=(wh,mp)=>rows.map(r=>({sup:r.sup,name:r.name,pal:truckPal(r,wh,mp),
  days:(mp==='ozon'? r.oDays : r.wDays)})).filter(x=>x.pal>0);
// упаковка: ≤ MAX_CODES_PER_TRUCK кодов и ≤ 33 паллет; последний слот — тому, кто добьёт машину
function packTrucks(items){
  const dk=d=>d===Infinity? 1e9 : (d||0);
  const pool=items.map(x=>({...x,left:x.pal}))
    .sort((a,b)=>dk(a.days)-dk(b.days) || b.pal-a.pal || (a.sup<b.sup?-1:(a.sup>b.sup?1:0)));
  const trucks=[];
  while(pool.some(x=>x.left>0)){
    const t={pallets:0,free:PALLETS_PER_TRUCK,items:[]};
    while(t.free>0 && t.items.length<MAX_CODES_PER_TRUCK){
      const live=pool.filter(x=>x.left>0); if(!live.length) break;
      const c=(MAX_CODES_PER_TRUCK-t.items.length>1)? live[0]
        : (live.find(x=>x.left>=t.free) || live.reduce((m,x)=>x.left>m.left? x : m));
      const take=Math.min(c.left,t.free);
      t.items.push({sup:c.sup,pal:take}); c.left-=take; t.free-=take; t.pallets+=take; }
    trucks.push(t); }
  return trucks;
}
/* КОНСОЛИДАЦИЯ СЛОТОВ (18.10.2026). Неполная машина упёрлась в лимит кодов, а её мелкие коды уже
   едут в полных машинах того же направления: код целиком перекладываем в полную машину, а обратно
   забираем столько же паллет кодов, которые и так есть в неполной. Паллеты машин и состав
   направления не меняются, у неполной освобождается слот под добор. Без этого после отмены
   розничного резерва машина «Евросиб → ВБ» не ехала (6 мелких кодов, добить новым кодом нельзя).
   Держи синхронно с index.html. */
function truckConsolidate(t,full){
  let moved=true;
  while(moved && t.items.length>=MAX_CODES_PER_TRUCK){
    moved=false;
    const order=t.items.slice().sort((a,b)=>a.pal-b.pal || (a.sup<b.sup?-1:(a.sup>b.sup?1:0)));
    for(const c of order){
      for(const T of full){
        const tc=T.items.find(x=>x.sup===c.sup); if(!tc) continue;
        const inT=new Set(t.items.map(x=>x.sup));
        const shared=T.items.filter(x=>x.sup!==c.sup && inT.has(x.sup))
          .sort((a,b)=>a.pal-b.pal || (a.sup<b.sup?-1:(a.sup>b.sup?1:0)));
        if(shared.reduce((a,x)=>a+x.pal,0)<c.pal) continue;
        let need=c.pal; tc.pal+=c.pal;
        for(const x of shared){ if(need<=0) break; const k=Math.min(x.pal,need);
          x.pal-=k; need-=k; t.items.find(y=>y.sup===x.sup).pal+=k; }
        T.items=T.items.filter(x=>x.pal>0);
        t.items=t.items.filter(x=>x.sup!==c.sup);
        moved=true; break;
      }
      if(moved) break;
    }
  }
}
const plan=[];
// добор одной неполной машины: Map(строка → паллет) или null — см. truckFill в index.html
function truckFill(free,d,t){
  const oz=d.mp==='ozon';
  const pal=r=> oz? r.palOz : r.palWb, spd=r=> oz? r.oSpd : r.wSpd;
  const base=r=> oz? (r.oCov+r.shipO) : (r.wCov+r.shipW);
  const cand=rows.filter(r=>pal(r)>0 && spd(r)>0 && free[r.sup][d.wh]>=pal(r));
  const fr=new Map(cand.map(r=>[r,free[r.sup][d.wh]])), add=new Map();
  const inT=new Set(t.items.map(x=>x.sup));
  let left=PALLETS_PER_TRUCK-t.pallets, slots=MAX_CODES_PER_TRUCK-t.items.length;
  const capP=r=>Math.floor(fr.get(r)/pal(r));
  const days=r=>(base(r)+(add.get(r)||0)*pal(r))/spd(r);
  while(left>0){
    let inCap=0; const outs=[];
    cand.forEach(r=>{ const c=capP(r); if(c<=0) return; if(inT.has(r.sup)) inCap+=c; else outs.push(c); });
    outs.sort((a,b)=>b-a);
    const topSum=k=>{ let s=0; for(let i=0;i<k&&i<outs.length;i++) s+=outs[i]; return s; };
    let best=null, bestD=Infinity;
    for(const r of cand){
      const c=capP(r); if(c<=0) continue;
      if(!inT.has(r.sup)){
        if(slots<=0) continue;
        const k=slots-1, rest=(k>0 && c>=outs[Math.min(k,outs.length)-1])? topSum(k+1)-c : topSum(k);
        if(inCap+c+Math.max(0,rest) < left) continue;
      }
      const dd=days(r);
      if(dd<bestD || (dd===bestD && best && r.sup<best.sup)){ best=r; bestD=dd; }
    }
    if(!best) return null;
    if(!inT.has(best.sup)){ inT.add(best.sup); slots--; }
    fr.set(best,fr.get(best)-pal(best)); add.set(best,(add.get(best)||0)+1); left--;
  }
  return add;
}
(function topUp(){
  const free={}, bySup={};
  rows.forEach(r=>{ bySup[r.sup]=r; r.rollO=0; r.rollW=0;
    free[r.sup]={'Евросиб':Math.max(0,r.availNsk2-r.usedNsk2),
                 'Нск-FBS':Math.max(0,r.availNsk1-r.usedNsk1),
                 'Мск':    Math.max(0,r.whMsk -r.usedMsk)}; });
  const WK={'Евросиб':['N2','usedNsk2'],'Нск-FBS':['N1','usedNsk1'],'Мск':['M','usedMsk']};
  const shift=(r,d,pals,isTop)=>{ const oz=d.mp==='ozon', qty=pals*(oz? r.palOz : r.palWb);
    free[r.sup][d.wh]-=qty; r[WK[d.wh][1]]+=qty; r[(oz?'o':'w')+WK[d.wh][0]]+=pals;
    if(oz){ r.shipO+=qty; r.palO+=pals; if(isTop) r.topUpO+=qty; else if(pals<0) r.rollO-=qty; }
    else  { r.shipW+=qty; r.palW+=pals; if(isTop) r.topUpW+=qty; else if(pals<0) r.rollW-=qty; } };
  const dirs=[]; TRUCK_WH.forEach((wh,i)=>['ozon','wb'].forEach(mp=>
    dirs.push({wh,mp,i,total:truckItems(wh,mp).reduce((a,x)=>a+x.pal,0)})));
  dirs.sort((a,b)=>(a.mp===b.mp? 0 : (a.mp==='ozon'? -1 : 1)) || (b.total-a.total) || (a.i-b.i));
  dirs.forEach(d=>{ if(d.total<=0) return;
    const trucks=packTrucks(truckItems(d.wh,d.mp)), kept=[], dropped=[];
    trucks.forEach((t,ti)=>{
      if(t.pallets>=PALLETS_PER_TRUCK){ kept.push(t); return; }
      truckConsolidate(t,kept);
      let add=truckFill(free,d,t), cut=[];
      // не добить и после консолидации — снимаем самые мелкие коды (см. index.html)
      if(!add){
        const small=t.items.slice().sort((a,b)=>a.pal-b.pal || (a.sup<b.sup?-1:(a.sup>b.sup?1:0)));
        for(let k=1;k<small.length && !add;k++){
          const off=new Set(small.slice(0,k).map(x=>x.sup));
          const items=t.items.filter(x=>!off.has(x.sup));
          const a2=truckFill(free,d,{items,pallets:items.reduce((s,x)=>s+x.pal,0)});
          if(a2){ add=a2; cut=small.slice(0,k); }
        }
        if(add){ const off=new Set(cut.map(x=>x.sup));
          t.items=t.items.filter(x=>!off.has(x.sup));
          t.pallets=t.items.reduce((s,x)=>s+x.pal,0); t.free=PALLETS_PER_TRUCK-t.pallets;
          /* снятые коды сначала пробуем пересадить в СЛЕДУЮЩУЮ неполную машину этого же направления
             (если в ней хватает слотов и места) — тогда они едут как нужда, а не «не едет + добор» */
          const u=trucks.slice(ti+1).find(u=>u.pallets<PALLETS_PER_TRUCK
            && new Set(u.items.map(x=>x.sup).concat(cut.map(x=>x.sup))).size<=MAX_CODES_PER_TRUCK
            && u.pallets+cut.reduce((s,x)=>s+x.pal,0)<=PALLETS_PER_TRUCK);
          if(u){ cut.forEach(x=>{ const ex=u.items.find(y=>y.sup===x.sup); if(ex) ex.pal+=x.pal; else u.items.push(x);
              u.pallets+=x.pal; u.free-=x.pal; }); }
          else { cut.forEach(x=>shift(bySup[x.sup],d,-x.pal,false));
            dropped.push({pallets:cut.reduce((s,x)=>s+x.pal,0),free:0,items:cut}); } }
      }
      if(add){ add.forEach((pals,r)=>{ shift(r,d,pals,true);
          const ex=t.items.find(x=>x.sup===r.sup); if(ex) ex.pal+=pals; else t.items.push({sup:r.sup,pal:pals});
          t.pallets+=pals; t.free-=pals; });
        kept.push(t); }
      else { t.items.forEach(x=>shift(bySup[x.sup],d,-x.pal,false)); dropped.push(t); }
    });
    kept.sort((a,b)=>b.pallets-a.pallets);
    const tail=kept.filter(t=>t.pallets<PALLETS_PER_TRUCK);
    plan.push({whn:d.wh,mp:(d.mp==='ozon'?'Ozon':'ВБ FBO'),total:kept.reduce((a,t)=>a+t.pallets,0),trucks:kept,
      full:kept.length-tail.length,tail:tail.reduce((a,t)=>a+t.pallets,0),
      codes:new Set(kept.flatMap(t=>t.items.map(x=>x.sup))).size,
      dropped, droppedPal:dropped.reduce((a,t)=>a+t.pallets,0)});
  });
  plan.sort((a,b)=>b.total-a.total);
  rows.forEach(r=>{ r.rest=r.have-r.shipO-r.shipW-r.move; });
})();
const _rows=rows.filter(r=>r.needO>0||r.needW>0||r.move>0||r.moveNeed>0||r.have>0);
rows.length=0; _rows.forEach(r=>rows.push(r));

const needAny=rows.filter(r=>r.needO>0||r.needW>0);
const toShip=rows.filter(r=>r.shipO>0||r.shipW>0);
const noStock=needAny.filter(r=>r.haveShip<=0);   // Клин, назначенное на Ozon и резерв рознице — не в счёт
const urgent=needAny.filter(r=>r.minDays<DAYS/3);
// перемещение Евросиб → Нск-1 (вместо отгрузки на ВБ: поставок на склады WB больше нет)
const moveAll=rows.filter(r=>r.moveNeed>0);
const movers=moveAll.filter(r=>r.move>0).sort((a,b)=>b.move-a.move);   // сначала то, что реально везём
const moveGap=moveAll.filter(r=>r.move<=0);                            // нет и на Евросибе

['wb','ozon'].forEach(mp=>{ const b=BW[mp]; const nm=mp==='wb'?'ВБ  ':'Озон';
  if(!b){ console.log('% выкупа '+nm+': воронки нет → прежний источник'); return; }
  console.log('% выкупа '+nm+': окно '+b.from+'…'+b.to
    +(b.measured? ' (замер отчётом аналитики'+(b.openPct!=null? ', в пути '+b.openPct+'%':'')+')'
                : ' ('+b.days+'/'+BUYOUT_WIN+' дн по воронке)')
    +' → '+(b.all*100).toFixed(1)+'%'
    +(b.mature? ' · ПРИМЕНЕНО'
      : ' · НЕ ЗРЕЛО (выкуп не проставлен за '+b.dead.length+' дн: '
        +b.dead.join(', ')+') → взят прежний источник'));
});
console.log('');
console.log('ПОДСОРТ НА '+DAYS+' ДНЕЙ · остатки ВБ на '+((RD.meta&&RD.meta.stockSnapshotDate)||'—')
  +' · Озон на '+((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.stockDate)||'—')
  +' · склад на '+((RD.warehouse&&RD.warehouse.date)||'не загружен'));
console.log('─'.repeat(96));
console.log('Требуют подсорта: '+needAny.length+' позиций (из них СРОЧНО, покрытие < '+Math.round(DAYS/3)+' дн: '+urgent.length+')');
console.log('К отгрузке на Ozon: '+F(rows.reduce((a,r)=>a+r.shipO,0))+' шт'
  +'  (Евросиб, Нск-1 и Москва)');
console.log('К отгрузке на ВБ FBO: '+F(rows.reduce((a,r)=>a+r.shipW,0))+' шт'
  +'  (Евросиб, Нск-1 и Москва)');
{ const kl=klinBySup(); const tot=Object.values(kl).reduce((a,b)=>a+b,0);
  if(tot>0) console.log('На складе РВБ Клин: '+F(tot)+' шт по '+Object.keys(kl).length
    +' кодам — собрано и назначено к отправке на ВБ: в отгрузку не идёт, засчитано в покрытие'); }
{ const az=ozAssignedBySup(); const ks=Object.keys(az);
  const sfo=ks.reduce((a,k)=>a+az[k].sfo,0), cfo=ks.reduce((a,k)=>a+az[k].cfo,0);
  if(sfo+cfo>0){ console.log('Назначено на Ozon (виртуальные склады): '+F(sfo+cfo)+' шт по '+ks.length
    +' кодам — СФО '+F(sfo)+' / ЦФО '+F(cfo)+': в отгрузку не идёт, засчитано в покрытие Ozon');
    const oc=(RD.ozon&&RD.ozon.catalog)||[]; let dup=0, dupK=0;
    ks.forEach(k=>{ const c=oc.find(x=>(''+x.sku).trim()===k); if(!c) return;
      const req=c.ozReq!=null? (c.ozReq||0) : (c.ozTransit||0);
      const d=Math.min(req, az[k].all); if(d>0){ dup+=d; dupK++; } });
    if(dup>0) console.log('  из них '+F(dup)+' шт по '+dupK+' кодам Ozon УЖЕ показывает как заявку на поставку'
      +' — это та же партия, в покрытии она считается один раз (иначе покрытие завышено)'); } }
{ const rh=rows.filter(r=>r.retailHold>0);
  if(rh.length) console.log('Резерв рознице ('+RETAIL_RESERVE+' шт на код, Евросиб + Нск-1 вместе): '
    +F(rh.reduce((a,r)=>a+r.retailHold,0))+' шт по '+rh.length+' кодам — в отгрузку не идёт'); }
console.log('Нечем закрыть (на складе пусто): '+noStock.length+' позиций, не хватает '
  +F(noStock.reduce((a,r)=>a+r.needO+r.needW,0))+' шт');
const launches=needAny.filter(r=>r.launch);
if(launches.length) console.log('Стартовые партии (товара нет на площадке): '+launches.length+' позиций · '
  +F(launches.reduce((a,r)=>a+r.shipO,0))+' шт');
console.log('ПЕРЕМЕСТИТЬ Евросиб → Нск-1 (FBS на ВБ): '+F(rows.reduce((a,r)=>a+r.move,0))+' шт по '
  +movers.filter(r=>r.move>0).length+' кодам'+(moveGap.length? '  ·  нечем закрыть '+moveGap.length+' кодов':''));
console.log('Покрытие ВБ: на складах ВБ и в пути '+F(rows.reduce((a,r)=>a+(r.wCov||0),0))+' шт (включая Клин) + FBS со своих складов '
  +F(rows.reduce((a,r)=>a+r.wbFbsFree,0))+' шт (Москва и Нск-1 за вычетом того, что уже расписано под отгрузку)');
{ const klTot=Object.values(klinBySup()).reduce((a,b)=>a+b,0);
  const azTot=Object.values(ozAssignedBySup()).reduce((a,v)=>a+v.all,0);
  console.log('Останется на складе: '+F(rows.reduce((a,r)=>a+r.rest,0))+' шт из '
    +F(Object.values(wh).reduce((a,v)=>a+v.qty,0)-klTot-azTot)
    +' (склад без Клина и без назначенного на Ozon)'); }

// ---- план машин собран выше вместе с добором (topUp): ≤ MAX_CODES_PER_TRUCK кодов в машине ----
if(plan.length){
  console.log('\nПЛАН МАШИН ('+PALLETS_PER_TRUCK+' паллет, не больше '+MAX_CODES_PER_TRUCK+' кодов, сборка с одного склада на одну площадку):');
  plan.forEach(p=>{ console.log('  '+(p.whn+' → '+p.mp).padEnd(14)+String(p.total).padStart(4)+' палл · '
    +p.full+' маш'+(p.tail? ' + остаток '+p.tail+' палл':'')+' · '+p.codes+' кодов'
    +(p.droppedPal? ' · НЕ ЕДЕТ '+p.droppedPal+' палл (до '+PALLETS_PER_TRUCK+' добить нечем)':''));
    p.trucks.forEach((t,i)=>console.log('      '+(t.pallets>=PALLETS_PER_TRUCK? 'Машина '+(i+1):'Остаток').padEnd(11)
      +t.pallets+' палл · '+t.items.length+' кодов: '+t.items.slice(0,10).map(x=>x.sup+'×'+x.pal).join(', ')
      +(t.items.length>10?' …':'')));
    p.dropped.forEach(t=>console.log('      '+'Не едет'.padEnd(11)+t.pallets+' палл · '+t.items.length+' кодов: '
      +t.items.slice(0,10).map(x=>x.sup+'×'+x.pal).join(', ')+(t.items.length>10?' …':''))); });
  { const tu=rows.reduce((a,r)=>a+r.topUpO+r.topUpW,0), rl=rows.filter(r=>r.rollO+r.rollW>0);
    console.log('  добор до полных машин: '+F(tu)+' шт · не едет (машину не собрать): '
      +F(rl.reduce((a,r)=>a+r.rollO+r.rollW,0))+' шт по '+rl.length+' кодам'); }
}
const noPalCnt=needAny.filter(r=>r.noPal).length;
if(noPalCnt) console.log('\nБез вместимости паллеты (везём штуками): '+noPalCnt+' позиций');
if(toShip.length){
  console.log('\nЧТО ОТГРУЗИТЬ (топ-'+TOP+' по количеству):');
  console.log('  код 1С    склад   →Озон   →ВБ  Евросиб  Нск-1    Мск   ост.  дн Оз  дн ВБ  товар');
  toShip.sort((a,b)=>(b.shipO+b.shipW)-(a.shipO+a.shipW)).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+String(r.have).padStart(6)+String(r.shipO||'-').padStart(7)
      +String(r.shipW||'-').padStart(6)+String(r.whNsk2).padStart(8)+String(r.whNsk1).padStart(7)
      +String(r.whMsk).padStart(7)+String(r.rest).padStart(7)
      +String(D(r.oDays)).padStart(7)+String(D(r.wDays)).padStart(7)+'  '+(r.name||'').slice(0,30)));
}
if(urgent.length){
  console.log('\nСРОЧНО (покрытие меньше '+Math.round(DAYS/3)+' дней):');
  urgent.sort((a,b)=>a.minDays-b.minDays).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+'Оз '+String(D(r.oDays)).padStart(4)+' дн · ВБ '+String(D(r.wDays)).padStart(4)+' дн'
      +' · нужно '+String(r.needO).padStart(6)+' · на складе '+String(r.have).padStart(6)
      +(r.have<=0? (r.china||r.order? '  (едет: '+(r.china?'Китай '+r.china:'')+(r.china&&r.order?' + ':'')+(r.order?'произв. '+r.order:'')+')' : '  (взять негде)') : '')
      +'  '+(r.name||'').slice(0,34)));
}
if(movers.length){
  console.log('\nПЕРЕМЕЩЕНИЕ ЕВРОСИБ → НСК-1 (везём, когда на Нск-1 меньше '+NSK1_MIN_DAYS+' дней продаж ВБ по FBS):');
  console.log('  код 1С   на Нск-1  дней  переместить  на Евросибе   товар');
  movers.slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+String(r.nsk1Free).padStart(8)+String(D(r.nsk1Days)).padStart(6)
      +String(r.move).padStart(13)+String(r.whNsk2).padStart(13)+'   '+(r.name||'').slice(0,34)));
  if(moveGap.length) console.log('  ещё '+moveGap.length+' кодов кончаются на Нск-1, но и на Евросибе их нет — перемещением не закрыть');
}
console.log('\nПодробности и выгрузка — вкладка «Оборачиваемость» → «Подсорт со склада».');
