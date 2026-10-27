// Отчёт «нужен ли подсорт» — считает то же, что вид «Подсорт со склада» в дашборде,
// но в консоли. ЗАПУСКАТЬ ПОСЛЕ ЛЮБОГО ОБНОВЛЕНИЯ ОСТАТКОВ (ВБ, Озон, свой склад) —
// это правило продавца: после каждой заливки он хочет видеть, что и куда отгружать.
//
// Правила с 27.10.2026 (ПРАВИЛА.md: ЗАП-08, ЗАП-11, ЗАП-13; совпадают с index.html):
//   НАПРАВЛЕНИЯ: ВБ FBO; Ozon «Москва и МО» (ЦФО + Питер + Юг) и «Казань / Нижний Новгород»
//     (Приволжье; склады НН Ozon числит в кластере «Казань»). Кластеры вне округов — не считаем.
//   СКЛАДЫ-ИСТОЧНИКИ: Клин, Евросиб, Нск-1, Москва — в этом порядке (сначала склады без FBS).
//   продаж/дн     = заказы за 7 дней ÷ 7 × % выкупа; у Ozon делится на направления по доле спроса
//                   кластеров (лист «Товар-кластер», `ozon.clusters`);
//   покрытие      = ВБ: остаток на складах WB + журнал отгрузок; Ozon: остаток + в пути кластеров
//                   направления (+ виртуальные «Ozon ЦФО» → Москва, «Ozon СФО» → Казань, без задвоения с заявками);
//   БАЗА          = до 6 месяцев (180 дн) запаса на направлении; Ozon первым, между его
//                   направлениями — по уровню воды; ВБ — из того, что осталось после машин Ozon;
//   МАШИНА        = один склад → одно направление, ровно 33 паллеты и ≤ 6 кодов; последнюю неполную
//                   добиваем, только если базы в ней ≥ 20 паллет, товаром с запасом ≤ 8 месяцев (240 дн);
//                   иначе машина не едет, паллеты остаются на складе.
//
// Использование: node scripts/resupply-report.cjs [-] [сколько строк показать=15]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DAYS=180;   // база ЗАП-13; аргумент «дней» больше не действует
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
  /* Клин с 27.10.2026 — склад-источник на обе площадки (ЗАП-08), а не «в пути на ВБ»: его остаток
     больше НЕ идёт в `transit` у ВБ. В пути на ВБ — только журнал отгрузок `shipments` (в т.ч. то,
     что уже уехало с Клина). Синхронно с index.html. */
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
/* ПРАВИЛА ПОДСОРТА С 27.10.2026 — ПРАВИЛА.md ЗАП-08 (Клин — склад-источник), ЗАП-11 (направления),
   ЗАП-13 (база 6 месяцев, машина 33 паллеты / ≤ 6 кодов, добор от 20 паллет товаром на 8 месяцев).
   Держи синхронно с index.html (resupplyRows / topUpTrucks / truckFill / packTrucks).
   · Склады-источники: Клин, Евросиб, Нск-1 «Склад FBS», Москва «СХ/РЦ Солнечногорск». На Евросибе
     позиции меньше NSK2_MIN_TAKE шт не берём. Виртуальные «Ozon СФО/ЦФО» уже назначены на Ozon —
     в отгрузку не идут, считаются покрытием Ozon.
   · Порядок разбора складов — сначала те, с которых не продаём по FBS (Клин, Евросиб), потом Нск-1
     и Москва: что осталось на Нск-1 и в Москве, продаётся по FBS на ВБ (FBS продолжается, ЗАП-13).
   · Резерв рознице отменён 18.10.2026 — выгрузка 1С уже свободный остаток (ЗАП-08). */
const NSK2_MIN_TAKE=100, MAX_CODES_PER_TRUCK=6;
const BASE_DAYS=180, TOPUP_MAX_DAYS=240, TOPUP_MIN_BASE=20;
const WH_ORDER=['klin','nsk2','nsk1','msk'];
const WH_NAME={klin:'Клин',nsk2:'Евросиб',nsk1:'Нск-FBS',msk:'Мск'};
/* Направления. У Ozon спрос есть только по КЛАСТЕРУ, а оба склада Нижнего Новгорода Ozon числит в
   кластере «Казань» (stocks_report 26.10, лист «Товар-склад») — поэтому направлений по спросу два.
   Появится отдельный кластер «Нижний Новгород» — он уже попадает в группу «Казань» по регэкспу. */
