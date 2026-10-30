/* calc/resupply.js — ОДИН расчёт подсорта и машин для сайта и scripts/resupply-report.cjs (с 30.10.2026).

   ЗАЧЕМ. Раньше правила подсорта жили в двух копиях: resupplyRows/topUpTrucks/truckFill/… в index.html и
   свой вариант в scripts/resupply-report.cjs, с пометками «ДЕРЖИ СИНХРОННО» (замечание продавца 30.10.2026 про
   тихие ошибки). Теперь копия одна — перенесена с сайта БЕЗ ИЗМЕНЕНИЯ ЛОГИКИ (функции дословно, глобальные
   переменные сайта заменены параметрами). Только правила, данных нет.

   ИСПОЛЬЗОВАНИЕ
     const R = Resupply.create(REAL_DATA, {funnelWb, funnelOz, facCode, retailReserve, wbFboSupply, dsWb, dsOz});
     R.resupplyRows()  → строки подсорта (те же поля, что читают таблица, выгрузка и «Рекомендации»), план — rows._truckPlan
     R.truckPlan(rows) · R.mpStats(mp) · R.buyoutInfo(mp) · R.buyoutOf(mp,sku,fallback) · R.klinBySup() · R.ozAssignedBySup()
     Resupply.whKey(имя склада) · Resupply.ozTransitEff(карточка, назначено) — от данных не зависят.

   ПРАВИЛА (ПРАВИЛА.md ЗАП-08, ЗАП-11, ЗАП-13; подробности — справочник/склад-и-подсорт.md и комментарии ниже):
   направления ВБ FBO и Ozon «Москва и МО» / «Казань / НН»; склады-источники Клин → Евросиб → Нск-1 → Москва;
   база — 180 дней запаса, сначала Ozon (по уровню воды), потом ВБ; машина — один склад на одно направление,
   ровно 33 паллеты и ≤ 6 кодов; добор только при базе ≥ 20 паллет товаром с запасом ≤ 240 дней. */
