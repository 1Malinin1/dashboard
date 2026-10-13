// ВОЗВРАТ СТАТУСА «НА ВЫВОД», КОГДА ОСТАТОК КОНЧИЛСЯ (правило продавца 13.10.2026).
//
// Дословно: «487153 — убери этот товар из статуса на выводе до тех пор пока у него есть
// остаток, а то он у меня с вида выпадает, как только остатки закончатся обратно статус
// на вывод вернёшь».
//
// ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ МЕХАНИЗМ, А НЕ РАЗОВАЯ ПРАВКА СТАТУСА. Продавец 02.09.2026 попросил
// УБРАТЬ выводимые товары из всех перечней (флаг `showOut`), и это правило работает: иначе
// половина советов была бы про товар, который и так убирают. Но у выводимого товара ещё
// лежит остаток, и пока он лежит — его надо видеть и продавать. Значит статус приходится
// временно снимать, а потом ВЕРНУТЬ. «Потом» наступает через недели, когда контекст сессии
// давно не живёт: вернуть руками невозможно — про это просто никто не вспомнит, и товар
// навсегда останется в живом ассортименте, искажая и перечни, и подсорт.
// Поэтому список временно активных живёт В СНИМКЕ (`meta.outWhenEmpty`), а проверка
// прогоняется САМА при каждой заливке остатков — тот же приём, что петля Клина
// (падение остатка → отгрузка → приёмка по росту) из `update-wb-stock.cjs`.
//
// ОСТАТОК СЧИТАЕТСЯ ПО ВСЕМ МЕСТАМ СРАЗУ: склады ВБ + Ozon (доступно и в пути) + свой склад.
// Товар один, витрин две, и «кончился» — это кончился везде. Порог строгий (0 шт): любой
// люфт означал бы, что статус вернулся, пока товар ещё продаётся.
//
// Вызывается из ВСЕХ загрузчиков остатков: update-wb-stock.cjs · ozon-build.cjs ·
// ozon-stock-detail.cjs · update-warehouse.cjs (stock). Логика одна на всех — поэтому
// она здесь, а не продублирована четыре раза.
'use strict';

const OUT_STATUS='На вывод';
const norm=s=>String(s==null?'':s).replace(/[\s ,]/g,'').trim();
const F=n=>Number(n||0).toLocaleString('ru-RU');

function store(RD){
  const m=(RD.meta&&RD.meta.outWhenEmpty)||null;
  return (m&&Array.isArray(m.items))? m.items : [];
}
function save(RD,items){
  RD.meta=RD.meta||{};
  if(!items.length){ delete RD.meta.outWhenEmpty; return; }
  RD.meta.outWhenEmpty={items, updatedAt:new Date().toISOString().slice(0,10),
    note:'Товары, у которых статус «На вывод» СНЯТ ВРЕМЕННО — пока есть остаток. '
      +'Проверяется сам при каждой заливке остатков (lib/out-when-empty.cjs): как только '
      +'остаток кончился везде (ВБ + Ozon + свой склад), статус возвращается.'};
}

// Остаток по коду 1С во всех местах
function stockOf(RD,sup){
  const s=norm(sup);
  let wb=0, oz=0, ozT=0, wh=0;
  (RD.catalog||[]).forEach(c=>{ if(norm(c.supplierCode)!==s) return; wb+=c.wbStock||0; });
  const oc=((RD.ozon&&RD.ozon.catalog)||[]).find(c=>norm(c.sku)===s);
  if(oc){ oz=oc.ozStock||0; ozT=oc.ozTransit||0; }
  const w=((RD.warehouse&&RD.warehouse.bySup)||{})[s] || ((RD.warehouse&&RD.warehouse.bySup)||{})[String(sup).trim()];
  if(w) wh=w.qty||0;
  return {wb,oz,ozT,wh,all:wb+oz+ozT+wh};
}

/* ПРОВЕРКА. Зовётся загрузчиком ПЕРЕД записью wb-data.js. Печатает сама — продавцу важно
   увидеть и возврат статуса, и сколько осталось у тех, кто ещё держится. */
function check(RD){
  const items=store(RD);
  if(!items.length) return {returned:[], waiting:[]};
  const returned=[], waiting=[], keep=[];
  items.forEach(it=>{
    const st=stockOf(RD,it.sup);
    if(st.all>0){ waiting.push({sup:it.sup, st, it}); keep.push(it); return; }
    let n=0;
    (RD.catalog||[]).forEach(c=>{ if(norm(c.supplierCode)!==norm(it.sup)) return;
      if(c.productionStatus!==OUT_STATUS){ c.productionStatus=OUT_STATUS; n++; } });
    returned.push({sup:it.sup, cards:n, it});
  });
  save(RD,keep);
  if(returned.length){
    console.log('\nСТАТУС «НА ВЫВОД» ВОЗВРАЩЁН — ОСТАТОК КОНЧИЛСЯ (правило продавца 13.10.2026):');
    returned.forEach(r=>console.log('   1С '+r.sup+' · карточек ВБ: '+r.cards
      +(r.it.since? ' · был снят '+r.it.since : '')+(r.it.note? ' · '+r.it.note : '')));
    console.log('   Товар снова скрыт из перечней (флаг showOut). Скажите, если это рано.');
  }
  if(waiting.length){
    console.log('\nСТАТУС «На вывод» СНЯТ ВРЕМЕННО, ждём конца остатка — '+waiting.length+':');
    waiting.forEach(w=>console.log('   1С '+w.sup+' · остаток '+F(w.st.all)+' шт'
      +' (ВБ '+F(w.st.wb)+' · Ozon '+F(w.st.oz)+(w.st.ozT? ' +'+F(w.st.ozT)+' в пути':'')
      +' · склад '+F(w.st.wh)+')'));
  }
  return {returned, waiting};
}

/* РЕГИСТРАЦИЯ: снять статус до конца остатка. Возвращает текст для вывода. */
function hold(RD,sup,status,note){
  const s=norm(sup);
  const cards=(RD.catalog||[]).filter(c=>norm(c.supplierCode)===s);
  if(!cards.length) return {ok:false, msg:'1С '+sup+' — нет карточек ВБ'};
  const st=stockOf(RD,sup);
  if(st.all<=0) return {ok:false, msg:'1С '+sup+' — остатка нет нигде, снимать статус не нужно'};
  cards.forEach(c=>{ c.productionStatus=status||'В работе'; });
  const items=store(RD).filter(x=>norm(x.sup)!==s);
  items.push({sup:s, since:new Date().toISOString().slice(0,10), status:status||'В работе',
    note:note||'снят до конца остатка'});
  save(RD,items);
  return {ok:true, cards:cards.length, st,
    msg:'1С '+sup+' → «'+(status||'В работе')+'» на '+cards.length+' карточках ВБ · остаток '
      +F(st.all)+' шт (ВБ '+F(st.wb)+' · Ozon '+F(st.oz)+(st.ozT? ' +'+F(st.ozT)+' в пути':'')
      +' · склад '+F(st.wh)+')'};
}

module.exports={check, hold, stockOf, store, save, OUT_STATUS};