const DIRS=[
  {key:'oMsk',mp:'ozon',name:'Ozon · Москва и МО',asg:'cfo',
   re:/москв|воронеж|ярослав|твер|петербург|ростов|краснодар/i},
  {key:'oKzn',mp:'ozon',name:'Ozon · Казань / Нижний Новгород',asg:'sfo',
   re:/казан|нижн|самар|уфа|оренбург|пермь|саратов/i},
  {key:'wFbo',mp:'wb',name:'ВБ FBO'}];
const OZ_KEYS=['oMsk','oKzn'];
const dirByKey=Object.fromEntries(DIRS.map(d=>[d.key,d]));
function klinBySup(){ const wh=(RD.warehouse&&RD.warehouse.bySup)||{}, out={};
  Object.keys(wh).forEach(s=>{ let q=0;
    Object.entries(wh[s].wh||{}).forEach(([n,v])=>{ if(whKey(n)==='klin') q+=v; });
    if(q>0) out[s]=q; });
  return out; }
/* Назначено на Ozon (виртуальные склады СФО/ЦФО). */
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
/* Спрос и покрытие Ozon по направлениям — из разреза по кластерам (`ozon.clusters.bySup`):
   доля направления = продажи его кластеров ÷ продажи всех кластеров кода (лист «Товар-кластер»:
   заказы FBO со складов кластера ÷ дни в наличии); у кода без разреза — доля по кабинету.
   Покрытие = доступно + в поставках в пути + max(в заявках, виртуальный склад направления). */
const CL=(RD.ozon&&RD.ozon.clusters)||{}, clBy=CL.bySup||{};
const dirOf=cl=>{ for(const d of DIRS) if(d.re && d.re.test(cl)) return d.key; return null; };
const accSpd={oMsk:0,oKzn:0}; let accAll=0;
Object.entries(CL.byCluster||{}).forEach(([cl,e])=>{ const v=e.spd||0; accAll+=v; const k=dirOf(cl); if(k) accSpd[k]+=v; });
const ASG=ozAssignedBySup();
function ozSplit(sup){
  const m=clBy[sup]||{}, a=ASG[sup]||{sfo:0,cfo:0};
  const s={oMsk:0,oKzn:0}, av={oMsk:0,oKzn:0}, rd={oMsk:0,oKzn:0}, rq={oMsk:0,oKzn:0}; let all=0;
  Object.entries(m).forEach(([cl,v])=>{ all+=v.spd||0; const k=dirOf(cl); if(!k) return;
    s[k]+=v.spd||0; av[k]+=v.avail||0; rd[k]+=v.road||0; rq[k]+=v.req||0; });
  const share = all>0? {oMsk:s.oMsk/all, oKzn:s.oKzn/all}
    : (accAll>0? {oMsk:accSpd.oMsk/accAll, oKzn:accSpd.oKzn/accAll} : {oMsk:1, oKzn:0});
  return { share, outShare:Math.max(0,1-share.oMsk-share.oKzn),
    cov:{ oMsk:av.oMsk+rd.oMsk+Math.max(rq.oMsk, a.cfo||0), oKzn:av.oKzn+rd.oKzn+Math.max(rq.oKzn, a.sfo||0) } };
}
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
const daysOf=(cov,spd)=> spd>0? cov/spd : (cov>0? Infinity : 0);
let rows=sups.map(sup=>{
  const w=W[sup]||zero, o=O[sup]||zero;
  const whB=(wh[sup]&&wh[sup].wh)||{}; const q={msk:0,nsk1:0,nsk2:0,klin:0,ozsfo:0,ozcfo:0,other:0};
  Object.entries(whB).forEach(([n,v])=>{ q[whKey(n)]+=v; });
  const mOzAsg=q.ozsfo+q.ozcfo;
  // `have` — то, что можно отгрузить: склад МИНУС назначенное на Ozon (Клин с 27.10 — в отгрузке)
  const have=Math.max(0, ((wh[sup]&&wh[sup].qty)||0) - mOzAsg);
  const pool={klin:q.klin, nsk2:(q.nsk2>=NSK2_MIN_TAKE? q.nsk2 : 0), nsk1:q.nsk1, msk:q.msk};
  const P=PAL[sup]||null, palOz=P?(P.oz||0):0, palWb=P?(P.wb||0):0;
  const sp=ozSplit(sup);
  const mk=(spd,cov)=>({spd,cov,need:0,ship:0,pal:{klin:0,nsk2:0,nsk1:0,msk:0},pcs:{klin:0,nsk2:0,nsk1:0,msk:0},
    topUp:0,roll:0,days:daysOf(cov,spd)});
  const D={ oMsk:mk(o.spd*sp.share.oMsk, sp.cov.oMsk), oKzn:mk(o.spd*sp.share.oKzn, sp.cov.oKzn),
            wFbo:mk(w.spd, w.covered) };
  const launchO = o.spd<=0 && o.covered<=0 && have>0;
  const launchW = w.spd<=0 && w.covered<=0 && have>0;
  return {sup,name:(w.name||o.name||sup),have,pool,hold:{klin:0,nsk2:0,nsk1:0,msk:0},palOz,palWb,D,launchO,launchW,outShare:sp.outShare,
    whKlin:q.klin,whNsk2:q.nsk2,whNsk1:q.nsk1,whMsk:q.msk,whOzAsg:mOzAsg,
    oSpd:o.spd,wSpd:w.spd,oCov:o.covered,wCov:w.covered,oDays:o.days,wDays:w.days,
    noPal:false, china:chinaBy[sup]||0, order:orderBy[sup]||0,
    minDays:Math.min(w.spd>0?w.days:Infinity,o.spd>0?o.days:Infinity)};
});
const capOf=(r,k)=> k==='wFbo'? r.palWb : r.palOz;
/* Забор паллет из складов в порядке WH_ORDER. Округляем ВВЕРХ до паллеты (решение продавца 24.08),
   но не больше, чем есть целыми паллетами. Без вместимости — штуками (в машины не входит). */