(function (root) {
  'use strict';
  // ---- константы правил ----
  const RESUPPLY_DAYS = 180;          // база: запас на направлении до 6 месяцев (ЗАП-13)
  const LAUNCH_QTY = 500;             // товара нет на площадке и продаж нет → стартовая партия
  const NSK2_MIN_TAKE = 100;          // на Евросибе позиции меньше 100 шт не берём
  const TOPUP_MIN_BASE = 20, TOPUP_MAX_DAYS = 240, RESUP_URGENT_DAYS = 10;
  const PALLETS_PER_TRUCK = 33, MAX_CODES_PER_TRUCK = 6;
  const BUYOUT_HOLD = 7, BUYOUT_WIN = 14, BUYOUT_MIN_ORD = 10;
  const RESUP_WH = ["klin", "nsk2", "nsk1", "msk"];
  const RESUP_DIRS = [
    {key:"oMsk",mp:"ozon",name:"Ozon · Москва и МО",short:"Москва",re:/москв|воронеж|ярослав|твер|петербург|ростов|краснодар/i},
    {key:"oKzn",mp:"ozon",name:"Ozon · Казань / Нижний Новгород",short:"Казань/НН",re:/казан|нижн|самар|уфа|оренбург|пермь|саратов/i},
    {key:"wFbo",mp:"wb",name:"Wildberries · FBO",short:"ВБ FBO"}];
  const RESUP_OZ = ["oMsk", "oKzn"];
  const RESUP_DIR_BY = {}; RESUP_DIRS.forEach(d => RESUP_DIR_BY[d.key] = d);
  const RESUP_WH_SHORT = {klin:"Клин",nsk2:"Евросиб",nsk1:"Нск-FBS",msk:"Мск"};
  const RESUP_RANK = {urgent:0,need:1,nostock:2,ok:3};

  function addDays(dateStr,n){ const d=new Date(dateStr+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
  /* Имя склада 1С → ключ. Порядок проверок важен: виртуальные склады Ozon — по ПАРЕ слов, «Клин» — по слову
     «Клин», явное «FBS» сильнее города (подробности — справочник/склад-и-подсорт.md). */
  function whKey(n){ const s=""+n;
  /* Виртуальные склады Ozon — ПЕРВЫМИ и по ПАРЕ слов («озон»+округ). Общее `/озон/`
     писать нельзя: под него попадёт «Склад ОЗОН ПФО» — баг выгрузки 1С, который продавец
     велел не считать (31.08.2026); подтверждены только СФО и ЦФО. */
  if(/(озон|ozon)/i.test(s) && /сфо/i.test(s)) return "ozsfo";
  if(/(озон|ozon)/i.test(s) && /цфо/i.test(s)) return "ozcfo";
  if(/клин/i.test(s)) return "klin";
  if(/(^|\W)fbs(\W|$)|фбс/i.test(s)) return "nsk1";
  if(/евросиб/i.test(s)) return "nsk2";
  if(/солнечногор|москв|(^|\W)мск(\W|$)/i.test(s)) return "msk";
  if(/новосиб|(^|\W)нск(\W|$)/i.test(s)) return "nsk2";
  return "other"; }
  // «в пути на Ozon» = в поставках в пути + max(в заявках, виртуальный склад) — одна партия в двух отчётах (13.10.2026)
  function ozTransitEff(card, assigned){
  const tot=(card&&card.ozTransit)||0;
  const split=card && card.ozReq!=null && card.ozWay!=null;
  const req=split? (card.ozReq||0) : tot, way=split? (card.ozWay||0) : 0;
  return way + Math.max(req, assigned||0);
}
  // % выкупа по окну «пропустить неделю, взять две» по воронке; незрелому окну не верим (см. index.html, 24.08)
  function buyoutFromFunnel(funnel){
  if(!funnel||!funnel.length) return null;
  const dates=[...new Set(funnel.map(r=>r.date))].sort();
  const to=addDays(dates[dates.length-1],-BUYOUT_HOLD), from=addDays(to,-(BUYOUT_WIN-1));
  const rows=funnel.filter(r=>r.date>=from&&r.date<=to);
  if(!rows.length) return null;
  const bySku={}; let o=0,b=0;
  rows.forEach(r=>{ const e=bySku[r.sku]||(bySku[r.sku]={o:0,b:0});
    e.o+=r.ordersQty||0; e.b+=r.buyoutQty||0; o+=r.ordersQty||0; b+=r.buyoutQty||0; });
  if(!o) return null;
  /* ЗРЕЛОСТЬ — по физике, а не по тренду. День, в котором были заказы, но выкуп почти
     нулевой, физически невозможен: значит по этому дню выкуп ещё не проставлен (или день
     выгружали в тот же день и с тех пор не обновляли). Хотя бы один такой день в окне —
     и всему окну верить нельзя. Сравнение «начало окна против хвоста» тут не работает:
     у ВБ мёртвые дни оказались в НАЧАЛЕ окна, и тренд выглядел «растущим», то есть
     здоровым. Порог: 20+ заказов за день при выкупе меньше 15%. */
  const byDate={};
  rows.forEach(r=>{ const e=byDate[r.date]||(byDate[r.date]={o:0,b:0});
    e.o+=r.ordersQty||0; e.b+=r.buyoutQty||0; });
  const dead=Object.keys(byDate).filter(d=>byDate[d].o>=20 && byDate[d].b/byDate[d].o<0.15).sort();
  return {from,to,all:b/o,bySku,dead,mature:dead.length===0,
    days:Object.keys(byDate).length};
}
  function resupDirOf(cl){ for(const d of RESUP_DIRS) if(d.re && d.re.test(cl)) return d.key; return null; }

  function create(RD, opts){
    opts = opts || {};
    const RETAIL_RESERVE = opts.retailReserve || 0;                       // розничный резерв отменён 18.10.2026 (ЗАП-04)
    const WB_FBO_SUPPLY = opts.wbFboSupply !== false;                     // поставки на ВБ FBO идут (21.09.2026)
    const facCode = opts.facCode || (() => "");
    const DS = { wb: opts.dsWb || (RD && RD.orderSeries ? {catalog:RD.catalog, bySku:RD.orderSeries.bySku, dates:RD.orderSeries.dates} : null),
                 oz: opts.dsOz || (RD && RD.ozon && RD.ozon.orderSeries ? {catalog:RD.ozon.catalog, bySku:RD.ozon.orderSeries.byArt, dates:RD.ozon.orderSeries.dates} : null) };
    function ozBuyoutHist(){
      const H=(RD&&RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutWin&&RD.ozon.meta.buyoutWin.history)||null;
      return (H&&H.length)? H.slice().sort((a,b)=>(a.builtAt||"")<(b.builtAt||"")?-1:1) : null; }
    let _klinCache=null, _ozAsgCache=null, _buyoutWin={};

    function klinBySup(){
      if(_klinCache) return _klinCache;
      const wh=(RD&&RD.warehouse&&RD.warehouse.bySup)||{}, out={};
      Object.keys(wh).forEach(s=>{ let q=0;
        Object.entries(wh[s].wh||{}).forEach(([n,v])=>{ if(whKey(n)==="klin") q+=v; });
        if(q>0) out[s]=q; });
      return (_klinCache=out);
    }

    function ozAssignedBySup(){
      if(_ozAsgCache) return _ozAsgCache;
      const wh=(RD&&RD.warehouse&&RD.warehouse.bySup)||{}, out={};
      Object.keys(wh).forEach(s=>{ let sfo=0,cfo=0;
        Object.entries(wh[s].wh||{}).forEach(([n,v])=>{ const k=whKey(n);
          if(k==="ozsfo") sfo+=v; else if(k==="ozcfo") cfo+=v; });
        if(sfo+cfo>0) out[s]={sfo,cfo,all:sfo+cfo}; });
      return (_ozAsgCache=out);
    }

    function buyoutInfo(mp){
      if(_buyoutWin[mp]!==undefined) return _buyoutWin[mp];
      /* У ВБ приоритет — ИЗМЕРЕННОЕ окно из сводного отчёта аналитики за период
         (`scripts/wb-buyout-window.cjs` → `RD.meta.buyoutWin`). Оно точнее подённой воронки:
         сводный отчёт выгружается разом за период, поэтому выкуп в нём не «заморожен» на дату
         каждого дня.
         ПРАВИЛО ПРОДАВЦА (01.09.2026, файл приходит каждый понедельник): окно = 14 дней,
         ПРОПУСТИВ последние 7, а сам процент = ВЫКУПЛЕНО ÷ (ВЫКУПЛЕНО + ОТМЕНЕНО), то есть
         от ЗАКРЫТЫХ заказов — ровно как «Процент выкупа» в кабинете ВБ. Заказы «в пути» из
         счёта исключены: их исход ещё неизвестен, и прежняя формула «÷ все заказы» считала их
         невыкупленными и занижала цифру (на окне 10–23.08 давала 62.9% против 76.0%).
         На зрелом окне обе формулы совпадают — «в пути» стремится к нулю. */
      const bw = mp!=="ozon" && RD && RD.meta && RD.meta.buyoutWin;
      if(bw && bw.all>0) return (_buyoutWin[mp]={from:bw.from,to:bw.to,all:bw.all,
        pctBySku:bw.bySku||{}, dead:[], mature:true, measured:true, openPct:bw.openPct});
      /* ОЗОН — ТО ЖЕ САМОЕ ПРАВИЛО, ЧТО У ВБ (решение продавца 21.09.2026: «процент выкупа давай
         по озону брать так же как и на вб по точно такой же логике»).
         Раньше Озон падал сразу в `buyoutFromFunnel` — окно по ПОДЁННОЙ воронке, а она ЗАМОРОЖЕНА
         на момент выгрузки: доставка дозревает задним числом, и день, выгруженный сразу, навсегда
         остаётся с заниженным выкупом. Отсюда и разъезд: финансы Озона шли по замеру 79,9%,
         а оборачиваемость и подсорт — по воронке 75,3%, при ОДНОМ И ТОМ ЖЕ окне 31.08–13.09
         и одной формуле. Замер из отчёта аналитики за период этим не страдает — он и берётся,
         ровно как `meta.buyoutWin` у ВБ.
         Берём ПОСЛЕДНИЙ замер: оборачиваемость и подсорт смотрят вперёд, им нужен действующий
         процент, а не исторический (в финансах по-прежнему `ozBuyoutFor(дата)` — там правило
         «с даты замера и вперёд», и прошлое не переписывается).
         Воронка остаётся фолбэком: если замеров нет вовсе — работает как работала. */
      if(mp==="ozon"){
        const H=ozBuyoutHist(), last=(H&&H.length)? H[H.length-1] : null;
        if(last && last.all>0) return (_buyoutWin[mp]={from:last.from,to:last.to,all:last.all,
          pctBySku:last.bySku||{}, dead:[], mature:true, measured:true});
      }
      const f = mp==="ozon" ? (opts.funnelOz||[]) : (opts.funnelWb||[]);
      return (_buyoutWin[mp]=buyoutFromFunnel(f));
    }

    function buyoutOf(mp,sku,fallback){
      const bi=buyoutInfo(mp);
      if(!bi || !bi.mature) return fallback;
      if(bi.pctBySku){ const p=bi.pctBySku[sku]; return p>0? p : bi.all; }   // измеренное окно
      const e=bi.bySku[sku];                                                 // окно из воронки
      return (e && e.o>=BUYOUT_MIN_ORD) ? e.b/e.o : bi.all;
    }

    function inbKeys(){ const inb=(RD&&RD.inbound)||{};
      return Object.keys(inb).filter(k=>inb[k]&&inb[k].bySup)
        .sort((a,b)=>{ if(a==="china")return -1; if(b==="china")return 1;
          return (((inb[a].eta||inb[a].etaSale||"9999-99-99")+"|"+a)).localeCompare(((inb[b].eta||inb[b].etaSale||"9999-99-99")+"|"+b)); }); }

    function inbOrderKeys(){ return inbKeys().filter(k=>k!=="china"); }

    function mpStats(mp){
      const oz = mp==="ozon";
      const ds = oz? DS.oz : DS.wb; if(!ds) return {};
      const dates=ds.dates, last=dates.length-1, days=Math.min(7,dates.length);
      const buyoutAvg = oz ? ((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutAll)||1)
        : (()=>{ const v=(RD.catalog||[]).map(c=>c.buyoutPct14d).filter(x=>x>0);
                 return v.length? v.reduce((a,b)=>a+b,0)/v.length/100 : 1; })();
      const openShip={};   // арт.поставщика → сколько отгружено на ВБ и ещё не принято
      (RD.shipments||[]).forEach(s=>{ if(s.mp==="wb"&&s.left>0) openShip[s.sup]=(openShip[s.sup]||0)+s.left; });
      /* Клин с 27.10.2026 — склад-источник на обе площадки (ЗАП-08), а не «в пути на ВБ»: в `transit` у ВБ
         идёт только журнал отгрузок (в т.ч. то, что уже уехало с Клина). Синхронно со скриптом. */
      /* СИММЕТРИЧНО ДЛЯ OZON — виртуальные склады «Ozon СФО»/«Ozon ЦФО» (13.10.2026).
         Товар уже распределён на Ozon и ждёт машины, поэтому он тоже «в пути»: иначе подсорт
         предложит отгрузить на площадку второй раз то, что на неё уже назначено.
         ВАЖНО: это НЕ слагаемое к `ozTransit`, а ВТОРОЙ ВЗГЛЯД НА ТУ ЖЕ ПАРТИЮ — заявка Озона
         и виртуальный склад описывают один и тот же товар, просто отчёты видят его в разное
         время. Сложение завышало покрытие (13.10: 11 281 шт вместо 10 890). Арифметика —
         в `ozTransitEff`, там же объяснение продавца. */
      const ozAsg = oz? ozAssignedBySup() : {};
      const out={}, shipDone=new Set();
      ds.catalog.forEach(c=>{
        const sup = oz ? (""+c.sku) : (""+(c.supplierCode||"")).trim();
        if(!sup) return;
        const ser=ds.bySku[c.sku]; let sum=0;
        if(ser) for(let i=Math.max(0,last-6);i<=last;i++) sum+=ser[i]||0;
        const avgD = days? sum/days : 0;
        // % выкупа — по окну «пропустить неделю, взять две» (buyoutOf), с откатом на прежний
        // источник площадки, если данные окна ещё не дозрели. См. buyoutFromFunnel.
        const buyout = buyoutOf(mp, c.sku,
          oz ? (c.ozBuyout!=null? c.ozBuyout : buyoutAvg)
             : (c.buyoutPct14d>0? c.buyoutPct14d/100 : buyoutAvg));
        const stock = oz ? (c.ozStock||0) : (c.wbStock||0);   // свой склад в покрытие НЕ входит
        // отгрузку по коду 1С добавляем ОДИН раз, даже если под кодом несколько артикулов ВБ
        let transit = oz ? (c.ozTransit||0) : 0;
        if(!shipDone.has(sup)){
          if(oz){ const az=ozAsg[sup]; transit = ozTransitEff(c, az? az.all : 0); }
          else transit += (openShip[sup]||0);
          shipDone.add(sup);
        }
        const e = out[sup] || (out[sup]={spd:0,stock:0,transit:0,name:c.name,category:c.category});
        e.spd += avgD*buyout; e.stock += stock; e.transit += transit;
        if(!e.name||e.name===sup) e.name=c.name;
      });
      /* КОД МОЖЕТ БЫТЬ УЖЕ РАСПРЕДЕЛЁН НА OZON, А КАРТОЧКИ ОЗОНА У НАС ЕЩЁ НЕТ (поймано
         13.10.2026 на 519571 и 519588: 936 и 1 224 шт лежат на виртуальных складах, карточка
         Озона не заведена — товар новый). Цикл выше идёт по каталогу площадки, поэтому такой
         код не получил бы «в пути» вовсе, покрытие вышло бы 0, и подсорт предложил бы отправить
         на Ozon стартовую партию ПОВЕРХ того, что уже назначено. Заводим строку сами. */
      if(oz) Object.keys(ozAsg).forEach(sup=>{ if(out[sup]) return;
        out[sup]={spd:0,stock:0,transit:ozAsg[sup].all,name:sup,category:""}; shipDone.add(sup); });
      Object.values(out).forEach(e=>{ e.covered=e.stock+e.transit;
        e.days = e.spd>0 ? e.covered/e.spd : (e.covered>0? Infinity : 0); });
      return out;
    }

    function resupOzSplit(sup, asg){
      const CL=(RD&&RD.ozon&&RD.ozon.clusters)||{}, m=(CL.bySup||{})[sup]||{}, a=asg||{sfo:0,cfo:0};
      const s={oMsk:0,oKzn:0}, av={oMsk:0,oKzn:0}, rd={oMsk:0,oKzn:0}, rq={oMsk:0,oKzn:0}; let all=0;
      Object.entries(m).forEach(([cl,v])=>{ all+=v.spd||0; const k=resupDirOf(cl); if(!k) return;
        s[k]+=v.spd||0; av[k]+=v.avail||0; rd[k]+=v.road||0; rq[k]+=v.req||0; });
      let share;
      if(all>0) share={oMsk:s.oMsk/all, oKzn:s.oKzn/all};
      else { const acc={oMsk:0,oKzn:0}; let tot=0;
        Object.entries(CL.byCluster||{}).forEach(([cl,e])=>{ const v=e.spd||0; tot+=v; const k=resupDirOf(cl); if(k) acc[k]+=v; });
        share = tot>0? {oMsk:acc.oMsk/tot, oKzn:acc.oKzn/tot} : {oMsk:1, oKzn:0}; }
      return {share, outShare:Math.max(0,1-share.oMsk-share.oKzn),
        cov:{oMsk:av.oMsk+rd.oMsk+Math.max(rq.oMsk,a.cfo||0), oKzn:av.oKzn+rd.oKzn+Math.max(rq.oKzn,a.sfo||0)}};
    }

    function resupplyRows(){
      const W=mpStats("wb"), O=mpStats("ozon");
      const wh=(RD&&RD.warehouse&&RD.warehouse.bySup)||{}, split=!!(RD&&RD.warehouse&&RD.warehouse.split);
      // то, что едет К ПРОДАВЦУ (не на площадку): Китай ~1 мес, заказы производству — по своим
      // датам прихода (партий несколько, см. inbKeys)
      const inb=(RD&&RD.inbound)||{};
      const chinaBy=(inb.china&&inb.china.bySup)||{}, ordKeys=inbOrderKeys();
      const orderBy={}; ordKeys.forEach(k=>Object.entries(inb[k].bySup||{})
        .forEach(([s,q])=>orderBy[s]=(orderBy[s]||0)+q));
      const zero={spd:0,stock:0,transit:0,covered:0,days:0,name:"",category:""};
      // «На вывод» — товар выводим из ассортимента, ВЕЗТИ его на площадку смысла нет:
      // по просьбе продавца такие коды из подсорта исключаются целиком (в дозаказе/закупе
      // статус по-прежнему справочный и на расчёт не влияет — там решает сам продавец).
      // Считаем по ВСЕМ карточкам кода 1С: если хоть одна НЕ «На вывод» — товар живой.
      const outSup=new Set(); {
        const st={}; (RD.catalog||[]).forEach(c=>{ const s=(""+(c.supplierCode||"")).trim(); if(!s) return;
          const out=(""+(c.productionStatus||"")).trim()==="На вывод";
          st[s]=(st[s]===undefined)? out : (st[s]&&out); });
        /* НО: выводимый товар, который ЛЕЖИТ НА СКЛАДЕ, в подсорте остаётся. Просьба продавца
           26.08: «если у этих товаров где-то есть остаток — пока считай, мне нужно их быстрее
           распродать». Распродать можно только на площадке, значит везти его как раз нужно.
           Выкидываем лишь те, по которым везти нечего. */
        Object.keys(st).forEach(s=>{ if(st[s] && !((wh[s]&&wh[s].qty)>0)) outSup.add(s); });
      }
      const sups=[...new Set([...Object.keys(W),...Object.keys(O),...Object.keys(wh),...Object.keys(chinaBy),...Object.keys(orderBy)])]
        .filter(s=>!outSup.has(s));
      const contBySup={}; (RD.catalog||[]).forEach(c=>{ const s=(""+(c.supplierCode||"")).trim();
        if(s&&c.containerQty&&!contBySup[s]) contBySup[s]=c.containerQty; });
      const skuBySup={}; (RD.catalog||[]).forEach(c=>{ const s=(""+(c.supplierCode||"")).trim(); if(s&&!skuBySup[s]) skuBySup[s]=c.sku; });
      const ozSet=new Set(((RD.ozon&&RD.ozon.catalog)||[]).map(c=>""+c.sku));   // есть ли карточка на Озоне
      // код фабрики и произв. статус ведутся в каталоге ВБ; берём их ПО КОДУ 1С напрямую,
      // а не через catalogFactoryBySku — та карта построена под текущую площадку и на Озоне пуста
      const wbBySup={}; (RD.catalog||[]).forEach(c=>{ const s=(""+(c.supplierCode||"")).trim(); if(s&&!wbBySup[s]) wbBySup[s]=c; });
      const asgAll=ozAssignedBySup();
      const daysOf=(cov,spd)=> spd>0? cov/spd : (cov>0? Infinity : 0);
      const mkD=(spd,cov)=>({spd,cov,need:0,ship:0,pal:{klin:0,nsk2:0,nsk1:0,msk:0},pcs:{klin:0,nsk2:0,nsk1:0,msk:0},
        topUp:0,roll:0,days:daysOf(cov,spd)});
      const all=sups.map(sup=>{
        const w=W[sup]||zero, o=O[sup]||zero;
        const have=wh[sup]||{qty:0,wb:0,oz:0};
        const whB=have.wh||{}; const wq={msk:0,nsk1:0,nsk2:0,klin:0,ozsfo:0,ozcfo:0,other:0};
        Object.entries(whB).forEach(([n,q])=>{ wq[whKey(n)]+=q; });
        const whMsk=wq.msk, whNsk1=wq.nsk1, whNsk2=wq.nsk2, whKlin=wq.klin, whOther=wq.other;
        const whOzS=wq.ozsfo, whOzC=wq.ozcfo, whOzAsg=whOzS+whOzC;
        /* `haveTotal` — то, что РЕАЛЬНО можно отгрузить: весь склад МИНУС виртуальные склады Ozon (товар
           уже назначен на Ozon). Клин с 27.10.2026 — обычный склад-источник (ЗАП-08), он в отгрузке. */
        const haveTotal=Math.max(0, ((wh[sup]&&wh[sup].qty)||0) - whOzAsg);
        // Розничный резерв (RETAIL_RESERVE, сейчас 0): сначала Евросиб, недостающее — Нск-1
        const holdNsk2=Math.min(whNsk2,RETAIL_RESERVE);
        const holdNsk1=Math.min(whNsk1,Math.max(0,RETAIL_RESERVE-whNsk2));
        const availNsk2=(whNsk2>=NSK2_MIN_TAKE? whNsk2-holdNsk2 : 0), availNsk1=whNsk1-holdNsk1;
        const retailHold=holdNsk2+holdNsk1;
        const haveShip=Math.max(0, haveTotal-retailHold);
        // товара на площадке нет и продаж нет → стартовая партия (иначе новинки не поехали бы никогда)
        const isLaunchW = WB_FBO_SUPPLY && w.spd<=0 && w.covered<=0 && haveShip>0;
        const isLaunchO = o.spd<=0 && o.covered<=0 && haveShip>0;
        const P=(RD&&RD.pallets&&RD.pallets.bySup&&RD.pallets.bySup[sup])||null;
        const palOz=P? (P.oz||0):0, palWb=P? (P.wb||0):0;
        const sp=resupOzSplit(sup, asgAll[sup]);
        const D={oMsk:mkD(o.spd*sp.share.oMsk, sp.cov.oMsk), oKzn:mkD(o.spd*sp.share.oKzn, sp.cov.oKzn),
                 wFbo:mkD(w.spd, w.covered)};
        const wcat=wbBySup[sup]||null;
        return {sup, sku:skuBySup[sup]||sup, skuWb:skuBySup[sup]||null, skuOz:(ozSet.has(sup)? sup : null),
          factory: (wcat? (""+(wcat.factoryCode||"")).trim() : "")||facCode(sup),
          pStatus: wcat? (""+(wcat.productionStatus||"")).trim() : "",
          name:(w.name||o.name||sup), category:(w.category||o.category||""),
          contQty:contBySup[sup]||0,
          wSpd:w.spd, wCov:w.covered, wStock:w.stock, wTransit:w.transit, wDays:w.days,
          oSpd:o.spd, oCov:o.covered, oStock:o.stock, oTransit:o.transit, oDays:o.days,
          have:(split? have.wb+have.oz : haveTotal), haveShip, retailHold, availNsk1, availNsk2,
          haveWb:have.wb, haveOz:have.oz, split,
          whBy:whB, whMsk, whNsk:whNsk1+whNsk2, whNsk1, whNsk2, whKlin, whOzS, whOzC, whOzAsg, whOther,
          china:(chinaBy[sup]||0), onOrder:(orderBy[sup]||0),
          palOz, palWb, isLaunchO, isLaunchW, ozOutShare:sp.outShare, noPal:false,
          pool:{klin:whKlin, nsk2:availNsk2, nsk1:availNsk1, msk:whMsk}, hold:{klin:0,nsk2:0,nsk1:0,msk:0}, D,
          move:0, moveNeed:0};
      });
      const capOf=(r,k)=> k==="wFbo"? r.palWb : r.palOz;
      /* Забор со складов в порядке RESUP_WH. ОКРУГЛЯЕМ ВВЕРХ до паллеты (решение продавца 24.08), но не
         больше, чем есть целыми паллетами. Без вместимости паллеты — штуками, в машины такое не входит. */
      const take=(r,k,qty)=>{ const d=r.D[k], cap=capOf(r,k); if(qty<=0) return;
        if(cap>0){ let left=Math.ceil(qty/cap);
          for(const w of RESUP_WH){ const p=Math.min(left,Math.floor(r.pool[w]/cap)); if(p<=0) continue;
            d.pal[w]+=p; r.pool[w]-=p*cap; d.ship+=p*cap; left-=p; if(left<=0) break; } }
        else { r.noPal=true; let left=qty;
          for(const w of RESUP_WH){ const x=Math.min(left,r.pool[w]); if(x<=0) continue;
            d.pcs[w]+=x; r.pool[w]-=x; d.ship+=x; left-=x; if(left<=0) break; } } };
      const shippable=(r,cap)=> cap>0? RESUP_WH.reduce((a,w)=>a+Math.floor(r.pool[w]/cap)*cap,0)
                                     : RESUP_WH.reduce((a,w)=>a+r.pool[w],0);
      // уровень воды между направлениями одной площадки, потолок — RESUPPLY_DAYS
      const waterFill=(ds,avail,cap)=>{
        const need=ds.map(d=>Math.max(0,d.spd*cap-d.cov)), tot=need.reduce((a,b)=>a+b,0);
        if(tot<=avail) return need;
        let lo=0, hi=cap;
        for(let it=0; it<60; it++){ const L=(lo+hi)/2;
          const s=ds.reduce((a,d)=>a+Math.max(0,d.spd*L-d.cov),0); if(s>avail) hi=L; else lo=L; }
        return ds.map(d=>Math.max(0,d.spd*lo-d.cov)); };
      // ---- база Ozon ----
      all.forEach(r=>{
        RESUP_OZ.forEach(k=>{ const d=r.D[k]; d.need=Math.max(0,Math.ceil(d.spd*RESUPPLY_DAYS-d.cov)); });
        if(r.isLaunchO){ r.D.oMsk.need=Math.min(LAUNCH_QTY,r.haveShip); take(r,"oMsk",r.D.oMsk.need); return; }
        const want=waterFill(RESUP_OZ.map(k=>r.D[k]), shippable(r,r.palOz), RESUPPLY_DAYS);
        RESUP_OZ.map((k,i)=>({k,q:want[i]})).sort((a,b)=>b.q-a.q).forEach(x=>take(r,x.k,x.q));
      });
      const plan=[];
      topUpTrucks(all, RESUP_OZ, plan);
      // ---- ВБ FBO — из того, что осталось после Ozon; товар несобравшихся машин Ozon держим за Ozon ----
      all.forEach(r=>RESUP_WH.forEach(w=>{ r.hold[w]=Math.min(r.hold[w],r.pool[w]); r.pool[w]-=r.hold[w]; }));
      all.forEach(r=>{ const d=r.D.wFbo;
        d.need = !WB_FBO_SUPPLY? 0 : (r.isLaunchW? Math.min(LAUNCH_QTY,r.haveShip) : Math.max(0,Math.ceil(d.spd*RESUPPLY_DAYS-d.cov)));
        take(r,"wFbo",d.need); });
      topUpTrucks(all, ["wFbo"], plan);
      all.forEach(r=>RESUP_WH.forEach(w=>{ r.pool[w]+=r.hold[w]; }));
      plan.sort((a,b)=>(a.mp==="wb")-(b.mp==="wb") || b.total-a.total);
      // ---- поля строки, которые читают таблица, выгрузка и «Рекомендации» ----
      all.forEach(r=>{ const o1=r.D.oMsk, o2=r.D.oKzn, wf=r.D.wFbo;
        const sumW=(a,b,w)=>a.pal[w]+(b? b.pal[w]:0);
        r.needO=o1.need+o2.need; r.shipO=o1.ship+o2.ship; r.topUpO=o1.topUp+o2.topUp; r.rollO=o1.roll+o2.roll;
        r.needW=wf.need; r.shipW=wf.ship; r.topUpW=wf.topUp; r.rollW=wf.roll;
        r.oKlin=sumW(o1,o2,"klin"); r.oNsk2=sumW(o1,o2,"nsk2"); r.oNsk1=sumW(o1,o2,"nsk1"); r.oMsk=sumW(o1,o2,"msk");
        r.wKlin=wf.pal.klin; r.wNsk2=wf.pal.nsk2; r.wNsk1=wf.pal.nsk1; r.wMsk=wf.pal.msk;
        r.palShipO=r.oKlin+r.oNsk2+r.oNsk1+r.oMsk; r.palShipW=r.wKlin+r.wNsk2+r.wNsk1+r.wMsk;
        const used=w=>r.D.oMsk.pal[w]*r.palOz+r.D.oKzn.pal[w]*r.palOz+wf.pal[w]*r.palWb
          +r.D.oMsk.pcs[w]+r.D.oKzn.pcs[w]+wf.pcs[w];
        r.usedKlin=used("klin"); r.usedNsk2=used("nsk2"); r.usedNsk1=used("nsk1"); r.usedMsk=used("msk");
        r.holdOz=RESUP_WH.reduce((a,w)=>a+r.hold[w],0);
        // ПОКРЫТИЕ ВБ С FBS (справочно): что осталось на Москве и Нск-1 после отгрузок
        r.nsk1Free=Math.max(0,r.whNsk1-r.usedNsk1); r.mskFree=Math.max(0,r.whMsk-r.usedMsk);
        r.wbFbsFree=r.mskFree+r.nsk1Free; r.wCovAll=r.wCov+r.wbFbsFree;
        r.wDaysAll=r.wSpd>0? r.wCovAll/r.wSpd : (r.wCovAll>0? Infinity:0);
        r.nsk1Days=r.wSpd>0? r.nsk1Free/r.wSpd : (r.nsk1Free>0? Infinity:0);
        r.launchNote=(r.isLaunchO||r.isLaunchW)
          ? ("нет на "+[r.isLaunchO?"Озоне":"",r.isLaunchW?"ВБ":""].filter(Boolean).join(" и ")+" — стартовая партия") : "";
        r.palNote=!(RD&&RD.pallets&&RD.pallets.bySup&&RD.pallets.bySup[r.sup])? "нет данных о паллете"
          : (r.needO>0&&r.palOz>0&&r.needO<r.palOz) ? "нужно меньше паллеты"
          : (r.needO>0&&(r.whNsk1+r.whNsk2+r.whMsk+r.whKlin)>0&&r.palShipO===0&&!r.rollO) ? "на складе меньше паллеты" : "";
        r.ship=r.shipW+r.shipO;
        r.rest=Math.max(0,(r.whMsk+r.whNsk1+r.whNsk2+r.whKlin+r.whOther)-r.ship);
        r.daysAfterW=r.wSpd>0? (r.wCov+r.shipW)/r.wSpd : (r.wCov+r.shipW>0? Infinity:0);
        r.daysAfterO=r.oSpd>0? (r.oCov+r.shipO)/r.oSpd : (r.oCov+r.shipO>0? Infinity:0);
        r.minDays=Math.min(r.wSpd>0?r.wDays:Infinity, r.oSpd>0?r.oDays:Infinity);
        // статус: «Нет на складе» — нужно, а отгружать нечего (назначенное на Ozon и резерв не в счёт)
        const haveAll=r.split? r.haveWb+r.haveOz : r.haveShip;
        const mkSt=(nd,days,hv)=> nd<=0? "ok" : (hv<=0? "nostock" : (days<RESUP_URGENT_DAYS? "urgent":"need"));
        r.stO=mkSt(r.needO,r.oDays,r.split?r.haveOz:haveAll);
        r.stW=mkSt(r.needW,r.wDays,r.split?r.haveWb:haveAll);
        r.status=RESUP_RANK[r.stW]<RESUP_RANK[r.stO]? r.stW : r.stO;
      });
      const out=all.filter(r=> r.needW>0 || r.needO>0 || r.have>0 || r.china>0 || r.onOrder>0 );
      // план машин собран вместе с добором и едет вместе со строками: перепаковка после добора
      // могла бы разложить паллеты иначе и развалить уже полные машины (см. truckPlan)
      Object.defineProperty(out,"_truckPlan",{value:plan,enumerable:false});
      // полный список (и без дела, и без остатка) — для итогов спроса по направлениям в scripts/resupply-report.cjs
      Object.defineProperty(out,"_allRows",{value:all,enumerable:false});
      return out;
    }

    function truckItems(rows,wh,k){
      const oz=k!=="wFbo";
      return rows.map(r=>({sup:r.sup,name:r.name,pal:(r.D? r.D[k].pal[wh] : 0),days:(r.D? r.D[k].days : 0),
        cap:(oz? r.palOz : r.palWb),have:r.have})).filter(x=>x.pal>0);
    }

    function packTrucks(items){
      const dk=d=>d===Infinity? 1e9 : (d||0);
      const pool=items.filter(x=>x.pal>0).map(x=>({...x,left:x.pal}))
        .sort((a,b)=>dk(a.days)-dk(b.days) || b.pal-a.pal || (a.sup<b.sup?-1:(a.sup>b.sup?1:0)));
      const trucks=[];
      while(pool.some(x=>x.left>0)){
        const t={pallets:0,free:PALLETS_PER_TRUCK,items:[]};
        while(t.free>0 && t.items.length<MAX_CODES_PER_TRUCK){
          const live=pool.filter(x=>x.left>0); if(!live.length) break;
          const c = (MAX_CODES_PER_TRUCK-t.items.length>1) ? live[0]
            : (live.find(x=>x.left>=t.free) || live.reduce((m,x)=>x.left>m.left? x : m));
          const take=Math.min(c.left,t.free);
          t.items.push({sup:c.sup,name:c.name,cap:c.cap,have:c.have,days:c.days,pal:take});
          c.left-=take; t.free-=take; t.pallets+=take;
        }
        trucks.push(t);
      }
      return trucks;
    }

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

    function truckPlanEntry(wh,k,trucks,dropped){
      trucks.sort((a,b)=>b.pallets-a.pallets);
      const tail=trucks.filter(t=>t.pallets<PALLETS_PER_TRUCK);
      dropped=dropped||[];
      const d=RESUP_DIR_BY[k]||{mp:(k==="wFbo"?"wb":"ozon"),name:k,short:k};
      return {wh:RESUP_WH_SHORT[wh]||wh, whKey:wh, dir:k, dirName:d.name, dirShort:d.short, mp:d.mp,
        total:trucks.reduce((a,t)=>a+t.pallets,0),trucks,
        full:trucks.length-tail.length,tailPallets:tail.reduce((a,t)=>a+t.pallets,0),
        codes:new Set(trucks.flatMap(t=>t.items.map(x=>x.sup))).size,
        // машины, которые не едут (база < 20 или добить нечем): паллеты вернулись на склад
        dropped, droppedPallets:dropped.reduce((a,t)=>a+t.pallets,0)};
    }

    function topUpTrucks(rows, keys, plan){
      const bySup={}; rows.forEach(r=>{ bySup[r.sup]=r; });
      const capOf=(r,k)=> k==="wFbo"? r.palWb : r.palOz;
      // сдвинуть отгрузку кода по паре на pals паллет (минус — откат машины; откат Ozon держим за Ozon)
      const shift=(r,p,pals,isTop,quiet)=>{ const d=r.D[p.k], qty=pals*capOf(r,p.k);
        r.pool[p.wh]-=qty; d.pal[p.wh]+=pals; d.ship+=qty;
        if(isTop) d.topUp+=qty; else if(pals<0 && !quiet){ d.roll-=qty; if(p.k!=="wFbo") r.hold[p.wh]+=-qty; } };
      const pairs=[]; RESUP_WH.forEach((wh,i)=>keys.forEach(k=>
        pairs.push({wh,k,i,total:rows.reduce((a,r)=>a+r.D[k].pal[wh],0)})));
      pairs.sort((a,b)=>(b.total-a.total) || (a.i-b.i));
      // пара с базой меньше TOPUP_MIN_BASE на весь склад не поедет — снимаем её сразу
      const entries=new Map();
      pairs.forEach(p=>{ if(p.total<=0 || p.total>=TOPUP_MIN_BASE) return;
        const items=truckItems(rows,p.wh,p.k);
        items.forEach(x=>shift(bySup[x.sup],p,-x.pal,false));
        entries.set(p,{kept:[],dropped:[{pallets:p.total,free:0,items:items.map(x=>({...x})),
          why:"база "+p.total+" палл. меньше "+TOPUP_MIN_BASE}]}); });
      const retry=[];
      pairs.forEach(p=>{ if(p.total<TOPUP_MIN_BASE) return;
        const trucks=packTrucks(truckItems(rows,p.wh,p.k)), kept=[], dropped=[];
        trucks.forEach((t,ti)=>{
          if(t.pallets>=PALLETS_PER_TRUCK){ kept.push(t); return; }
          truckConsolidate(t,kept);
          t.base=t.pallets;
          let add=t.pallets>=TOPUP_MIN_BASE? truckFill(rows,p,t) : null, cut=[];
          if(!add && t.pallets>=TOPUP_MIN_BASE){
            const small=t.items.slice().sort((a,b)=>a.pal-b.pal || (a.sup<b.sup?-1:(a.sup>b.sup?1:0)));
            for(let n=1; n<small.length && !add; n++){
              const off=new Set(small.slice(0,n).map(x=>x.sup));
              const items=t.items.filter(x=>!off.has(x.sup)), pals=items.reduce((s,x)=>s+x.pal,0);
              if(pals<TOPUP_MIN_BASE) break;
              const a2=truckFill(rows,p,{items,pallets:pals});
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
                dropped.push({pallets:cut.reduce((s,x)=>s+x.pal,0),free:0,items:cut,why:"снят мелкий код"}); } }
          }
          if(add){ add.forEach((pals,r)=>{ shift(r,p,pals,true);
              const ex=t.items.find(x=>x.sup===r.sup);
              if(ex) ex.pal+=pals;
              else t.items.push({sup:r.sup,name:r.name,cap:capOf(r,p.k),have:r.have,days:r.D[p.k].days,pal:pals});
              t.pallets+=pals; t.free-=pals; });
            kept.push(t); }
          else { t.items.forEach(x=>shift(bySup[x.sup],p,-x.pal,false));
            const dt={...t, why: t.pallets<TOPUP_MIN_BASE? "база "+t.pallets+" палл. меньше "+TOPUP_MIN_BASE
              : "нечем добить товаром до "+Math.round(TOPUP_MAX_DAYS/30)+" мес"};
            dropped.push(dt); if(t.pallets>=TOPUP_MIN_BASE) retry.push({p,t:dt}); }
        });
        entries.set(p,{kept,dropped});
      });
      // второй заход: после снятия несобравшихся машин на складе мог освободиться товар для добора
      retry.forEach(({p,t})=>{
        if(!t.items.every(x=>{ const r=bySup[x.sup]; return r.pool[p.wh]>=x.pal*capOf(r,p.k); })) return;
        t.items.forEach(x=>shift(bySup[x.sup],p,x.pal,false));
        const add=truckFill(rows,p,{items:t.items,pallets:t.pallets});
        // не добить и во второй раз — тихий откат: «не едет» и «держим за Ozon» записаны первым заходом
        if(!add){ t.items.forEach(x=>shift(bySup[x.sup],p,-x.pal,false,true)); return; }
        const nt={pallets:t.pallets,free:PALLETS_PER_TRUCK-t.pallets,items:t.items.map(x=>({...x})),base:t.pallets};
        add.forEach((pals,r)=>{ shift(r,p,pals,true); const ex=nt.items.find(x=>x.sup===r.sup);
          if(ex) ex.pal+=pals; else nt.items.push({sup:r.sup,name:r.name,cap:capOf(r,p.k),have:r.have,days:r.D[p.k].days,pal:pals});
          nt.pallets+=pals; nt.free-=pals; });
        const e=entries.get(p); e.kept.push(nt); e.dropped=e.dropped.filter(x=>x!==t);
        // первый заход записал откат — товар поехал, снимаем отметку «не едет» и «держим за Ozon»
        t.items.forEach(x=>{ const r=bySup[x.sup], q=x.pal*capOf(r,p.k); r.D[p.k].roll-=q;
          if(p.k!=="wFbo") r.hold[p.wh]=Math.max(0,r.hold[p.wh]-q); });
      });
      pairs.forEach(p=>{ const e=entries.get(p); if(e) plan.push(truckPlanEntry(p.wh,p.k,e.kept,e.dropped)); });
    }

    function truckFill(rows,p,t){
      const k=p.k, pal=r=> k==="wFbo"? r.palWb : r.palOz, spd=r=>r.D[k].spd, base=r=>r.D[k].cov+r.D[k].ship;
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
            // лучшие из ОСТАЛЬНЫХ новых на slots−1 мест: если r среди первых slots−1, берём slots и вычитаем его
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

    function truckPlan(rows){
      if(rows && rows._truckPlan) return rows._truckPlan;
      // строки не из resupplyRows — та же упаковка по парам «склад × направление», но без добора
      const plan=[];
      if(rows && rows.length && rows[0].D) RESUP_WH.forEach(wh=>RESUP_DIRS.forEach(d=>{
        const items=truckItems(rows,wh,d.key); if(!items.length) return;
        plan.push(truckPlanEntry(wh,d.key,packTrucks(items))); }));
      return plan.sort((a,b)=>b.total-a.total);
    }

    return { klinBySup, ozAssignedBySup, buyoutInfo, buyoutOf, inbKeys, inbOrderKeys, mpStats, resupOzSplit,
      resupplyRows, truckItems, packTrucks, truckConsolidate, truckPlanEntry, topUpTrucks, truckFill, truckPlan };
  }

  const api = { create, whKey, ozTransitEff, buyoutFromFunnel, addDays, resupDirOf,
    RESUPPLY_DAYS, LAUNCH_QTY, NSK2_MIN_TAKE, TOPUP_MIN_BASE, TOPUP_MAX_DAYS, RESUP_URGENT_DAYS, PALLETS_PER_TRUCK,
    MAX_CODES_PER_TRUCK, BUYOUT_HOLD, BUYOUT_WIN, BUYOUT_MIN_ORD, RESUP_WH, RESUP_DIRS, RESUP_OZ, RESUP_DIR_BY,
    RESUP_WH_SHORT, RESUP_RANK };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Resupply = api;
})(typeof window !== 'undefined' ? window : this);