function take(r,k,qty){
  const d=r.D[k], cap=capOf(r,k); if(qty<=0) return 0;
  let got=0;
  if(cap>0){ let left=Math.ceil(qty/cap);
    for(const w of WH_ORDER){ const p=Math.min(left,Math.floor(r.pool[w]/cap)); if(p<=0) continue;
      d.pal[w]+=p; r.pool[w]-=p*cap; d.ship+=p*cap; got+=p*cap; left-=p; if(left<=0) break; } }
  else { r.noPal=true; let left=qty;
    for(const w of WH_ORDER){ const x=Math.min(left,r.pool[w]); if(x<=0) continue;
      d.pcs[w]+=x; r.pool[w]-=x; d.ship+=x; got+=x; left-=x; if(left<=0) break; } }
  return got; }
const shippable=(r,cap)=> cap>0? WH_ORDER.reduce((a,w)=>a+Math.floor(r.pool[w]/cap)*cap,0)
                               : WH_ORDER.reduce((a,w)=>a+r.pool[w],0);
/* Уровень воды между направлениями одной площадки: поднимаем покрытие в днях с самого низкого,
   потолок — BASE_DAYS. Направление с меньшим спросом не получает больше дней, чем с бОльшим. */
function waterFill(ds, avail, cap){
  const need=ds.map(d=>Math.max(0, d.spd*cap - d.cov)), tot=need.reduce((a,b)=>a+b,0);
  if(tot<=avail) return need;
  let lo=0, hi=cap;
  for(let it=0; it<60; it++){ const L=(lo+hi)/2;
    const s=ds.reduce((a,d)=>a+Math.max(0,d.spd*L-d.cov),0); if(s>avail) hi=L; else lo=L; }
  return ds.map(d=>Math.max(0, d.spd*lo-d.cov)); }
// ---- база Ozon (сначала Ozon — приоритет продавца) ----
rows.forEach(r=>{
  OZ_KEYS.forEach(k=>{ const d=r.D[k]; d.need=Math.max(0, Math.ceil(d.spd*BASE_DAYS - d.cov)); });
  if(r.launchO){ r.D.oMsk.need=Math.min(LAUNCH_QTY, r.have); take(r,'oMsk',r.D.oMsk.need); return; }
  const want=waterFill(OZ_KEYS.map(k=>r.D[k]), shippable(r,r.palOz), BASE_DAYS);
  OZ_KEYS.map((k,i)=>({k,q:want[i]})).sort((a,b)=>b.q-a.q).forEach(x=>take(r,x.k,x.q));
});

// ---- МАШИНЫ: упаковка, консолидация, добор (та же логика, что в index.html — держи синхронно) ----
const truckItems=(wh,k)=>rows.map(r=>({sup:r.sup,pal:r.D[k].pal[wh],days:r.D[k].days})).filter(x=>x.pal>0);
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
   направления не меняются, у неполной освобождается слот под добор. Держи синхронно с index.html. */
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
/* Добор одной неполной машины (ЗАП-13): только тем, что продастся на этом направлении за
   TOPUP_MAX_DAYS (запас после отгрузки ≤ 240 дн), по паллете коду с наименьшим запасом в днях;
   новый код — только если с ним машину ещё можно добить и кодов ≤ 6. Map(строка → паллет) или null. */
function truckFill(p,t){
  const k=p.k, pal=r=>capOf(r,k), spd=r=>r.D[k].spd, base=r=>r.D[k].cov+r.D[k].ship;
  const maxP=r=>Math.floor((TOPUP_MAX_DAYS*spd(r)-base(r))/pal(r));
  const cand=rows.filter(r=>pal(r)>0 && spd(r)>0 && r.pool[p.wh]>=pal(r) && maxP(r)>0);
  const fr=new Map(cand.map(r=>[r,r.pool[p.wh]])), add=new Map();
  const inT=new Set(t.items.map(x=>x.sup));
  let left=PALLETS_PER_TRUCK-t.pallets, slots=MAX_CODES_PER_TRUCK-t.items.length;
  const capP=r=>Math.min(Math.floor(fr.get(r)/pal(r)), maxP(r)-(add.get(r)||0));
  const days=r=>(base(r)+(add.get(r)||0)*pal(r))/spd(r);
  while(left>0){
    let inCap=0; const outs=[];
    cand.forEach(r=>{ const c=capP(r); if(c<=0) return; if(inT.has(r.sup)) inCap+=c; else outs.push(c); });
    outs.sort((a,b)=>b-a);
    const topSum=n=>{ let s=0; for(let i=0;i<n&&i<outs.length;i++) s+=outs[i]; return s; };
    let best=null, bestD=Infinity;
    for(const r of cand){
      const c=capP(r); if(c<=0) continue;
      if(!inT.has(r.sup)){
        if(slots<=0) continue;
        const n=slots-1, rest=(n>0 && c>=outs[Math.min(n,outs.length)-1])? topSum(n+1)-c : topSum(n);
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
const plan=[];
const bySup={}; rows.forEach(r=>{ bySup[r.sup]=r; });
/* Машина Ozon не собралась — её товар остаётся на складе ЗА OZON (`hold`): приоритет продавца,
   нужное Ozon не отдаём на ВБ ни базой, ни добором (иначе 487195 с нулём дней на Ozon «Казань»
   уезжал на ВБ при 37 днях там). Добор следующих машин Ozon этим товаром пользоваться может. */
const shift=(r,p,pals,isTop,quiet)=>{ const d=r.D[p.k], qty=pals*capOf(r,p.k);
  r.pool[p.wh]-=qty; d.pal[p.wh]+=pals; d.ship+=qty;
  if(isTop) d.topUp+=qty; else if(pals<0 && !quiet){ d.roll-=qty; if(p.k!=='wFbo') r.hold[p.wh]+=-qty; } };
function runTrucks(keys){
  const pairs=[]; WH_ORDER.forEach((wh,i)=>keys.forEach(k=>
    pairs.push({wh,k,i,total:rows.reduce((a,r)=>a+r.D[k].pal[wh],0)})));
  pairs.sort((a,b)=>(b.total-a.total) || (a.i-b.i));
  /* Пара, где базы меньше TOPUP_MIN_BASE на весь склад, не поедет при любом раскладе — снимаем её
     ДО разбора остальных: её товар сразу свободен для добора других машин этого склада. */
  pairs.forEach(p=>{ p.pre=[]; if(p.total<=0 || p.total>=TOPUP_MIN_BASE) return;
    const items=truckItems(p.wh,p.k);
    items.forEach(x=>shift(bySup[x.sup],p,-x.pal,false));
    p.pre.push({pallets:p.total,free:0,items:items.map(x=>({sup:x.sup,pal:x.pal})),
      why:'база '+p.total+' палл < '+TOPUP_MIN_BASE}); });
  const retry=[];
  pairs.forEach(p=>{ if(p.total<=0) return;
    if(p.total<TOPUP_MIN_BASE){ plan.push({wh:p.wh,k:p.k,total:0,trucks:[],codes:0,dropped:p.pre,
      droppedPal:p.total}); return; }
    const trucks=packTrucks(truckItems(p.wh,p.k)), kept=[], dropped=[];
    trucks.forEach((t,ti)=>{
      if(t.pallets>=PALLETS_PER_TRUCK){ kept.push(t); return; }
      truckConsolidate(t,kept);
      t.base=t.pallets;
      // добиваем, только если базы в машине ≥ TOPUP_MIN_BASE паллет (ЗАП-13)
      let add = t.pallets>=TOPUP_MIN_BASE? truckFill(p,t) : null, cut=[];
      if(!add && t.pallets>=TOPUP_MIN_BASE){
        const small=t.items.slice().sort((a,b)=>a.pal-b.pal || (a.sup<b.sup?-1:(a.sup>b.sup?1:0)));
        for(let n=1; n<small.length && !add; n++){
          const off=new Set(small.slice(0,n).map(x=>x.sup));
          const items=t.items.filter(x=>!off.has(x.sup)), pals=items.reduce((s,x)=>s+x.pal,0);
          if(pals<TOPUP_MIN_BASE) break;
          const a2=truckFill(p,{items,pallets:pals});
          if(a2){ add=a2; cut=small.slice(0,n); }
        }
        if(add){ const off=new Set(cut.map(x=>x.sup));
          t.items=t.items.filter(x=>!off.has(x.sup));
          t.pallets=t.items.reduce((s,x)=>s+x.pal,0); t.free=PALLETS_PER_TRUCK-t.pallets; t.base=t.pallets;
          // снятые коды — в следующую неполную машину направления, если там есть слоты и место
          const u=trucks.slice(ti+1).find(u=>u.pallets<PALLETS_PER_TRUCK
            && new Set(u.items.map(x=>x.sup).concat(cut.map(x=>x.sup))).size<=MAX_CODES_PER_TRUCK
            && u.pallets+cut.reduce((s,x)=>s+x.pal,0)<=PALLETS_PER_TRUCK);
          if(u){ cut.forEach(x=>{ const ex=u.items.find(y=>y.sup===x.sup); if(ex) ex.pal+=x.pal; else u.items.push(x);
              u.pallets+=x.pal; u.free-=x.pal; }); }
          else { cut.forEach(x=>shift(bySup[x.sup],p,-x.pal,false));
            dropped.push({pallets:cut.reduce((s,x)=>s+x.pal,0),free:0,items:cut,why:'снят мелкий код'}); } }
      }
      if(add){ add.forEach((pals,r)=>{ shift(r,p,pals,true);
          const ex=t.items.find(x=>x.sup===r.sup); if(ex) ex.pal+=pals; else t.items.push({sup:r.sup,pal:pals});
          t.pallets+=pals; t.free-=pals; });
        kept.push(t); }
      else { t.items.forEach(x=>shift(bySup[x.sup],p,-x.pal,false));
        const dt={...t, why: t.pallets<TOPUP_MIN_BASE? 'база '+t.pallets+' палл < '+TOPUP_MIN_BASE
          : 'нечем добить товаром до '+Math.round(TOPUP_MAX_DAYS/30)+' мес'};
        dropped.push(dt); if(t.pallets>=TOPUP_MIN_BASE) retry.push({p,t:dt}); }
    });
    const pe={wh:p.wh,k:p.k,trucks:kept,dropped}; plan.push(pe); p.pe=pe;
  });
  /* Второй заход: машина с базой ≥ 20, которой не хватило товара на добор, пробует ещё раз —
     после снятия несобравшихся машин на складе мог освободиться подходящий товар. */
  retry.forEach(({p,t})=>{
    const ok=t.items.every(x=>{ const r=bySup[x.sup]; return r.pool[p.wh]>=x.pal*capOf(r,p.k); });
    if(!ok) return;
    t.items.forEach(x=>shift(bySup[x.sup],p,x.pal,false));
    const add=truckFill(p,{items:t.items,pallets:t.pallets});
    // не добить и во второй раз — тихий откат: «не едет» и «держим за Ozon» записаны первым заходом
    if(!add){ t.items.forEach(x=>shift(bySup[x.sup],p,-x.pal,false,true)); return; }
    const nt={pallets:t.pallets,free:PALLETS_PER_TRUCK-t.pallets,items:t.items.map(x=>({...x})),base:t.pallets};
    add.forEach((pals,r)=>{ shift(r,p,pals,true); const ex=nt.items.find(x=>x.sup===r.sup);
      if(ex) ex.pal+=pals; else nt.items.push({sup:r.sup,pal:pals}); nt.pallets+=pals; });
    p.pe.trucks.push(nt); p.pe.dropped=p.pe.dropped.filter(x=>x!==t);
    // откат при первом заходе записал «не едет» — снимаем отметку (товар поехал)
    t.items.forEach(x=>{ const r=bySup[x.sup], q=x.pal*capOf(r,p.k); r.D[p.k].roll-=q;
      if(p.k!=='wFbo') r.hold[p.wh]=Math.max(0,r.hold[p.wh]-q); });
  });
  plan.forEach(pe=>{ if(pe.total!=null && !pe.trucks.length && pe.droppedPal!=null && !pe.pe) {}
    pe.trucks.sort((a,b)=>b.pallets-a.pallets);
    pe.total=pe.trucks.reduce((a,t)=>a+t.pallets,0);
    pe.codes=new Set(pe.trucks.flatMap(t=>t.items.map(x=>x.sup))).size;
    pe.droppedPal=pe.dropped.reduce((a,t)=>a+t.pallets,0); });
}
runTrucks(OZ_KEYS);
// ---- ВБ FBO — из того, что осталось после Ozon; товар несобравшихся машин Ozon держим за Ozon ----
rows.forEach(r=>WH_ORDER.forEach(w=>{ r.hold[w]=Math.min(r.hold[w], r.pool[w]); r.pool[w]-=r.hold[w]; }));
rows.forEach(r=>{ const d=r.D.wFbo;
  d.need = r.launchW? Math.min(LAUNCH_QTY, r.have) : Math.max(0, Math.ceil(d.spd*BASE_DAYS - d.cov));
  take(r,'wFbo',d.need); });
runTrucks(['wFbo']);
rows.forEach(r=>WH_ORDER.forEach(w=>{ r.pool[w]+=r.hold[w]; }));
plan.sort((a,b)=>(a.k==='wFbo')-(b.k==='wFbo') || b.total-a.total);
rows.forEach(r=>{ r.shipO=r.D.oMsk.ship+r.D.oKzn.ship; r.shipW=r.D.wFbo.ship; r.rest=r.have-r.shipO-r.shipW; });

// ---- вывод ----
const sum=(f)=>rows.reduce((a,r)=>a+f(r),0);
const needAny=rows.filter(r=>DIRS.some(d=>r.D[d.key].need>0));
const noStock=needAny.filter(r=>r.have<=0);
const urgent=needAny.filter(r=>r.minDays<10);
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
console.log('ПОДСОРТ ПО ПРАВИЛАМ С 27.10 (база '+BASE_DAYS+' дн, добор от '+TOPUP_MIN_BASE+' палл товаром до '
  +TOPUP_MAX_DAYS+' дн) · остатки ВБ на '+((RD.meta&&RD.meta.stockSnapshotDate)||'—')
  +' · Озон на '+((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.stockDate)||'—')
  +' (кластеры на '+(CL.date||'—')+') · склад на '+((RD.warehouse&&RD.warehouse.date)||'не загружен'));
console.log('─'.repeat(100));
DIRS.forEach(d=>{ const k=d.key;
  const ship=sum(r=>r.D[k].ship), pcs=sum(r=>WH_ORDER.reduce((a,w)=>a+r.D[k].pcs[w],0));
  const need=sum(r=>r.D[k].need), top=sum(r=>r.D[k].topUp), roll=sum(r=>r.D[k].roll);
  const spd=sum(r=>r.D[k].spd), cov=sum(r=>r.D[k].cov);
  console.log((d.name+':').padEnd(34)+' к отгрузке '+F(ship).padStart(7)+' шт'
    +(pcs? ' (из них штучно '+F(pcs)+')':'')
    +' · до 6 мес не хватает '+F(need)+' · добор '+F(top)+' · не едет '+F(roll)
    +' · спрос '+spd.toFixed(1)+'/дн · запас был '+D(daysOf(cov,spd))+' дн → стал '+D(daysOf(cov+ship,spd))+' дн'); });
{ const out=sum(r=>r.oSpd*r.outShare), all=sum(r=>r.oSpd);
  console.log('Спрос Ozon вне двух направлений (Урал, Сибирь, ДВ и др.) — не считаем: '+out.toFixed(1)+'/дн из '
    +all.toFixed(1)+' ('+(all? Math.round(out/all*100):0)+'%)'); }
{ const sfo=Object.values(ASG).reduce((a,v)=>a+v.sfo,0), cfo=Object.values(ASG).reduce((a,v)=>a+v.cfo,0);
  if(sfo+cfo>0) console.log('Назначено на Ozon (виртуальные склады): ЦФО '+F(cfo)+' шт → покрытие «Москва и МО»; СФО '
    +F(sfo)+' шт → покрытие «Казань / НН» (в Сибирь не везём, ЗАП-11)'); }
console.log('Требуют отгрузки: '+needAny.length+' позиций · нечем закрыть (на своих складах пусто): '+noStock.length
  +' · срочно (запас < 10 дн): '+urgent.length);
{ const byW={}; WH_ORDER.forEach(w=>{ byW[w]=sum(r=>r.pool[w]); });
  const tot=sum(r=>r.have);
  console.log('Останется на своих складах: '+F(sum(r=>r.rest))+' шт из '+F(tot)+' (без назначенного на Ozon): '
    +WH_ORDER.map(w=>WH_NAME[w]+' '+F(byW[w])).join(' · ')
    +(sum(r=>r.whNsk2>0&&r.whNsk2<NSK2_MIN_TAKE? r.whNsk2:0)? ' + мелочь Евросиба <'+NSK2_MIN_TAKE+' шт не берём' : '')); }
{ const h=sum(r=>WH_ORDER.reduce((a,w)=>a+r.hold[w],0));
  if(h) console.log('Из них держим за Ozon (машина Ozon не собралась, на ВБ не отдаём): '+F(h)+' шт'); }
const fbsLeft=sum(r=>r.pool.nsk1+r.pool.msk);
console.log('Под FBS ВБ остаётся (Нск-1 + Москва): '+F(fbsLeft)+' шт');

if(plan.length){
  console.log('\nПЛАН МАШИН ('+PALLETS_PER_TRUCK+' паллет, ≤ '+MAX_CODES_PER_TRUCK+' кодов, один склад → одно направление):');
  plan.forEach(p=>{ const nm=WH_NAME[p.wh]+' → '+dirByKey[p.k].name;
    console.log('  '+nm.padEnd(46)+String(p.total).padStart(4)+' палл · '+p.trucks.length+' маш · '+p.codes+' кодов'
      +(p.droppedPal? ' · НЕ ЕДЕТ '+p.droppedPal+' палл':''));
    p.trucks.forEach((t,i)=>console.log('      Машина '+String(i+1).padEnd(4)+t.pallets+' палл'
      +(t.base!=null && t.base<t.pallets? ' (база '+t.base+' + добор '+(t.pallets-t.base)+')':'')
      +' · '+t.items.length+' кодов: '+t.items.map(x=>x.sup+'×'+x.pal).join(', ')));
    p.dropped.forEach(t=>console.log('      Не едет    '+t.pallets+' палл · '+t.why+': '
      +t.items.map(x=>x.sup+'×'+x.pal).join(', '))); });
  console.log('  ИТОГО: '+plan.reduce((a,p)=>a+p.trucks.length,0)+' машин · '+F(plan.reduce((a,p)=>a+p.total,0))+' палл');
}
const noPal=rows.filter(r=>r.noPal);
if(noPal.length) console.log('\nБез вместимости паллеты (везём штуками, вне машин): '+noPal.length+' позиций: '
  +noPal.map(r=>r.sup+' '+F(r.shipO+r.shipW)).join(', '));
const toShip=rows.filter(r=>r.shipO>0||r.shipW>0);
if(toShip.length){
  console.log('\nЧТО ОТГРУЗИТЬ (топ-'+TOP+' по количеству):');
  console.log('  код 1С    склад  →Оз.Мск →Оз.Каз   →ВБ    Клин Евросиб  Нск-1    Мск   ост.  дн Мск  дн Каз  дн ВБ  товар');
  toShip.sort((a,b)=>(b.shipO+b.shipW)-(a.shipO+a.shipW)).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+String(r.have).padStart(6)+String(r.D.oMsk.ship||'-').padStart(8)
      +String(r.D.oKzn.ship||'-').padStart(8)+String(r.D.wFbo.ship||'-').padStart(6)
      +String(r.whKlin).padStart(8)+String(r.whNsk2).padStart(8)+String(r.whNsk1).padStart(7)
      +String(r.whMsk).padStart(7)+String(r.rest).padStart(7)
      +String(D(r.D.oMsk.days)).padStart(8)+String(D(r.D.oKzn.days)).padStart(8)+String(D(r.D.wFbo.days)).padStart(7)
      +'  '+(r.name||'').slice(0,28)));
}
if(urgent.length){
  console.log('\nСРОЧНО (запас на площадке меньше 10 дней):');
  urgent.sort((a,b)=>a.minDays-b.minDays).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+'Оз '+String(D(r.oDays)).padStart(4)+' дн · ВБ '+String(D(r.wDays)).padStart(4)+' дн'
      +' · везём Оз '+String(r.shipO).padStart(5)+' ВБ '+String(r.shipW).padStart(5)+' · на складе '+String(r.have).padStart(6)
      +(r.have<=0? (r.china||r.order? '  (едет: '+(r.china?'Китай '+r.china:'')+(r.china&&r.order?' + ':'')+(r.order?'произв. '+r.order:'')+')' : '  (взять негде)') : '')
      +'  '+(r.name||'').slice(0,34)));
}
// ---- самопроверка правил ЗАП-13 (печатает только нарушения) ----
{ const bad=[];
  rows.forEach(r=>WH_ORDER.forEach(w=>{ if(r.pool[w]<0) bad.push(r.sup+': склад '+WH_NAME[w]+' ушёл в минус '+r.pool[w]);
    if(r.hold[w]<0) bad.push(r.sup+': отрицательное «держим за Ozon»'); }));
  rows.forEach(r=>{ if(r.shipO+r.shipW>r.have) bad.push(r.sup+': отгрузка '+(r.shipO+r.shipW)+' больше склада '+r.have); });
  plan.forEach(pe=>{
    pe.trucks.forEach((t,i)=>{ const pl=t.items.reduce((a,x)=>a+x.pal,0);
      if(pl!==PALLETS_PER_TRUCK||t.items.length>MAX_CODES_PER_TRUCK) bad.push(WH_NAME[pe.wh]+'→'+pe.k+' машина '+(i+1)+': '+pl+' палл / '+t.items.length+' кодов');
      if(t.base!=null && t.base<t.pallets && t.base<TOPUP_MIN_BASE) bad.push(WH_NAME[pe.wh]+'→'+pe.k+' машина '+(i+1)+': добита при базе '+t.base); });
    const inPlan={}; pe.trucks.forEach(t=>t.items.forEach(x=>{ inPlan[x.sup]=(inPlan[x.sup]||0)+x.pal; }));
    rows.forEach(r=>{ const a=r.D[pe.k].pal[pe.wh]||0, b=inPlan[r.sup]||0;
      if(a!==b) bad.push(r.sup+' '+WH_NAME[pe.wh]+'→'+pe.k+': в строке '+a+' палл, в машинах '+b); }); });
  rows.forEach(r=>DIRS.forEach(d=>{ const x=r.D[d.key]; if(x.topUp>0 && x.spd>0 && (x.cov+x.ship)/x.spd>TOPUP_MAX_DAYS+1e-9)
    bad.push(r.sup+' '+d.key+': добран выше '+TOPUP_MAX_DAYS+' дн ('+Math.round((x.cov+x.ship)/x.spd)+')'); }));
  console.log(bad.length? '\nНАРУШЕНИЯ ПРАВИЛ ('+bad.length+'):\n  '+bad.slice(0,30).join('\n  ') : '\nСамопроверка: машины по 33 паллеты и ≤ 6 кодов, отгрузка ≤ склада, добор ≤ 8 мес и только от 20 паллет базы — нарушений нет');
}
console.log('\nПодробности и выгрузка — вкладка «Оборачиваемость» → «Подсорт со склада».');
